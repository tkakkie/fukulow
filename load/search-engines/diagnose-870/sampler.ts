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

export const streams = {fast: 1_000, thermal: 5_000, process: 10_000} as const;
export type Stream = keyof typeof streams;
export const maxGapMs = 30_000;
export type Sample =
  | {at: number; stream: 'fast'; dirtyBytes: number; writebackBytes: number; cachedBytes: number;
    autovacuum: {pid: number; datname: string | null; query: string}[]; checkpointer: unknown; wal: unknown}
  | {at: number; stream: 'thermal'; temperaturesC: Record<string, number>; frequencyKHz: Record<string, number>}
  | {at: number; stream: 'process'; load: number[]; workers: string[]; containers: string[]}
  | {at: number; stream: Stream; error: string};

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

// Gaps over 30 s in a stream's successful samples across [start, end], counting the last sample before
// the window and the first after it. A stream with no sample before the window has a gap at its start.
export function gaps(samples: Sample[], stream: Stream, start: number, end: number) {
  const times = samples.filter(s => s.stream === stream && ok(s)).map(s => s.at).sort((a, b) => a - b);
  const before = times.filter(t => t <= start).at(-1) ?? -Infinity;
  const after = times.find(t => t >= end) ?? Infinity;
  const points = [before, ...times.filter(t => t > start && t < end), after];
  const found: string[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i] - points[i - 1] > maxGapMs) found.push(`${stream} sampler gap over ${maxGapMs / 1000} s`);
  }
  return [...new Set(found)];
}

const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
// CPU package sensors when present (k10temp on AMD, coretemp on Intel), otherwise every sensor.
const cpuTemperature = (t: Record<string, number>) => {
  const cpu = Object.entries(t).filter(([k]) => /^(k10temp|coretemp)\//.test(k)).map(([, v]) => v);
  const all = cpu.length ? cpu : Object.values(t);
  return all.length ? Math.max(...all) : null;
};

// Validity reasons from the samplers and the environment of one measurement window.
export function windowFacts(samples: Sample[], start: number, end: number, blocks: Block[],
  {thermal, serverCpus}: {thermal: boolean; serverCpus: number[] | null}): {invalid: string[]; env: Environment} {
  const inWindow = samples.filter(s => s.at >= start && s.at <= end && ok(s));
  const invalid = [...gaps(samples, 'fast', start, end), ...gaps(samples, 'process', start, end),
    ...(thermal ? gaps(samples, 'thermal', start, end) : [])];
  for (const s of inWindow) {
    if (s.stream !== 'process' || 'error' in s) continue;
    if (s.workers.length) invalid.push(`worker process during the measurement: ${s.workers[0]}`);
    if (s.containers.length) invalid.push(`other container during the measurement: ${s.containers[0]}`);
  }
  const fast = samples.filter((s): s is Extract<Sample, {stream: 'fast'; dirtyBytes: number}> => s.stream === 'fast' && ok(s));
  const atStart = fast.filter(s => s.at <= start).at(-1);
  const thermals = inWindow.filter((s): s is Extract<Sample, {stream: 'thermal'; temperaturesC: object}> => s.stream === 'thermal');
  const temps = thermals.map(s => cpuTemperature(s.temperaturesC)).filter((t): t is number => t !== null);
  const freqs = thermals.flatMap(s => Object.entries(s.frequencyKHz)
    .filter(([cpu]) => serverCpus === null || serverCpus.includes(Number(cpu))).map(([, f]) => f));
  const autovacuumQueries = blocks.filter(b => fast.some(s => s.at >= b.start && s.at <= b.end &&
    s.autovacuum.some(w => w.datname === 'measured'))).map(b => b.query);
  return {invalid: [...new Set(invalid)], env: {
    dirtyWritebackAtStartBytes: atStart ? atStart.dirtyBytes + atStart.writebackBytes : null,
    meanTemperatureC: mean(temps), meanFrequencyKHz: mean(freqs), autovacuumQueries,
  }};
}

// ---- The sampler process ----

const run = (argv: string[], input?: string) => new Promise<string>((resolve, reject) => {
  const child = spawn(argv[0], argv.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
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
  const sample = async (stream: Stream, read: () => Promise<Omit<Extract<Sample, {stream: typeof stream}>, 'at' | 'stream'>>) => {
    const at = Date.now();
    try { write({at, stream, ...await read()} as Sample); } catch (error) { write({at, stream, error: String(error)}); }
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
  void loop('process', async () => {
    const ps = await run(['ps', '-Ao', 'pid=,command=']);
    const names = (await run(['docker', 'ps', '--format', '{{.Names}}'])).split('\n').map(s => s.trim()).filter(Boolean);
    return {load: loadavg(), workers: otherWorkers(ps, process.pid), containers: names.filter(n => n !== container)};
  });
}

if (import.meta.main) await main();
