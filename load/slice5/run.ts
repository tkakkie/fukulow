// #515 slice 5 runner (approved pre-registration, 2026-11-17).
//   --build [--night N] : daytime only; builds both release images (night N's commits, default nights 1-2) and,
//     when the night includes Part D, the Part D test binaries into --work. An image already labelled with its commit is kept.
//   --night 1|2|3 : the overnight measurement (night 1 = Part A, night 2 = Parts B, C, D, night 3 = Part C rerun).
//   --smoke : tiny settings through the same code; never evidence.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, hostname, platform, release, tmpdir, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { outsideCheckout } from '../proxy-target.ts';
import { dbSettings, fixture, isNight, longBody, nights, partA, partB, partC, partD, rounds, scope as originalScope, thresholds, timelineEnv, requireMergedHarness, type Arm } from './config.ts';
import { appliedSettingsSQL, autovacuumSQL, channelLogSQL, checksumSQL, prefillSQL, relationBytesSQL, relationSizesSQL, settleSQL, watchedRelationsSQL } from './fixture.ts';
import { judgePartA, judgePartB, judgePartC, classifyPartDFailure, closedLoopNonSuccess, confirmedPartDInfrastructure, parseTimeline, scanPartDPostgresLog, timelineTopics, vacuumCost, type Counts, type PostgresState, type RunA, type RunB, type RunC, type RunD, type StepA } from './judge.ts';
import { readResults, scorePartDFiles } from './report.ts';
import { command, dbCommand, docker, seed, send, sampler, sleep, snapshot, startStack, timed, walDump, walWindow, type Seeded, type Stack } from './stack.ts';

const usage = 'node load/slice5/run.ts --work /abs/work (--build [--night 1|2|3] | --night 1|2|3 --out /abs/new/dir) [--smoke] [--parts A,B,C,D] [--storage-candidate <full SHA> with --night 1]';
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help')) { console.log(`${originalScope}\n${usage}`); process.exit(0); }
if (process.version !== 'v26.13.1') throw new Error('Use Node 26.13.1');
const work = outsideCheckout(flag('--work') ?? (() => { throw new Error(usage); })());
const smoke = args.includes('--smoke'), build = args.includes('--build');
const nightFlag = flag('--night');
if (nightFlag !== undefined && !isNight(nightFlag)) throw new Error(usage);
const night = nightFlag as `${keyof typeof nights}` | undefined;
if (!build && night === undefined) throw new Error(usage);
const storageCandidate = flag('--storage-candidate');
if (args.includes('--storage-candidate') && (night !== '1' || !/^[0-9a-f]{40}$/.test(storageCandidate ?? ''))) {
  throw new Error('--storage-candidate requires --night 1 and a full commit SHA');
}
const scope = storageCandidate ? '#620 storage remeasurement using #515 slice 5 Part A conditions' : originalScope;
const originalCommits = nights[night ?? '1'].commits;
const armCommits = storageCandidate ? { B: originalCommits.B, A: storageCandidate } : originalCommits;
const full = Object.fromEntries((['B', 'A'] as Arm[]).map(arm => [arm, command('git', ['rev-parse', `${armCommits[arm]}^{commit}`])])) as Record<Arm, string>;
const tag = (arm: Arm) => `fukulow-slice5:${arm.toLowerCase()}-${full[arm].slice(0, 12)}`;
// Per-commit trees: a reused --work never builds or tests one commit from another commit's extracted source.
const source = (arm: Arm) => `${work}/src-${arm}-${full[arm].slice(0, 12)}`;
const save = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2));
let child: ChildProcess | undefined, childName: string | undefined, interrupted = '';
let deadlineChild: ChildProcess | undefined;
const stop = (why: string) => {
  interrupted ||= why;
  if (child?.kill('SIGTERM') && why === 'hard timeout') deadlineChild = child;
  if (childName) try { docker('rm', '-f', childName); } catch { /* retried */ }
};
process.on('SIGINT', () => stop('interrupted')); process.on('SIGTERM', () => stop('interrupted'));
const check = () => { if (interrupted) throw new Error(interrupted); };
function run(file: string, argv: string[], o: { env?: NodeJS.ProcessEnv; cwd?: string; name?: string; timeoutMs: number }) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; nightDeadline: boolean; stdout: string; stderr: string }>((done, reject) => {
    check();
    const proc = spawn(file, argv, { env: o.env ?? process.env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc; childName = o.name;
    let stdout = '', stderr = '', timedOut = false;
    proc.stdout.on('data', (c: Buffer) => { stdout += c; }); proc.stderr.on('data', (c: Buffer) => { stderr += c; });
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, o.timeoutMs);
    proc.on('error', error => { if (proc.pid === undefined) reject(error); });
    proc.on('exit', () => clearTimeout(timer));
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (child === proc) { child = undefined; childName = undefined; }
      done({ code, signal, timedOut, nightDeadline: deadlineChild === proc, stdout, stderr });
    });
  });
}

function extract(arm: Arm) {
  if (existsSync(source(arm))) return;
  mkdirSync(source(arm), { recursive: true });
  command('git', ['archive', '--format=tar', `--output=${source(arm)}.tar`, full[arm]]);
  command('tar', ['-xf', `${source(arm)}.tar`, '-C', source(arm)]);
}
if (build) {
  mkdirSync(work, { recursive: true });
  for (const arm of ['B', 'A'] as Arm[]) {
    extract(arm);
    const existing = spawnSync('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', tag(arm)], { encoding: 'utf8' });
    const keep = existing.status === 0 && existing.stdout.trim() === full[arm];
    console.log(`slice5: ${keep ? 'keeping' : 'building'} ${arm} ${full[arm]}`);
    if (!keep) {
      const image = await run('docker', ['build', '--label', `org.opencontainers.image.revision=${full[arm]}`, '-t', tag(arm), source(arm)], { timeoutMs: 3600_000 });
      writeFileSync(`${work}/build-${arm}.log`, image.stdout + image.stderr);
      if (image.code !== 0) throw new Error(`image build failed for ${arm}`);
    }
    if (night !== undefined && !(nights[night].parts as readonly string[]).includes('D')) continue;
    // rust-embed needs web/dist to exist; Part D runs one DB test, so an empty one suffices (as in CI lint).
    mkdirSync(`${source(arm)}/web/dist`, { recursive: true });
    const test = await run('cargo', ['test', '--locked', '--release', '-p', 'fukulow-server', '--lib', '--no-run'], { cwd: source(arm), timeoutMs: 3600_000 });
    writeFileSync(`${work}/cargo-${arm}.log`, test.stdout + test.stderr);
    if (test.code !== 0) throw new Error(`Part D test build failed for ${arm}`);
  }
  console.log(`slice5: built ${tag('B')} and ${tag('A')}`);
  process.exit(0);
}

const output = outsideCheckout(flag('--out') ?? (() => { throw new Error(usage); })());
if (existsSync(output)) throw new Error('Output directory already exists');
mkdirSync(`${output}/runs`, { recursive: true });
const config = nights[night!];
const parts = (flag('--parts')?.split(',') ?? config.parts) as string[];
if (!smoke && (flag('--parts') || parts.join() !== config.parts.join())) throw new Error('A formal night runs exactly its pre-registered parts');
function smokeRates() {
  const v = flag('--smoke-rates');
  if (v && !smoke) throw new Error('--smoke-rates is smoke-only');
  return v ? v.split(',').map(Number) : [50];
}
const scratch = mkdtempSync(`${tmpdir()}/slice5-`);
const project = `slice5-${Date.now()}-${randomUUID().slice(0, 8)}`;
const deadline = setTimeout(() => stop('hard timeout'), config.hardTimeoutMinutes * 60_000);
const tiny = { rates: smokeRates(), seconds: 10, perChannel: 25, replay: [20_000, 10_000], requests: 20, warmups: 2, warmupB: 5, secondsB: 10, vusB: 16, topics: '500' };
const plan = {
  rates: smoke ? tiny.rates : [...partA.rates], seconds: smoke ? tiny.seconds : partA.seconds,
  perChannel: smoke ? tiny.perChannel : fixture.perChannel, rounds: smoke ? [rounds[0]] : rounds,
  cellsA: smoke ? [partA.cells[0]] : partA.cells, cellsB: smoke ? [partB.cells[1]] : partB.cells,
  replaySizes: smoke ? tiny.replay : fixture.replayChannels.map(c => c.messages), requests: smoke ? tiny.requests : partC.requests,
  warmups: smoke ? tiny.warmups : partC.warmups, warmupB: smoke ? tiny.warmupB : partB.warmupSeconds,
  secondsB: smoke ? tiny.secondsB : partB.seconds, vusB: smoke ? tiny.vusB : partB.vus, senderSeconds: 60 };
const settingsHash = createHash('sha256').update(JSON.stringify({ plan, dbCommand: dbCommand(), partA, partB, partC, partD, fixture, dbSettings })).digest('hex');
const images: Partial<Record<Arm, string>> = {};
const results: (RunA | RunB | RunC | RunD)[] = [];
const faults: string[] = [], cleanupErrors: string[] = [];
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const k6 = command('make', ['-s', 'load-image']);
const hash16 = (n: number) => createHash('sha256').update(`160/${n}`).digest().readUInt16BE(0);
const bodies = { short: fixture.shortBody, long: longBody(hash16) };

async function withStack<T>(arm: Arm, id: string, limiter: { burst: number; refill: number }, body: (stack: Stack, seeded: Seeded, dir: string, privateDir: string) => Promise<T>) {
  const dir = `${output}/runs/${id}`, privateDir = `${scratch}/${id}`;
  mkdirSync(dir, { recursive: true }); mkdirSync(privateDir, { mode: 0o700 });
  const stack = await startStack({ arm, id, project, source: source(arm), image: images[arm]!, privateDir, ...limiter });
  try {
    const seeded = await seed(stack);
    stack.sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
    save(`${dir}/stack.json`, { arm, commit: full[arm], appImage: docker('inspect', '--format', '{{.Image}}', stack.app), dbImage: docker('inspect', '--format', '{{.Image}}', stack.db),
      composeSha256: sha(`${source(arm)}/load/compose.yml`), deploySha256: Object.fromEntries(['init-db-roles.sh', 'db-roles.sql', 'db-role-settings.sql', 'db-grants.sql'].map(f => [f, sha(`${source(arm)}/deploy/${f}`)])),
      dbSettings: stack.sql("SELECT json_object_agg(name, setting) FROM pg_settings WHERE name IN ('max_wal_size','checkpoint_timeout','autovacuum','shared_buffers','max_connections','synchronous_commit')"),
      started: new Date().toISOString() });
    return await body(stack, seeded, dir, privateDir);
  } finally {
    try { const logs = stack.dc('logs', '--no-color', '--timestamps', 'app'); writeFileSync(`${dir}/app.log`, logs); } catch { cleanupErrors.push(`${id}: logs`); }
    try { stack.down(); } catch { cleanupErrors.push(`${id}: compose cleanup failed`); }
    rmSync(privateDir, { recursive: true, force: true });
  }
}
// Deterministic settled fixture; the checksum is taken before any API send.
function prefill(stack: Stack, arm: Arm, seeded: Seeded, counts: number[]) {
  const t0 = performance.now();
  // Reloptions first, so insert-triggered autovacuum never starts on the prefill itself.
  stack.sql(autovacuumSQL);
  stack.sql(prefillSQL(seeded.organization, seeded.channels, counts));
  stack.sql(channelLogSQL(arm, seeded.organization, seeded.channels.filter((_, i) => counts[i] > 0)));
  // Applied (not intended) settings join the run identity: a setting missing in one arm makes the cell INVALID.
  const applied = stack.sql(appliedSettingsSQL);
  return { checksum: stack.sql(checksumSQL), prefillMs: performance.now() - t0, settings: createHash('sha256').update(settingsHash + applied).digest('hex'), applied };
}
function settle(stack: Stack) { const cost = timed(stack, settleSQL); return { ...cost, watched: JSON.parse(stack.sql(watchedRelationsSQL)) as number[] }; }
const generatorName = () => `${project}-k6-${randomUUID().slice(0, 8)}`;
async function generator(stack: Stack, privateDir: string, script: string, env: Record<string, string>, timeoutMs: number, name: string) {
  const r = await run('docker', ['run', '--rm', '--name', name, '--network', stack.network, '-v', `${resolve('.')}:/work:ro`, '-v', `${privateDir}:/fixture:ro`, '-w', '/work',
    '-e', 'BASE_URL=http://app:8080', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), k6, 'run', '--quiet', script], { env: stack.env, name, timeoutMs });
  const line = r.stdout.split('\n').find(l => l.startsWith('SLICE5_RESULT '));
  const start = Number(/SLICE5_START (\d+)/.exec(r.stdout + r.stderr)?.[1]);
  return { code: r.code ?? 1, log: r.stderr, result: line ? JSON.parse(line.slice(14)) : undefined, start };
}
const counts = (row: Record<string, number | null> | undefined): Counts => ({ attempted: row?.attempted ?? -1, accepted: row?.accepted ?? -1,
  rejected429: row?.rejected429 ?? -1, rejected503: row?.rejected503 ?? -1, otherErrors: row?.otherErrors ?? -1, clientTimeouts: row?.clientTimeouts ?? -1,
  transportErrors: row?.transportErrors ?? -1, droppedIterations: row?.droppedIterations ?? -1, p95: row?.p95 ?? null });

async function partARun(arm: Arm, round: number, cell: typeof partA.cells[number]): Promise<RunA> {
  const id = `A-${cell.name}-${round}-${arm}`;
  return withStack(arm, id, { burst: partA.sendBurst, refill: partA.sendRefillPerSecond }, async (stack, seeded, dir, privateDir) => {
    const { checksum, prefillMs, settings, applied } = prefill(stack, arm, seeded, seeded.channels.map(() => plan.perChannel));
    const body = bodies[cell.body];
    const retry = [];
    for (let i = 0; i < partA.retryTargets; i++) {
      const target = { member: i, channel: seeded.channels[0], client_message_id: randomUUID(), body };
      // SendMessageRequest rejects unknown fields, so send only the request body.
      await send(stack, seeded, i, target.channel, { client_message_id: target.client_message_id, body: target.body }); retry.push(target);
    }
    save(`${privateDir}/data.json`, { organization: seeded.organization, otherOrganization: seeded.otherOrganization, reader: seeded.reader,
      channels: cell.channels === 1 ? [seeded.channels[0]] : seeded.channels, body, retry });
    save(`${privateDir}/tokens.json`, seeded.tokens);
    const settled = settle(stack);
    const storage0 = Number(stack.sql(relationBytesSQL));
    const sizes0 = JSON.parse(stack.sql(relationSizesSQL)) as unknown;
    let gen: string | undefined;
    const samples = sampler(stack, () => gen);
    const steps: StepA[] = [], maintenance: unknown[] = [];
    try {
      for (const [k, rate] of plan.rates.entries()) {
        check();
        // Before every step: VACUUM (ANALYZE), CHECKPOINT, 5 s idle. Its cost belongs to the previous step (Q3).
        const vacuum = timed(stack, 'VACUUM (ANALYZE);'), checkpoint = timed(stack, 'CHECKPOINT;');
        if (k) { steps[k - 1].vacuumAfter = vacuum; steps[k - 1].checkpointAfter = checkpoint; } else maintenance.push({ beforeFirstStep: { vacuum, checkpoint } });
        await sleep(partA.idleSeconds * 1000);
        stack.sql('SELECT pg_stat_statements_reset();');
        const before = snapshot(stack, settled.watched);
        gen = generatorName();
        const r = await generator(stack, privateDir, 'load/slice5/send-k6.ts', { SLICE5_MODE: 'open', SLICE5_RATE: String(rate), SLICE5_SECONDS: String(plan.seconds),
          SLICE5_CHANNELS: String(cell.channels), SLICE5_RETRY_RATE: String(partA.retryRate), SLICE5_DRAIN: String(partA.drainSeconds) }, (plan.seconds + 120) * 1000, gen);
        gen = undefined;
        const after = snapshot(stack, settled.watched);
        writeFileSync(`${dir}/k6-${rate}.log`, r.log);
        if (r.code !== 0 || !r.result || !Number.isFinite(r.start)) throw new Error(`generator failed at ${rate}/s`);
        const wal = walWindow(stack, before, after);
        const dump = walDump(stack, before.lsn, after.lsn, `${dir}/waldump-${rate}.txt`);
        writeFileSync(`${dir}/pg_stat_statements-${rate}.txt`, stack.sql('SELECT calls, round(mean_exec_time::numeric,3), round(total_exec_time::numeric,1), left(query,200) FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 25'));
        const window = samples.window(r.start, r.start + (plan.seconds + partA.drainSeconds) * 1000);
        steps.push({ rate, seconds: plan.seconds, send: counts(r.result.send?.all), retry: counts(r.result.retry?.all), reader: counts(r.result.reader?.all), evidence: window.evidence, wal,
          vacuumAfter: { walBytes: NaN, ms: NaN }, checkpointAfter: { walBytes: NaN, ms: NaN, buffersWritten: NaN },
          ...{ cpu: window.cpu, walDump: dump, lsn: { start: before.lsn, end: after.lsn } } } as StepA);
      }
      const vacuum = timed(stack, 'VACUUM (ANALYZE);'), checkpoint = timed(stack, 'CHECKPOINT;');
      steps.at(-1)!.vacuumAfter = vacuum; steps.at(-1)!.checkpointAfter = checkpoint;
    } finally { await samples.stop(); }
    const result: RunA = { part: 'A', cell: cell.name, round, arm, commit: full[arm], image: images[arm]!, settingsHash: settings, fixtureChecksum: checksum,
      complete: steps.length === plan.rates.length, smoke, steps,
      storage: { bytes: Number(stack.sql(relationBytesSQL)) - storage0, accepted: steps.reduce((s, x) => s + x.send.accepted, 0) } };
    save(`${dir}/result.json`, { ...result, prefillMs, appliedSettings: applied, settle: settled, maintenance });
    // #620 diagnosis: taken after the judged storage reading, so it never changes it.
    save(`${dir}/relation-sizes.json`, { before: sizes0, after: JSON.parse(stack.sql(relationSizesSQL)) as unknown });
    return result;
  });
}

async function partBRun(arm: Arm, round: number, cellName: string): Promise<RunB> {
  const cell = partA.cells.find(c => c.name === cellName)!, id = `B-${cellName}-${round}-${arm}`;
  return withStack(arm, id, { burst: partB.sendBurst, refill: partB.sendRefillPerSecond }, async (stack, seeded, dir, privateDir) => {
    const { checksum, settings } = prefill(stack, arm, seeded, seeded.channels.map(() => plan.perChannel));
    save(`${privateDir}/data.json`, { organization: seeded.organization, otherOrganization: seeded.otherOrganization, reader: seeded.reader,
      channels: cell.channels === 1 ? [seeded.channels[0]] : seeded.channels, body: bodies[cell.body], retry: [] });
    save(`${privateDir}/tokens.json`, seeded.tokens);
    settle(stack); await sleep(partA.idleSeconds * 1000);
    let gen: string | undefined;
    const samples = sampler(stack, () => gen);
    gen = generatorName();
    const r = await generator(stack, privateDir, 'load/slice5/send-k6.ts', { SLICE5_MODE: 'closed', SLICE5_VUS: String(plan.vusB), SLICE5_WARMUP: String(plan.warmupB),
      SLICE5_SECONDS: String(plan.secondsB), SLICE5_CHANNELS: String(cell.channels), SLICE5_DRAIN: '11' }, (plan.warmupB + plan.secondsB + 120) * 1000, gen).finally(() => samples.stop());
    gen = undefined;
    writeFileSync(`${dir}/k6.log`, r.log);
    if (r.code !== 0 || !r.result || !Number.isFinite(r.start)) throw new Error('generator failed');
    const window = samples.window(r.start + plan.warmupB * 1000, r.start + (plan.warmupB + plan.secondsB) * 1000);
    const lane = r.result.send as Record<string, Record<string, number>>;
    // A missing window is missing evidence, never zero errors.
    const nonSuccess = closedLoopNonSuccess(r.result);
    const result: RunB = { part: 'B', cell: cellName, round, arm, commit: full[arm], image: images[arm]!, settingsHash: settings, fixtureChecksum: checksum, complete: true, smoke,
      acceptedPerSecond: lane.measured.accepted / plan.secondsB, measured: counts(lane.measured), nonSuccess,
      hostCpuMeanPercent: window.cpu.vmMean, evidence: window.evidence };
    save(`${dir}/result.json`, { ...result, cpu: window.cpu, windows: lane, reader: r.result.reader });
    return result;
  });
}

async function partCRun(arm: Arm, round: number): Promise<RunC[]> {
  const out: RunC[] = [];
  for (const cellName of partC.cells) {
    const id = `C-${cellName}-${round}-${arm}`;
    const cell = await withStack(arm, id, { burst: partA.sendBurst, refill: partA.sendRefillPerSecond }, async (stack, seeded, dir, privateDir) => {
      const sizes = seeded.channels.map((_, i) => plan.replaySizes[i] ?? 0);
      const { checksum, settings } = prefill(stack, arm, seeded, sizes);
      settle(stack);
      save(`${privateDir}/tokens.json`, seeded.tokens);
      let generation: string | null = null;
      if (arm === 'A') {
        const r = await fetch(`${stack.base}/api/v1/orgs/${seeded.organization}/channels/${seeded.channels[0]}/events?after_seq=0&limit=1`, { headers: { Authorization: `Bearer ${seeded.tokens[0]}` } });
        if (r.status !== 200) throw new Error('history_generation lookup failed');
        generation = (await r.json() as { history_generation: string }).history_generation;
      }
      check();
      const [size, depth] = cellName.split('-'), index = size === '1M' ? 0 : 1;
      save(`${privateDir}/data.json`, { organization: seeded.organization, otherOrganization: seeded.otherOrganization, reader: seeded.reader,
        channel: seeded.channels[index], size: plan.replaySizes[index], generation });
      timed(stack, 'VACUUM (ANALYZE);'); timed(stack, 'CHECKPOINT;'); await sleep(partA.idleSeconds * 1000);
      let gen: string | undefined;
      const samples = sampler(stack, () => gen);
      gen = generatorName();
      const r = await generator(stack, privateDir, 'load/slice5/replay-k6.ts', { SLICE5_ARM: arm, SLICE5_DEPTH: depth, SLICE5_READERS: String(partC.readers),
        SLICE5_WARMUPS: String(plan.warmups), SLICE5_REQUESTS: String(plan.requests), SLICE5_LIMIT: String(partC.limit), SLICE5_RECENT_WINDOW: String(partC.recentWindow),
        SLICE5_SENDER_RATE: String(partC.senderRate), SLICE5_SENDER_SECONDS: String(plan.senderSeconds) }, (plan.senderSeconds + 120) * 1000, gen).finally(() => samples.stop());
      gen = undefined;
      writeFileSync(`${dir}/k6-${cellName}.log`, r.log);
      if (r.code !== 0 || !r.result || !Number.isFinite(r.start)) throw new Error(`generator failed for ${cellName}`);
      const window = samples.window(r.start, r.start + plan.senderSeconds * 1000);
      const res = r.result;
      const run: RunC = { part: 'C', cell: cellName, round, arm, commit: full[arm], image: images[arm]!, settingsHash: settings, fixtureChecksum: checksum, complete: true, smoke,
        p95: res.p95, requests: res.pages, invalidPages: res.invalidPages, outsideSender: res.outsideSender, readerErrors: res.readerErrors,
        sender: counts(res.sender), senderRate: partC.senderRate, senderSeconds: plan.senderSeconds, evidence: window.evidence };
      // R2 (Q4, report-only): WebSocket replay of a 50-position gap, after and never alongside the judged R1.
      const ws = await generator(stack, privateDir, 'load/slice5/replay-ws-k6.ts', { SLICE5_ARM: arm, SLICE5_LIMIT: String(partC.limit),
        SLICE5_READERS: String(partC.readers), SLICE5_WS_ITERATIONS: String(smoke ? 3 : partC.wsIterations) }, 240_000, generatorName());
      writeFileSync(`${dir}/k6-r2-${cellName}.log`, ws.log);
      run.r2 = ws.code === 0 && ws.result ? { status: 'REPORT ONLY', ...ws.result } : { status: 'NOT EVALUATED' };
      save(`${dir}/result-${cellName}.json`, { ...run, p50: res.p50, max: res.max, other: res.other, cpu: window.cpu, outsideSender: res.outsideSender,
        r2: ws.code === 0 && ws.result ? { status: 'REPORT ONLY', ...ws.result } : { status: 'NOT EVALUATED', reason: 'R2 generator failed' } });
      return run;
    });
    out.push(cell);
  }
  return out;
}

function partDPostgresState(name: string): PostgresState | null {
  try {
    const format = '[{{json .State.Running}},{{json .State.OOMKilled}},{{json .State.ExitCode}},{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}]';
    const [Running, OOMKilled, ExitCode, Health] = JSON.parse(docker('inspect', '--format', format, name));
    if (typeof Running === 'boolean' && typeof OOMKilled === 'boolean' && Number.isInteger(ExitCode)
      && (Health === null || ['starting', 'healthy', 'unhealthy', 'none'].includes(Health))) {
      return { Running, OOMKilled, ExitCode, Health };
    }
  } catch { /* Inspect can fail before Docker has created the container. */ }
  return null;
}

function writePartDArtifact(marker: string, write: () => void) {
  try { write(); } catch {
    const error = `${marker}: artifact write failed`;
    cleanupErrors.push(error);
    console.error(`slice5: ${error}`);
  }
}

async function partDRun(arm: Arm, round: number, rerun: boolean): Promise<RunD> {
  const id = `D-${round}-${arm}${rerun ? '-rerun' : ''}`, dir = `${output}/runs/${id}`;
  writePartDArtifact(`${id}/`, () => mkdirSync(dir, { recursive: true }));
  const name = `${project}-d-${round}-${arm}`.toLowerCase(), password = randomUUID();
  const result: RunD = { part: 'D', round, arm, commit: full[arm], complete: false, smoke, topics: NaN, rows: [], exitCode: null, failure: null };
  let cargo: Awaited<ReturnType<typeof run>> | undefined;
  let stage = 'PostgreSQL image lookup';
  try {
    const pg = /image: (postgres:[^\s]+)/.exec(readFileSync(`${source(arm)}/load/compose.yml`, 'utf8'))?.[1];
    if (!pg) throw new Error('missing pinned PostgreSQL');
    stage = 'PostgreSQL docker run';
    try { docker('rm', '-f', name); } catch { /* The name is normally absent. */ }
    // Keep an exited container available for inspect, then remove it explicitly.
    docker('run', '-d', '--name', name, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '--tmpfs', '/var/lib/postgresql', pg, ...dbCommand().slice(1));
    // TCP readiness twice in a row: the image's init-phase server answers on the socket only.
    stage = 'PostgreSQL readiness';
    let ready = 0;
    for (let i = 0; i < 90 && ready < 2; i++) {
      check();
      ready = docker('exec', name, 'sh', '-c', 'pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && echo ok || echo no') === 'ok' ? ready + 1 : 0;
      await sleep(1000);
    }
    if (ready < 2) throw new Error('PostgreSQL not ready');
    stage = 'PostgreSQL port lookup';
    const port = docker('port', name, '5432/tcp').split(':').at(-1);
    stage = 'Cargo launch';
    cargo = await run('cargo', ['test', '--locked', '--release', '-p', 'fukulow-server', '--lib', partD.target, '--', '--ignored', '--nocapture'], { cwd: source(arm),
      env: { ...timelineEnv(process.env, smoke ? tiny.topics : undefined), DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${port}/postgres` }, timeoutMs: 30 * 60_000 });
  } catch {
    result.failure = { cause: interrupted === 'hard timeout' ? 'timeout' : interrupted ? 'unknown' : 'infrastructure',
      exitCode: null, signal: null, timedOut: false, evidence: [interrupted === 'hard timeout' ? 'night-deadline' : interrupted || `${stage} failed`] };
  }

  try {
    result.postgres = partDPostgresState(name);
    // Docker forwards PostgreSQL's stdout and stderr separately.
    const pgLog = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    result.postgresLogMarkers = scanPartDPostgresLog(pgLog.status === 0 && !pgLog.error ? `${pgLog.stdout}\n${pgLog.stderr}` : null);
    result.failure?.evidence.push(...result.postgresLogMarkers);
    let log: string | undefined;
    if (cargo) {
      log = `${cargo.stderr}\n${cargo.stdout}`.replaceAll(password, '<redacted>');
      result.exitCode = cargo.code;
      result.failure = classifyPartDFailure({ exitCode: cargo.code, signal: cargo.signal, timedOut: cargo.timedOut, nightDeadline: cargo.nightDeadline },
        log, result.postgres, result.postgresLogMarkers);
      result.topics = timelineTopics(log);
      result.rows = parseTimeline(log);
      result.complete = result.rows.length === 4;
    }
    writePartDArtifact(`${id}/result.json`, () => save(`${dir}/result.json`, result));
    if (log !== undefined) {
      const cargoLog = log;
      writePartDArtifact(`${id}/cargo.log`, () => writeFileSync(`${dir}/cargo.log`, cargoLog));
    }
    return result;
  } finally {
    try { docker('rm', '-f', name); } catch (error) {
      if (!/\bNo such container\b/i.test(String((error as { stderr?: string })?.stderr ?? '')))
        cleanupErrors.push(`${id}: PostgreSQL cleanup failed`);
    }
  }
}

// Part D reports classified faults. Parts A–C retain their thrown-run retry policy.
const rerunUsed = new Set<string>();
async function attempt<T>(part: string, id: string, f: (rerun: boolean) => Promise<T>, infrastructure?: (result: T) => string | undefined): Promise<T | undefined> {
  let rerun = false;
  for (;;) {
    let result: T | undefined, reason: string;
    try {
      check();
      result = await f(rerun);
      const fault = infrastructure?.(result);
      if (!fault) return result;
      reason = fault;
    } catch (error) {
      if (infrastructure && !interrupted) throw error;
      // UUIDs (passwords, tokens) and hex secrets never reach artifacts.
      reason = (error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : 'unknown')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').replace(/[0-9a-f]{32,}/gi, '<hex>');
    }
    faults.push(`${id}: ${reason}`); console.error(`slice5: ${id} failed (${reason})`);
    if (interrupted || rerunUsed.has(part)) return result;
    rerunUsed.add(part); faults.push(`${id}: rerun (the part's single infrastructure rerun)`);
    rerun = true;
  }
}

function attemptPartD(arm: Arm, round: number) {
  return attempt('D', `D-${round}-${arm}`, rerun => partDRun(arm, round, rerun),
    r => r.failure && confirmedPartDInfrastructure(r) ? `infrastructure (${r.failure.evidence.join(', ')})` : undefined);
}

let failed = false;
try {
  requireMergedHarness(smoke, smoke || command('git', ['merge-base', 'HEAD', 'origin/main']) === command('git', ['rev-parse', 'HEAD']));
  for (const arm of ['B', 'A'] as Arm[]) {
    extract(arm);
    const label = docker('image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', tag(arm));
    if (label !== full[arm]) throw new Error(`image ${tag(arm)} is not ${full[arm]}; run --build first`);
    images[arm] = docker('image', 'inspect', '--format', '{{.Id}}', tag(arm));
  }
  docker('pull', k6);
  const harness = ['config.ts', 'judge.ts', 'fixture.ts', 'stack.ts', 'send-k6.ts', 'replay-k6.ts', 'replay-ws-k6.ts', 'run.ts', 'report.ts'].map(f => `load/slice5/${f}`).concat(['load/channel-log.ts', 'load/channel-log.sql']);
  save(`${output}/metadata.json`, { scope, night, smoke, parts, storageCandidate, commits: full, images, k6, k6Id: docker('image', 'inspect', '--format', '{{.Id}}', k6), plan, settingsHash,
    thresholds, dbCommand: dbCommand(), node: process.version, machine: { platform: platform(), arch: arch(), release: release(), hostname: hostname(), cpus: cpus().length, memory: totalmem() },
    docker: JSON.parse(docker('info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory":{{json .MemTotal}}}')),
    harnessCommit: command('git', ['rev-parse', 'HEAD']), dirty: command('git', ['status', '--porcelain', '--untracked-files=no']) + command('git', ['status', '--porcelain', '--', 'load']),
    harnessHashes: Object.fromEntries(harness.filter(existsSync).map(p => [p, sha(p)])), started: new Date().toISOString() });
  for (const part of parts) {
    for (const [i, pair] of plan.rounds.entries()) for (const arm of pair) {
      const round = i + 1;
      if (part === 'A') for (const cell of plan.cellsA) { const r = await attempt('A', `A-${cell.name}-${round}-${arm}`, () => partARun(arm, round, cell)); if (r) results.push(r); }
      if (part === 'B') for (const cell of plan.cellsB) { const r = await attempt('B', `B-${cell}-${round}-${arm}`, () => partBRun(arm, round, cell)); if (r) results.push(r); }
      if (part === 'C') { const r = await attempt('C', `C-${round}-${arm}`, () => partCRun(arm, round)); if (r) results.push(...r); }
      if (part === 'D') { const r = await attemptPartD(arm, round); if (r) results.push(r); }
      const saveResults = () => save(`${output}/results.json`, results);
      if (part === 'D') writePartDArtifact('results.json', saveResults);
      else saveResults();
    }
  }
} catch (error) {
  failed = true;
  // Child errors may carry seed SQL or credentials: never serialize them.
  console.error(`slice5: runner failed (${interrupted || 'details suppressed'})`);
} finally {
  clearTimeout(deadline);
  rmSync(scratch, { recursive: true, force: true });
  const runs = <T>(p: string) => results.filter(r => r.part === p) as T[];
  const scoredD = parts.includes('D') ? scorePartDFiles(output, readResults(output), plan.rounds) : undefined;
  const verdicts = [
    ...plan.cellsA.map(c => judgePartA(runs<RunA>('A'), c.name)), ...plan.cellsA.map(c => vacuumCost(runs<RunA>('A'), c.name)),
    ...plan.cellsB.map(c => judgePartB(runs<RunB>('B'), c)), ...partC.cells.map(c => judgePartC(runs<RunC>('C'), c, armCommits)),
    ...(scoredD?.verdicts ?? []),
  ].filter(v => parts.includes((v as { part?: string }).part ?? 'A'));
  failed ||= scoredD?.failed ?? false;
  const saveSummary = () => save(`${output}/summary.json`, { scope, night, smoke, failed, interrupted, faults, cleanupErrors, verdicts, finished: new Date().toISOString() });
  if (parts.includes('D')) writePartDArtifact('summary.json', saveSummary);
  else saveSummary();
  console.log(`slice5: artifacts ${output}`);
  // Exit explicitly: a leaked timer must never hold the overnight waiter.
  process.exit(failed || interrupted || cleanupErrors.length ? 1 : 0);
}
