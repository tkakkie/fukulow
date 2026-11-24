import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cpuList, parseCpuSets, type CpuSets } from '../../harness-core/cpusets.ts';
import { benchmark, boundedCommand, command, CommandTimeoutError, docker, save, sql } from '../bench.ts';
import { resolveImage } from '../manifest.ts';
import { ownedContainer, ownedVolume, ownershipLabel, refuseLeftovers, supervise, timeouts } from '../runtime.ts';
import { literal } from '../seed.ts';
import { accepts, completeness } from '../d3r/acceptance.ts';
import { explainPage, prepare } from '../d3r/engine.ts';
import { dfBytes, dockerDiskArgs } from '../d3r/headroom.ts';
import { argumentsForPostgres, loadManifest } from '../d3r/manifest.ts';
import { productionPath } from '../d3r/path.ts';
import { outputPath, recordedWarmup } from '../d3r/run.ts';
import { verifyRls } from '../d3r/rls.ts';
import { loadBackfill } from '../d3r/snapshot.ts';
import { timeQuery } from '../d3r/timing.ts';
import { checkPins, diagnosticSettings, expectedSnapshotSha256, launchArgs, pinnedBenchmark, pinnedSession, planShape, qualifiedCpuSets } from './cluster.ts';
import { cacheConstraint, fillPlans, ownReasons, smoke, stage1, stage2, type Block, type Measurement, type Noise, type Plan } from './judge.ts';
import { execute, settleWait, startDiskProblems, type Deps } from './orchestrate.ts';
import { ownedResources } from '../runtime.ts';
import { ordered, sequence, type MeasuredStep, type Stage } from './plan.ts';
import { awaitCoverage, freshFast, freshWaitMs, readSamples, stopProcess, windowFacts, type Restart } from './sampler.ts';

// #870 diagnostic driver (design rev 2, approved 2026-11-24). One launch runs one stage once on the
// verified #689 snapshot; nothing reruns. Its records are diagnosis only and never #689 evidence.
// It starts only through the launcher (#867), which holds HOST-BUSY, checks the idle host and records the go.

export const label = 'DIAGNOSTIC #870 / NOT #689 EVIDENCE';
// A stage that is not a normal finish (a STOP, a minimum not met, incomplete evidence, a failed smoke) keeps
// its records, writes stopped.json and no completed.json, and exits 2, so the supervisor marks the run
// invalid and the launcher ends the queue (launcher.ts: a non-zero exit is a STOP, no rerun).
export const stopExitCode = 2;
const note = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const readIf = (file: string) => existsSync(file) ? readJson(file) : null;

// The diagnosis runs only on the #796-qualified Linux host (§3.1), and every stage needs its own go.
export function options(argv: string[], os = platform()) {
  const {values} = parseArgs({args: argv, options: {stage: {type: 'string'}, 'from-backfill': {type: 'string'},
    out: {type: 'string'}, 'cpu-sets': {type: 'string'}, 'stage1-out': {type: 'string'}, 'smoke-out': {type: 'string'},
    qualification: {type: 'string'}, approval: {type: 'string'}}});
  const stage = values.stage as Stage;
  assert.ok(['smoke', '1', '2'].includes(stage), '--stage must be smoke, 1 or 2');
  assert.ok(values['from-backfill'] && values.out, '--from-backfill and --out are required');
  assert.ok(values.approval, '--approval is required: the maintainer\'s go for this stage (smoke, Stage 1 and Stage 2 each need their own)');
  assert.ok(stage !== '1' || values['smoke-out'], 'Stage 1 needs --smoke-out (a passed smoke, §3.4)');
  assert.ok(stage !== '2' || values['stage1-out'], 'Stage 2 needs --stage1-out (its N comes from Stage 1)');
  assert.equal(os, 'linux', 'The #870 diagnosis runs only on the #796-qualified Linux host (§3.1)');
  assert.ok(values['cpu-sets'] && values.qualification, 'The #796 CPU sets and --qualification are required (§3.1)');
  return {stage, from: resolve(values['from-backfill']), out: values.out, cpuSets: values['cpu-sets']!,
    stage1Out: values['stage1-out'] && resolve(values['stage1-out']), smokeOut: values['smoke-out'] && resolve(values['smoke-out']),
    qualification: resolve(values.qualification), approval: resolve(values.approval)};
}

// The maintainer's go for one stage (design rev 2 §3.4, §5.3, §8: each stage needs its own go). The record
// names issue 870, the stage, the launcher job it was given for, the quoted go and its date. It is checked
// against the stage and the job being started, and must not predate the earlier stage it builds on.
export type Approval = {issue: 870; stage: Stage; job: string; quote: string; date: string};
export function approvalFor(file: string, stage: Stage, job: string | undefined, notBefore: string | null) {
  const a = readIf(file) as Partial<Approval> | null;
  assert.ok(a && a.issue === 870, `${file} is not an #870 approval record`);
  assert.equal(a.stage, stage, `The approval is for stage ${a.stage}, not ${stage}: each stage needs its own go`);
  assert.ok(typeof a.quote === 'string' && a.quote.trim().length > 0, 'The approval has no quoted go');
  assert.ok(typeof a.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date) && !Number.isNaN(Date.parse(a.date)), 'The approval has no valid date (YYYY-MM-DD)');
  assert.ok(job !== undefined && a.job === job, `The approval is for job ${a.job}, not ${job}`);
  assert.ok(notBefore === null || a.date >= notBefore, `The approval (${a.date}) predates the earlier stage it needs (${notBefore})`);
  return a as Approval;
}

// A finished earlier stage of this diagnosis: finalized by the supervisor (finished.json, and run-status.json
// valid with cleanup verified), swept afterwards with nothing left (leftover-cleanup.json verified), a normal
// finish (finish.json), approved for that stage, under this manifest, same CPU sets. The worker's
// completed.json alone is not enough: it is written before teardown.
function finishedStage(dir: string, stage: Stage, manifestHash: string, cpuSets: string, logicalCpus: number) {
  const name = stage === 'smoke' ? 'smoke' : `Stage ${stage}`;
  const finished = readIf(`${dir}/finished.json`), status = readIf(`${dir}/run-status.json`);
  assert.ok(finished && status?.valid === true && status.cleanupVerified === true && status.manifestHash === manifestHash,
    `${dir} is not a finalized, valid ${name} run (finished.json and a valid run-status.json are required)`);
  assert.ok(readIf(`${dir}/leftover-cleanup.json`)?.verified === true,
    `${dir} is not a finalized, valid ${name} run (the leftover sweep did not verify a clean host)`);
  const judgement = readJson(`${dir}/judgement.json`), metadata = readJson(`${dir}/metadata.json`);
  assert.ok(finished.manifestHash === manifestHash && finished.stage === stage && judgement.stage === stage && judgement.stopped === null,
    `${dir} is not a finished ${name} of this manifest`);
  assert.ok(!existsSync(`${dir}/stopped.json`), `${dir} stopped`);
  assert.ok(readIf(`${dir}/finish.json`)?.normal === true && Array.isArray(judgement.abnormal) && judgement.abnormal.length === 0,
    `${dir} is not a normal finish of the ${name}`);
  assert.equal(readIf(`${dir}/approval.json`)?.stage, stage, `${dir} has no recorded go for the ${name}`);
  assert.equal(JSON.stringify(metadata.cpuSets ?? null), JSON.stringify(parseCpuSets(cpuSets, logicalCpus)), `${dir} ran on other CPU sets`);
  assert.ok(typeof finished.at === 'string', `${dir} has no finish time`);
  return {judgement, finishedOn: (finished.at as string).slice(0, 10)};
}

// Stage 2 pre-validation (§5.3, review item 5): Stage 1's recorded N, its source and its outcome must be
// what its own measurements give. N must come from the C replicates: a fallback N exists only when the
// H1 minimum was not met, and such a Stage 1 is not a normal finish (review item 2), so it never reaches
// here; a Stage 2 on a fallback N needs a re-plan (§5.2 "Inconclusive": a Stage 2 or re-plan proposal).
function stage1Noise(dir: string, judgement: {outcome: string; noise: Noise}) {
  const ms = (readJson(`${dir}/measurements.json`) as {measurements: Measurement[]}).measurements;
  const again = stage1(ms, null);
  assert.equal(judgement.outcome, again.outcome, `Stage 1's recorded outcome ${judgement.outcome} is not what its measurements give (${again.outcome})`);
  assert.ok(judgement.noise?.source === again.noise.source && judgement.noise.value === again.noise.value,
    'Stage 1\'s recorded N is not what its measurements give');
  assert.ok(judgement.noise.source === 'C hot1/hot2' && Number.isFinite(judgement.noise.value) && judgement.noise.value >= 1.05,
    'Stage 2 needs N from both Stage 1 cache replicates (C hot1/hot2, >= 1.05); a fallback N needs a re-plan');
  return judgement.noise;
}

// The HOST-BUSY the launcher claimed for this queue names this job (the launcher passes both). This stops an
// accidental direct run, which has neither variable. It cannot stop a deliberate bypass: whatever the driver
// can check locally can be written locally. Starting through the launcher (preflight, recorded go) is an
// operator rule (maintainer decision on PR #871, extra round sol 1).
function launchedJob(env: NodeJS.ProcessEnv) {
  const file = env.FUKULOW_HOST_BUSY, job = env.FUKULOW_LAUNCH_JOB;
  if (!file || !job || !existsSync(file)) return false;
  const m = /^[^:]+: (.+) \S+$/.exec(readFileSync(file, 'utf8').split('\n')[0] ?? '');
  return m !== null && m[1].split(', ').includes(job);
}

// §3 prerequisites and the stage's go, all checked before anything touches Docker or a database. Each
// missing one is a STOP before start.
export function prerequisites(args: ReturnType<typeof options>, manifestHash: string, env = process.env, logicalCpus = cpus().length) {
  // §3.2: the launcher holds HOST-BUSY for this queue and this job (it also ran the preflight and logged the go).
  assert.ok(launchedJob(env), 'Start through the launcher: HOST-BUSY is not held for this job');
  const [given, fixed] = [args.cpuSets, qualifiedCpuSets].map(t => parseCpuSets(t, logicalCpus));
  assert.ok(cpuList(given.server) === cpuList(fixed.server) && cpuList(given.client) === cpuList(fixed.client),
    `CPU sets must be the #796 sets ${qualifiedCpuSets}`);
  // §3.1: the #796 qualification record, PASS, on these sets.
  const q = readIf(args.qualification);
  assert.ok(q?.issue === 796 && q.result === 'PASS' && q.cpuSets === qualifiedCpuSets, 'The #796 qualification is not recorded as PASS on the #796 CPU sets');
  // §3.4: a passed smoke before Stage 1; §5.3: a finished Stage 1 before Stage 2.
  const prior = args.stage === '1' ? finishedStage(args.smokeOut!, 'smoke', manifestHash, args.cpuSets, logicalCpus)
    : args.stage === '2' ? finishedStage(args.stage1Out!, '1', manifestHash, args.cpuSets, logicalCpus) : null;
  if (args.stage === '1') assert.equal(prior!.judgement.outcome, 'smoke passed', 'The smoke did not pass');
  const approval = approvalFor(args.approval, args.stage, env.FUKULOW_LAUNCH_JOB, prior?.finishedOn ?? null);
  if (args.stage !== '2') return {stage1Noise: null, approval};
  assert.ok(stage1Outcomes.includes(prior!.judgement.outcome), `Stage 1 has no recognized outcome: ${prior!.judgement.outcome}`);
  return {stage1Noise: stage1Noise(args.stage1Out!, prior!.judgement), approval};
}
const stage1Outcomes = ['not reproduced', 'cause established', 'cause not established', 'inconclusive'];

const freeAt = (path: string) => { const s = statfsSync(path, {bigint: true}); return Number(s.bavail * s.bsize); };
const freeOrNull = (path: string) => { try { return freeAt(path); } catch { return null; } };

async function worker(env: NodeJS.ProcessEnv) {
  const stage = env.DIAG870_STAGE as Stage;
  const out = env.DIAG870_OUT!;
  const sets: CpuSets | undefined = env.DIAG870_CPU_SETS ? parseCpuSets(env.DIAG870_CPU_SETS, cpus().length) : undefined;
  const {frozen, sha256} = loadManifest();
  const {querySet, transactions, clients, warmupSweeps, rows, restoreRows} = frozen.performance;
  const container = ownedContainer(), volume = ownedVolume();
  assert.ok(container && volume, 'Missing supervised Docker resources');
  const owner = (db: string, text: string) => sql(container, db, text);

  // Prerequisites (§3): snapshot identity and disk, before anything starts.
  const source = await loadBackfill(env.DIAG870_FROM!, sha256, rows, restoreRows);
  assert.equal(source.receipt.snapshot.sha256, expectedSnapshotSha256, 'Not the verified #689 snapshot');
  try { resolveImage(docker, frozen.image, true); } catch (error) {
    if (error instanceof CommandTimeoutError) throw error;
    docker('pull', frozen.image);
  }
  const {id} = resolveImage(docker, frozen.image, true);
  const dockerFree = () => { try { return dfBytes(docker(...dockerDiskArgs(id, ownershipLabel))).free; } catch { return null; } };
  // Docker storage, and the host filesystems of the snapshot tar and of the output (§3.3).
  const startFree = {docker: dockerFree(), snapshot: freeOrNull(source.snapshotDirectory), output: freeOrNull(out)};
  const diskProblems = startDiskProblems(startFree);
  save(`${out}/disk-preflight.json`, {...startFree, problems: diskProblems, unit: 'bytes; thresholds in decimal GB'});
  assert.deepEqual(diskProblems, [], `disk preflight (§3.3): ${diskProblems.join('; ')}`);

  // Start the restored cluster (as the #689 formal run, plus diagnostic logging and the CPU pin).
  const launch = launchArgs(source.snapshotDirectory, sets?.server);
  docker('volume', 'create', '--label', ownershipLabel, volume);
  command('docker', ['run', '-d', '--label', ownershipLabel, '--name', container, '--network=none',
    `--shm-size=${frozen.shmBytes}`, '--mount', `type=volume,source=${volume},target=/var/lib/postgresql`,
    ...launch.options, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=postgres',
    id, ...launch.args, ...argumentsForPostgres, ...diagnosticSettings], undefined, {...process.env, POSTGRES_PASSWORD: randomUUID()});
  boundedCommand('docker', ['exec', container, 'sh', '-ec', 'until test -e /tmp/backfill-extracted; do sleep 1; done'], timeouts.psql);
  const ready = async () => {
    for (let i = 0; i < frozen.timing.startupAttempts; i++) {
      try {
        docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'fukulow', '-d', 'postgres');
        if (owner('postgres', 'SELECT NOT pg_is_in_recovery();') === 't') return;
      } catch (error) { if (error instanceof CommandTimeoutError) throw error; }
      await new Promise(r => setTimeout(r, frozen.timing.startupPollMs));
    }
    throw new Error('PostgreSQL startup timed out');
  };
  await ready();
  assert.equal(owner('postgres', 'SHOW server_version_num;'), '180006');
  assert.deepEqual(JSON.parse(owner('postgres', `SELECT json_object_agg(name,setting) FROM pg_settings
    WHERE name IN (${Object.keys(frozen.settings).map(literal).join(',')});`)), frozen.settings);
  assert.equal(owner('postgres', 'SHOW log_autovacuum_min_duration;'), '0');
  assert.equal(owner('postgres', 'SELECT system_identifier FROM pg_control_system();'), source.receipt.snapshot.systemIdentifier);
  assert.deepEqual(verifyRls(text => sql(container, 'base', text, 'fukulow_app'), frozen.sessionPolicy.appSettings), source.receipt.rls);
  const pins = sets ? checkPins(container, sets) : null;
  const path = productionPath();
  save(`${out}/metadata.json`, {label, stage, manifestHash: sha256, image: {reference: frozen.image, id}, node: process.version,
    source: command('git', ['rev-parse', 'HEAD']), worktreeStatus: command('git', ['status', '--porcelain']),
    snapshot: source.receipt.snapshot, cpuSets: sets ?? null, pins, diagnosticSettings, platform: platform(),
    steps: sequence(stage), cacheConstraint, qualification: env.DIAG870_QUALIFICATION || null,
    approval: readJson(`${out}/approval.json`), hostBusy: env.FUKULOW_HOST_BUSY ?? null});

  // Samplers in their own process (§1). They are stopped on every path: before the judgement on a normal
  // path, in finally on an error, and on a signal to this worker. The supervisor's SIGKILL of this worker's
  // process group also reaches the sampler, and the IPC channel ends it if this worker dies otherwise.
  const samplesFile = `${out}/samples.jsonl`;
  const thermal = platform() === 'linux';
  const sampler = spawn(process.execPath, [fileURLToPath(new URL('./sampler.ts', import.meta.url)), '--out', samplesFile,
    '--container', container, ...(sets ? ['--client-cpus', cpuList(sets.client)] : []), ...(thermal ? ['--thermal'] : [])],
  {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
  const time = sets ? pinnedBenchmark(sets.client) : benchmark;
  const windows = new Map<string, {start: number; end: number; blocks: Block[]; restart: Restart | null; checked: boolean}>();
  let previous: {id: string; end: number} | null = null;
  let lastRestart: Restart | null = null;
  const app = <T>(body: (search: (text: string) => Promise<string>) => Promise<T>) => pinnedSession(container, 'measured', true, sets?.client, body);
  // After a restart, wait (up to 30 s) for a fast sample from the restarted server, so the next window's
  // start environment is not read from before the restart. The gap across the restart is checked with the
  // window: over 30 s, or no fresh sample, makes the round INVALID (review item 3).
  const restart = async () => {
    const at = Date.now();
    docker('restart', container);
    await ready();
    const t = Date.now();
    while (!freshFast(readSamples(samplesFile), t) && Date.now() - t < freshWaitMs) await new Promise(r => setTimeout(r, 250));
    lastRestart = {at, fresh: freshFast(readSamples(samplesFile), t)};
  };
  const reads = () => Number(owner('postgres', "SELECT pg_stat_clear_snapshot(); SELECT blks_read FROM pg_stat_database WHERE datname = 'measured';").split('\n').at(-1));
  const stats = () => JSON.parse(owner('measured', `SELECT json_build_object(
    'io', (SELECT json_agg(row_to_json(i)) FROM pg_stat_io i WHERE reads > 0 OR hits > 0),
    'tables', (SELECT json_agg(row_to_json(t)) FROM pg_stat_user_tables t WHERE relname IN ('messages', 'message_search_terms')),
    'reltuples', (SELECT json_object_agg(relname, reltuples) FROM pg_class WHERE relname IN ('messages', 'message_search_terms')),
    'pg_stats', (SELECT json_agg(json_build_object('table', tablename, 'column', attname, 'null_frac', null_frac, 'avg_width', avg_width,
      'n_distinct', n_distinct, 'correlation', correlation)) FROM pg_stats WHERE schemaname = 'public' AND tablename IN ('messages', 'message_search_terms')),
    'checkpointer', (SELECT row_to_json(c) FROM pg_stat_checkpointer c), 'wal', (SELECT row_to_json(w) FROM pg_stat_wal w));`));
  // A piece of evidence that could not be read or saved is recorded as missing, never left out silently.
  const capture = <T>(what: string, missing: string[], read: () => T): T | null => {
    try { return read(); } catch (error) { missing.push(`${what}: ${String(error)}`); return null; }
  };

  const deps: Deps = {
    freeBytes: () => ({docker: dockerFree(), snapshot: freeOrNull(source.snapshotDirectory), output: freeOrNull(out)}),
    copy: async () => { owner('postgres', 'DROP DATABASE IF EXISTS measured;'); owner('postgres', 'CREATE DATABASE measured TEMPLATE base;'); },
    // Every command gets the time left before the cap; passing the cap, or a command timing out at it, is
    // false (that round is INVALID), never a STOP. The rule itself is settleWait (tested with a fake clock).
    settle: async capMs => {
      const deadline = Date.now() + capMs;
      const left = () => Math.max(1, deadline - Date.now());
      const owned = (text: string) => boundedCommand('docker', ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
        '-U', 'fukulow', '-d', 'postgres'], left(), text).trim();
      try {
        return await settleWait({
          checkpoint: () => { owned('CHECKPOINT;'); },
          reading: () => {
            const mem = boundedCommand('docker', ['exec', container, 'cat', '/proc/meminfo'], Math.min(left(), timeouts.docker));
            // An unreadable field is NaN, which never settles: the wait runs to its cap (INVALID), not a STOP.
            const kib = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB$`, 'm').exec(mem)?.[1] ?? NaN) * 1024;
            return {dirtyWritebackBytes: kib('Dirty') + kib('Writeback'),
              autovacuumWorkers: Number(owned("SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker';"))};
          },
          now: () => Date.now(),
          sleep: ms => new Promise(r => setTimeout(r, ms)),
        }, capMs);
      } catch (error) {
        if (error instanceof CommandTimeoutError && Date.now() >= deadline) return false;
        throw error;
      }
    },
    restart,
    warmup: async step => {
      mkdirSync(`${out}/${step.id}`, {recursive: true});
      await recordedWarmup(`${out}/${step.id}/warmup.json`, path.page, ordered(querySet, step.order), warmupSweeps, app);
    },
    measure: async (step: MeasuredStep, opts) => {
      const dest = `${out}/${step.id}`;
      mkdirSync(dest, {recursive: true});
      const missing: string[] = [];
      const restartBefore = step.kind === 'hot' ? null : lastRestart;
      lastRestart = null;
      const before = capture('stats-before', missing, stats);
      if (before !== null) save(`${dest}/stats-before.json`, before);
      const load15 = loadavg()[2];
      const readsBefore = capture('blks_read before', missing, reads);
      const blocks: Block[] = [];
      const results: Parameters<typeof ownReasons>[0] = [];
      const start = Date.now();
      // The actual interval since the previous measurement ended (decision 1: "at once" allows the statistics
      // reads, the read-counter wait and the sampler check, and the interval is recorded).
      const sincePrevious = previous && {id: previous.id, endedAt: previous.end, ms: start - previous.end};
      for (const [query, raw] of ordered(querySet, step.order)) {
        const b = Date.now();
        try {
          const sample = await timeQuery(container, 'measured', path.page, query, raw, !accepts(query), `${dest}/${query}`, transactions, clients, time);
          results.push({query, sample});
          save(`${dest}/${query}.json`, sample);
        } catch (error) {
          results.push({query, error: String(error)});
        }
        blocks.push({query, start: b, end: Date.now()});
      }
      const end = Date.now();
      await new Promise(r => setTimeout(r, 1_000));
      const readsAfter = capture('blks_read after', missing, reads);
      const sharedReads = readsBefore === null || readsAfter === null || !Number.isFinite(readsAfter - readsBefore) ? null : readsAfter - readsBefore;
      const plans = opts.explain ? await explainAll(dest, missing) : null;
      const after = capture('stats-after', missing, stats);
      if (after !== null) save(`${dest}/stats-after.json`, after);
      windows.set(step.id, {start, end, blocks, restart: restartBefore, checked: false});
      const latencies = results.map(r => 'error' in r ? {query: r.query, error: r.error}
        : 'p95' in r.sample ? {query: r.query, p95: r.sample.p95} : {query: r.query, error: r.sample.sqlError});
      const m: Measurement = {id: step.id, kind: step.kind, arm: step.arm, order: step.order, settle: step.kind === 'copy' && step.settle,
        latencies, plans, sharedReads, invalid: ownReasons(results, load15), missingEvidence: missing,
        env: {dirtyWritebackAtStartBytes: null, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: []}};
      // Option A: hot 2's EXPLAIN sweep stands for warm, hot 1 and hot 2 of its cache arm.
      const plansStandFor = step.kind === 'hot' && step.id.endsWith('.hot2') ? ['warm', 'hot1', 'hot2'].map(x => `${step.arm}.${x}`) : undefined;
      save(`${dest}/measurement.json`, {...m, window: {start, end, blocks}, restart: restartBefore, sincePrevious, plansStandFor, load15});
      previous = {id: step.id, end};
      note(`${step.id} measured${missing.length ? ` (missing evidence: ${missing.join('; ')})` : ''}`);
      return m;
    },
    validate: async ms => {
      for (const m of ms) {
        const w = windows.get(m.id);
        if (!w || w.checked) continue;
        const {samples, reached} = await awaitCoverage(() => readSamples(samplesFile), w.end, thermal, {now: () => Date.now(),
          sleep: ms => new Promise(r => setTimeout(r, ms)), alive: () => sampler.exitCode === null && sampler.signalCode === null});
        const facts = windowFacts(samples, w.start, w.end, w.blocks, {thermal, serverCpus: sets?.server ?? null, restart: w.restart});
        if (!reached) facts.invalid.push('sampler coverage not reached by the deadline');
        m.invalid.push(...facts.invalid.filter(r => !m.invalid.includes(r)));
        m.env = facts.env;
        w.checked = true;
      }
    },
    idle: ms => new Promise(r => setTimeout(r, ms)),
    // A scan that could not page through every result did not do the §5.3 work: a STOP.
    scan: async () => {
      const report = await app(async search => { await search(prepare(path.page)); return completeness(search); });
      save(`${out}/B.scan.json`, report);
      const broken = report.flatMap(q => q.actors.filter(a => a.paginationError).map(a => `${q.query}/${a.actor}`));
      if (broken.length) throw new Error(`completeness scan pagination errors: ${broken.join(', ')}`);
    },
    log: note,
  };
  // EXPLAIN (ANALYZE, BUFFERS) for every accepted query. A failed query or session keeps the measurement, and
  // every accepted query without a plan gets an error entry, so the list is never partial: H3 is withheld and
  // the evidence is incomplete (review item 4).
  const explainAll = async (dest: string, missing: string[]) => {
    const accepted = querySet.filter(([q]) => accepts(q));
    const list: Plan[] = [];
    try {
      await app(async search => {
        await search(prepare(path.page));
        for (const [query, raw] of accepted) {
          try {
            const {explain} = await explainPage(search, raw);
            save(`${dest}/${query}-plan.json`, explain);
            list.push({query, ...planShape(explain)});
          } catch (error) { list.push({query, error: String(error)}); missing.push(`EXPLAIN ${query}: ${String(error)}`); }
        }
      });
    } catch (error) { missing.push(`EXPLAIN session: ${String(error)}`); }
    return fillPlans(accepted.map(([q]) => q), list, 'EXPLAIN session failed before this query');
  };

  let samplerStopped: Promise<{verified: boolean; how: string}> | null = null;
  const stopSampler = () => samplerStopped ??= stopProcess(sampler).then(r => { save(`${out}/sampler-stop.json`, r); return r; });
  const onSignal = (signal: NodeJS.Signals, code: number) => process.once(signal, () => {
    sampler.kill('SIGKILL');
    note(`${signal}: sampler killed; the stage ends`);
    process.exit(code);
  });
  onSignal('SIGTERM', 143); onSignal('SIGINT', 130);
  let logTried = false;
  try {
    const result = await execute(sequence(stage), deps);
    save(`${out}/measurements.json`, result);
    // Every record is complete before the judgement (review item 4): the samples (sampler stopped), and the
    // PostgreSQL log. A missing one is incomplete evidence, never a judgement on part of the evidence.
    const stageMissing: string[] = [];
    const stopped = await stopSampler();
    if (!stopped.verified) stageMissing.push(`sampler: ${stopped.how}`);
    logTried = true;
    const logMissing = postgresLog(container, out);
    if (logMissing) stageMissing.push(logMissing);
    const judgement = stage === '1' ? stage1(result.measurements, result.stopped, stageMissing)
      : stage === '2' ? stage2(result.measurements, JSON.parse(env.DIAG870_STAGE1_NOISE!) as Noise, result.stopped, stageMissing)
      : smoke(result.measurements, result.stopped, stageMissing);
    save(`${out}/judgement.json`, {label, stage, stopped: result.stopped, cacheConstraint, ...judgement});
    note(`judgement: ${JSON.stringify('outcome' in judgement ? judgement.outcome : judgement.result)}`);
    process.exitCode = finishRecords(out, stage, sha256, result.stopped, judgement.abnormal);
  } finally {
    const r = await stopSampler();
    if (!r.verified) { note(`sampler did not exit: ${r.how}`); process.exitCode ||= stopExitCode; }
    if (!logTried) postgresLog(container, out);
  }
}

// finish.json always; a normal finish writes completed.json (exit 0), anything else stopped.json with its
// reasons and no completed.json (exit 2), so the supervisor marks the run invalid and the queue ends.
export function finishRecords(out: string, stage: Stage, manifestHash: string, stopped: string | null, abnormal: string[]) {
  const at = new Date().toISOString();
  save(`${out}/finish.json`, {normal: abnormal.length === 0, reasons: abnormal});
  if (abnormal.length === 0) {
    save(`${out}/completed.json`, {manifestHash, label, stage, at});
    return 0;
  }
  save(`${out}/stopped.json`, {label, stage, stopped, reasons: abnormal, at});
  note(`not a normal finish: ${abnormal.join('; ')}`);
  return stopExitCode;
}

// The PostgreSQL log, both streams (it logs to stderr). Returns null when saved, else what is missing.
function postgresLog(container: string, out: string) {
  try {
    const logs = spawnSync('docker', ['logs', container], {encoding: 'utf8', timeout: timeouts.docker, maxBuffer: 1024 ** 3});
    const text = `${logs.stdout ?? ''}${logs.stderr ?? ''}`;
    writeFileSync(`${out}/postgres.log`, text);
    if (logs.error || logs.status !== 0) return `postgres log: docker logs ${logs.error ? String(logs.error) : `exited ${logs.status}`}`;
    if (text.trim() === '') return 'postgres log: empty';
    return null;
  } catch (error) { return `postgres log not saved: ${String(error)}`; }
}

async function main() {
  if (process.env.SEARCH_WORKER === '1') { await worker(process.env); return; }
  const args = options(process.argv.slice(2));
  const {sha256} = loadManifest();
  // Everything in §3 and the stage's go, before any Docker or database work.
  const {stage1Noise, approval} = prerequisites(args, sha256);
  const out = outputPath(args.out);
  refuseLeftovers(docker);
  mkdirSync(out, {mode: 0o700});
  save(`${out}/approval.json`, approval);
  Object.assign(process.env, {DIAG870_STAGE: args.stage, DIAG870_OUT: out, DIAG870_FROM: args.from,
    DIAG870_CPU_SETS: args.cpuSets ?? '', DIAG870_STAGE1_NOISE: stage1Noise === null ? '' : JSON.stringify(stage1Noise),
    DIAG870_QUALIFICATION: args.qualification ?? ''});
  // The supervisor runs this file as the worker, owns the container and volume, and always removes them.
  await supervise(import.meta.url, out, sha256, () => note(`${label}: stage ${args.stage} finished (${out})`));
  sweepLeftovers(out);
  if (process.exitCode === 0 || process.exitCode === undefined) return;
  note(`${label}: stage ${args.stage} did not finish normally (see ${out}/stopped.json or the log); the queue ends`);
}

if (import.meta.main) await main();

// After the supervisor: any harness-labelled resource still present is this run's (refuseLeftovers found
// none at start), such as a throwaway disk probe interrupted mid-run. It is removed and recorded; if the
// listing, a removal or the check afterwards fails, the run is not valid and the queue ends.
export function sweepLeftovers(out: string, d: (...args: string[]) => string = docker) {
  let found: {kind: string; name: string}[] = [];
  const failures: string[] = [];
  try { found = ownedResources(d); } catch (error) { failures.push(`listing failed: ${String(error)}`); }
  for (const r of found) {
    try { d(...(r.kind === 'container' ? ['rm', '-fv', r.name] : ['volume', 'rm', '-f', r.name])); } catch (error) { failures.push(`${r.kind} ${r.name}: ${String(error)}`); }
  }
  try {
    const remain = ownedResources(d);
    if (remain.length) failures.push(`still present: ${remain.map(r => `${r.kind} ${r.name}`).join(', ')}`);
  } catch (error) { failures.push(`verification failed: ${String(error)}`); }
  save(`${out}/leftover-cleanup.json`, {verified: !failures.length, found, failures});
  if (!failures.length) return true;
  const statusFile = `${out}/run-status.json`;
  const status = existsSync(statusFile) ? readJson(statusFile) : {};
  writeFileSync(statusFile, JSON.stringify({...status, valid: false, cleanupVerified: false,
    exitCode: status.exitCode ? status.exitCode : 1, leftoverFailures: failures}) + '\n');
  rmSync(`${out}/finished.json`, {force: true});
  note(`${label}: harness cleanup failed (${failures.join('; ')}); the run is not valid`);
  if (!process.exitCode) process.exitCode = 1;
  return false;
}
