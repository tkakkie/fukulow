import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { workers as launcherWorkers } from '../../launcher/launcher.ts';
import type { Block, Environment } from './judge.ts';

// The #870 samplers (design rev 2, §1), run as their own process so the worker's synchronous SQL calls
// cannot stall them. Each line of the JSONL file is one sample; a failed reading is recorded with its
// error and counts as missing. Validity and the per-measurement environment are read back by the pure
// functions below, which the tests exercise.

// process (ps and load average) and containers (docker ps) share one 10 s loop, but each observation
// carries its own times: `at` when its command started and `done` when it returned. What a command saw
// could be from any moment between the two.
export const streams = {fast: 1_000, thermal: 5_000, process: 10_000, containers: 10_000} as const;
export type Stream = keyof typeof streams;
export const maxGapMs = 30_000;
type Times = {at: number; done?: number};
export type Sample = Times & (
  | {stream: 'fast'; dirtyBytes: number; writebackBytes: number; cachedBytes: number;
    autovacuum: {pid: number; datname: string | null; query: string}[]; checkpointer: unknown; wal: unknown}
  | {stream: 'thermal'; temperaturesC: Record<string, number>; frequencyKHz: Record<string, number>}
  | {stream: 'process'; load: number[]; workers: string[]; processes: string[]}
  | {stream: 'containers'; containers: string[]}
  | {stream: Stream; error: string});

const ok = (s: Sample) => !('error' in s);
export const marker = 'search-engines/diagnose-870/';

export function parseMeminfo(text: string) {
  const kib = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text);
    if (!m) throw new Error(`meminfo has no ${key}`);
    return Number(m[1]) * 1024;
  };
  return {dirtyBytes: kib('Dirty'), writebackBytes: kib('Writeback'), cachedBytes: kib('Cached')};
}

// The launcher's worker pattern, without this diagnostic's own worker and sampler processes.
export const otherWorkers = (ps: string, self: number) => launcherWorkers(ps, self).filter(line => !line.includes(marker));

export function readSamples(file: string): Sample[] {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Sample]; } catch { return []; } });
}

// Gaps over 30 s in a stream across [start, end]. Each successful observation read at some moment in its
// interval [at, done], so the gap between two observations is taken at its widest: from the earlier one's
// `at` to the later one's `done`. The chain runs from the last observation started at or before `start`
// to the first started at or after `end` (the one `covered` waits for). A failed reading covers nothing,
// so it is part of a gap. A stream with no observation before the window has a gap at its start.
export function gaps(samples: Sample[], stream: Stream, start: number, end: number, where = '') {
  const obs = samples.filter(s => s.stream === stream && ok(s)).map(s => ({at: s.at, done: s.done ?? s.at})).sort((a, b) => a.at - b.at);
  const before = obs.filter(o => o.at <= start).at(-1) ?? {at: -Infinity, done: -Infinity};
  const after = obs.find(o => o.at >= end) ?? {at: Infinity, done: Infinity};
  const chain = [before, ...obs.filter(o => o.at > start && o.at < end), after];
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].done - chain[i - 1].at > maxGapMs) return [`${stream} sampler gap over ${maxGapMs / 1000} s${where}`];
  }
  return [];
}

const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
// CPU package sensors when present (k10temp on AMD, coretemp on Intel), otherwise every sensor.
const cpuTemperature = (t: Record<string, number>) => {
  const cpu = Object.entries(t).filter(([k]) => /^(k10temp|coretemp)\//.test(k)).map(([, v]) => v);
  const all = cpu.length ? cpu : Object.values(t);
  return all.length ? Math.max(...all) : null;
};

// Streams this run samples (thermal only on Linux).
export const sampled = (thermal: boolean): Stream[] => thermal ? ['fast', 'process', 'containers', 'thermal'] : ['fast', 'process', 'containers'];
// A window is covered once every sampled stream has a successful observation at or after its end, so its
// trailing gap is known (a failed reading is missing, as in gaps). Past the deadline a stream without one
// has a gap (a stalled or failing sampler).
export const coverageDeadlineMs = maxGapMs + 15_000;
export function covered(samples: Sample[], end: number, thermal: boolean, now: number) {
  return now >= end + coverageDeadlineMs || sampled(thermal).every(stream => samples.some(s => s.stream === stream && ok(s) && s.at >= end));
}

// A successful fast sample taken at or after `t`. After a restart, the next window waits for one, so its
// leading gap and its start environment come from the restarted server, not from before the restart.
export const freshFast = (samples: Sample[], t: number) => samples.some(s => s.stream === 'fast' && ok(s) && s.at >= t);
export const freshWaitMs = maxGapMs;
// The restart before a window: when `docker restart` started, and whether a fresh fast sample came within
// freshWaitMs of the server being ready. The gap across it is checked on its own (review item 3).
export type Restart = {at: number; fresh: boolean};

// Waits until the window is covered, and stops at once when the sampler process is gone (a STOP: no later
// window could be covered). The wait is bounded from the call, whatever the window end says (an end in the
// future or a clock step); `reached` is false at that bound.
export async function awaitCoverage(read: () => Sample[], end: number, thermal: boolean,
  io: {now(): number; sleep(ms: number): Promise<void>; alive(): boolean}, pollMs = 500) {
  const deadline = io.now() + coverageDeadlineMs + 5_000;
  for (;;) {
    const samples = read();
    if (covered(samples, end, thermal, io.now())) return {samples, reached: true};
    if (!io.alive()) throw new Error('the sampler process exited');
    if (io.now() >= deadline) return {samples, reached: false};
    await io.sleep(pollMs);
  }
}

// Stops a child and everything it started: SIGTERM, a bounded wait, then SIGKILL and a second bounded wait.
// `verified` is true only when the child's exit was observed and `groupAlive` reports none of its process
// group left (an in-flight sampler command does not outlive it).
export type Stoppable = {exitCode: number | null; signalCode: string | null; kill(signal: NodeJS.Signals): boolean};
export async function stopProcess(child: Stoppable, termMs = 15_000, killMs = 5_000, groupAlive: () => boolean = () => false) {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const done = () => exited() && !groupAlive();
  const wait = (ms: number) => new Promise<boolean>(resolve => {
    const until = Date.now() + ms;
    const poll = () => done() ? resolve(true) : Date.now() >= until ? resolve(false) : setTimeout(poll, Math.min(25, ms));
    poll();
  });
  if (done()) return {verified: true, how: 'already exited'};
  child.kill('SIGTERM');
  if (await wait(termMs)) return {verified: true, how: 'SIGTERM'};
  child.kill('SIGKILL');
  if (await wait(killMs)) return {verified: true, how: 'SIGKILL'};
  return {verified: false, how: exited() ? 'its process group outlived SIGKILL' : 'did not exit after SIGKILL'};
}

// An observation's interval [at, done] overlaps the window. A worker or container seen in an observation
// that overlaps the window counts against it: when it was seen within that interval is unknown, so the
// measurement is not accepted as clean.
const overlaps = (s: Sample, start: number, end: number) => s.at <= end && (s.done ?? s.at) >= start;

// Validity reasons from the samplers and the environment of one measurement window.
// With a restart, the samplers must also be continuous from the restart to the window (no gap over 30 s
// across it), and a fresh fast sample must have come after it.
export function windowFacts(samples: Sample[], start: number, end: number, blocks: Block[],
  {thermal, serverCpus, restart = null}: {thermal: boolean; serverCpus: number[] | null; restart?: Restart | null}): {invalid: string[]; env: Environment} {
  const inWindow = samples.filter(s => s.at >= start && s.at <= end && ok(s));
  const invalid = sampled(thermal).flatMap(stream => gaps(samples, stream, start, end));
  if (restart) {
    invalid.push(...sampled(thermal).flatMap(stream => gaps(samples, stream, restart.at, start, ' across the restart')));
    if (!restart.fresh) invalid.push(`no fresh fast sample within ${freshWaitMs / 1000} s after the restart`);
  }
  for (const s of samples.filter(x => ok(x) && overlaps(x, start, end))) {
    if ('error' in s) continue;
    if (s.stream === 'process' && s.workers.length) invalid.push(`worker process during the measurement: ${s.workers[0]}`);
    if (s.stream === 'containers' && s.containers.length) invalid.push(`other container during the measurement: ${s.containers[0]}`);
  }
  const fast = samples.filter((s): s is Extract<Sample, {stream: 'fast'; dirtyBytes: number}> => s.stream === 'fast' && ok(s));
  const atStart = fast.filter(s => s.at <= start).at(-1);
  const thermals = inWindow.filter((s): s is Extract<Sample, {stream: 'thermal'; temperaturesC: object}> => s.stream === 'thermal');
  const temps = thermals.map(s => cpuTemperature(s.temperaturesC)).filter((t): t is number => t !== null);
  // Frequency counts only from samples that read every server CPU; with no server set it is not used.
  const freqs = serverCpus === null ? [] : thermals.filter(s => serverCpus.every(c => Number.isFinite(s.frequencyKHz[String(c)])))
    .flatMap(s => serverCpus.map(c => s.frequencyKHz[String(c)]));
  // When in [at, done] a reading saw the worker is unknown, so a reading that only overlaps a block keeps
  // H5 from being ruled out for it, and only a reading wholly inside the block counts as support.
  const onMeasured = fast.filter(s => s.autovacuum.some(w => w.datname === 'measured'));
  const autovacuumQueries = blocks.filter(b => onMeasured.some(s => overlaps(s, b.start, b.end))).map(b => b.query);
  const autovacuumInsideQueries = blocks.filter(b => onMeasured.some(s => s.at >= b.start && (s.done ?? s.at) <= b.end)).map(b => b.query);
  return {invalid: [...new Set(invalid)], env: {
    dirtyWritebackAtStartBytes: atStart ? atStart.dirtyBytes + atStart.writebackBytes : null,
    meanTemperatureC: mean(temps), meanFrequencyKHz: mean(freqs), autovacuumQueries, autovacuumInsideQueries,
  }};
}

// ---- The sampler process ----

// Children in flight, killed when the sampler stops so no docker exec outlives it.
const children = new Set<ReturnType<typeof spawn>>();
const run = (argv: string[], input?: string) => new Promise<string>((resolve, reject) => {
  const child = spawn(argv[0], argv.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
  children.add(child);
  child.on('exit', () => children.delete(child));
  let out = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  child.stdout.on('data', d => { out += String(d); });
  child.stderr.resume();
  child.on('error', reject);
  child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${argv[0]} exited ${code}`)); });
  child.stdin.on('error', () => undefined);
  child.stdin.end(input ?? '');
});

const activitySql = `SELECT json_build_object(
  'autovacuum', coalesce((SELECT json_agg(json_build_object('pid', pid, 'datname', datname, 'query', query))
    FROM pg_stat_activity WHERE backend_type = 'autovacuum worker'), '[]'::json),
  'checkpointer', (SELECT row_to_json(c) FROM pg_stat_checkpointer c),
  'wal', (SELECT row_to_json(w) FROM pg_stat_wal w));`;

function readSys(dir: string, pick: (name: string) => string | null) {
  const out: Record<string, number> = {};
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const file = pick(e);
    if (!file) continue;
    try { const v = Number(readFileSync(join(dir, e, file), 'utf8').trim()); if (Number.isFinite(v)) out[e] = v; } catch { /* missing */ }
  }
  return out;
}
function thermalSample() {
  const temperaturesC: Record<string, number> = {};
  for (const h of (() => { try { return readdirSync('/sys/class/hwmon'); } catch { return []; } })()) {
    let name = h;
    try { name = readFileSync(join('/sys/class/hwmon', h, 'name'), 'utf8').trim(); } catch { /* unnamed */ }
    let files: string[] = [];
    try { files = readdirSync(join('/sys/class/hwmon', h)).filter(f => /^temp\d+_input$/.test(f)); } catch { /* none */ }
    for (const f of files) {
      try { temperaturesC[`${name}/${f.replace('_input', '')}`] = Number(readFileSync(join('/sys/class/hwmon', h, f), 'utf8').trim()) / 1000; } catch { /* gone */ }
    }
  }
  const frequencyKHz = Object.fromEntries(Object.entries(readSys('/sys/devices/system/cpu',
    e => /^cpu\d+$/.test(e) ? 'cpufreq/scaling_cur_freq' : null)).map(([cpu, f]) => [cpu.slice(3), f]));
  if (Object.keys(temperaturesC).length === 0 || Object.keys(frequencyKHz).length === 0) throw new Error('no hwmon or cpufreq readings');
  return {temperaturesC, frequencyKHz};
}

async function main() {
  const {values} = parseArgs({options: {out: {type: 'string'}, container: {type: 'string'}, 'client-cpus': {type: 'string'},
    thermal: {type: 'boolean', default: false}}});
  const out = values.out!, container = values.container!;
  const pin = values['client-cpus'] ? ['taskset', '-c', values['client-cpus']] : [];
  const write = (s: Sample) => appendFileSync(out, JSON.stringify(s) + '\n');
  const sample = async (stream: Stream, read: () => Promise<Omit<Extract<Sample, {stream: typeof stream}>, 'at' | 'done' | 'stream'>>) => {
    const at = Date.now();
    try { const r = await read(); write({at, done: Date.now(), stream, ...r} as Sample); }
    catch (error) { write({at, done: Date.now(), stream, error: String(error)}); }
  };
  const loop = async (stream: Stream, read: Parameters<typeof sample>[1]) => {
    for (;;) {
      const t = Date.now();
      await sample(stream, read);
      await new Promise(r => setTimeout(r, Math.max(0, streams[stream] - (Date.now() - t))));
    }
  };
  void loop('fast', async () => {
    const text = await run(['docker', 'exec', '-i', container, ...pin, 'sh', '-c',
      'cat /proc/meminfo; echo ---; exec psql -XqAt -v ON_ERROR_STOP=1 -U fukulow -d postgres'], activitySql);
    const [mem, json] = text.split('\n---\n');
    const activity = JSON.parse(json.trim());
    return {...parseMeminfo(mem), autovacuum: activity.autovacuum, checkpointer: activity.checkpointer, wal: activity.wal};
  });
  if (values.thermal) void loop('thermal', async () => thermalSample());
  void (async () => {
    for (;;) {
      const t = Date.now();
      await sample('process', async () => {
        const ps = await run(['ps', '-Ao', 'pid=,pcpu=,command=']);
        const lines = ps.split('\n').map(l => l.trim()).filter(Boolean);
        // The worker pattern reads pid and command; pcpu stays in the persisted process list.
        const commands = lines.map(l => l.replace(/^(\d+)\s+\S+\s+/, '$1 ')).join('\n');
        return {load: loadavg(), workers: otherWorkers(commands, process.pid), processes: lines};
      });
      await sample('containers', async () => {
        const names = (await run(['docker', 'ps', '--format', '{{.Names}}'])).split('\n').map(s => s.trim()).filter(Boolean);
        return {containers: names.filter(n => n !== container)};
      });
      await new Promise(r => setTimeout(r, Math.max(0, streams.process - (Date.now() - t))));
    }
  })();
  // Stop with the worker: on SIGTERM, and when the IPC channel to the worker closes (the worker exited
  // or crashed without its finally).
  const stop = () => { for (const c of children) c.kill('SIGKILL'); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
}

if (import.meta.main) await main();
