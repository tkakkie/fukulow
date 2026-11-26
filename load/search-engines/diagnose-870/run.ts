import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sets796 } from '../../harness-core/frequency-layout.ts';
import { parseHostBusy } from '../../launcher/host-busy.ts';
import { CommandTimeoutError, save } from '../bench.ts';
import { resolveImage } from '../manifest.ts';
import { ownershipLabel, refuseLeftovers, timeouts } from '../runtime.ts';
import { literal } from '../seed.ts';
import { accepts, completeness } from '../d3r/acceptance.ts';
import { explainPage, prepare } from '../d3r/engine.ts';
import { dfBytes, dockerDiskArgs } from '../d3r/headroom.ts';
import { loadManifest } from '../d3r/manifest.ts';
import { productionPath } from '../d3r/path.ts';
import { outputPath, recordedWarmup } from '../d3r/run.ts';
import { verifyRls } from '../d3r/rls.ts';
import { loadBackfill } from '../d3r/snapshot.ts';
import { timeQuery } from '../d3r/timing.ts';
import { planShape } from './cluster.ts';
import { readHostGate } from './host-gate.ts';
import { diagnosticCluster, diagnosticSettings, expectedSnapshotSha256, postgresDataDir, resourceNames } from './placement.ts';
import { qualificationFor } from './qualification.ts';
import { dockerStartMarker, superviseStage } from './supervisor.ts';
import { gatedIo, rawIo, type Io } from './io.ts';
import { cacheConstraint, fillPlans, noiseSpreads, ownReasons, smoke, stage1, stage2, type Block, type Measurement, type Noise, type Plan, type Stage1N } from './judge.ts';
import { abortableIdle, execute, settleWait, startDiskProblems, type Deps } from './orchestrate.ts';
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
// A limited Stage 1 (INVALID measurements or a minimum not met, no STOP, complete evidence): not a normal
// finish, so the queue still ends, but distinct from a STOP (maintainer decision on PR #871, question 2).
export const limitedExitCode = 3;
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
// against the stage and the job being started. `at` is when the go was given, an ISO 8601 timestamp with its
// offset; it must not precede the finish timestamp of the earlier stage it builds on (not only its day).
// A Stage 2 after a limited Stage 1 also needs `acceptsLimitedStage1`: the Stage 1 outcome and shortfall the
// go accepts, exactly as Stage 1 recorded them.
export type Approval = {issue: 870; stage: Stage; job: string; quote: string; at: string;
  acceptsLimitedStage1?: {outcome: string; shortfall: string[]}};
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export function approvalFor(file: string, stage: Stage, job: string | undefined, notBefore: string | null,
  limitedStage1: {outcome: string; shortfall: string[]} | null = null) {
  const a = readIf(file) as Partial<Approval> | null;
  assert.ok(a, `${file} is not an #870 approval record`);
  assert.ok(!Object.values(a).some(value => typeof value === 'string' && value.trim().toLowerCase() === 'pending'),
    'The go is still a pending placeholder');
  assert.equal(a.issue, 870, `${file} is not an #870 approval record`);
  assert.equal(a.stage, stage, `The approval is for stage ${a.stage}, not ${stage}: each stage needs its own go`);
  assert.ok(typeof a.quote === 'string' && a.quote.trim().length > 0, 'The approval has no quoted go');
  assert.ok(typeof a.at === 'string' && isoInstant.test(a.at) && !Number.isNaN(Date.parse(a.at)), 'The approval has no valid time (ISO 8601 with offset, e.g. 2026-11-26T09:30+09:00)');
  assert.ok(job !== undefined && a.job === job, `The approval is for job ${a.job}, not ${job}`);
  assert.ok(notBefore === null || Date.parse(a.at) >= Date.parse(notBefore), `The approval (${a.at}) predates the finish of the earlier stage it needs (${notBefore})`);
  if (limitedStage1) assert.equal(JSON.stringify(a.acceptsLimitedStage1 ?? null), JSON.stringify(limitedStage1),
    'Stage 1 was a limited finish: the Stage 2 go must name it (acceptsLimitedStage1 with its outcome and shortfall as recorded)');
  return a as Approval;
}

// A finished earlier stage of this diagnosis: finalized by the supervisor (finished.json, and run-status.json
// valid with cleanup verified), with nothing left (leftover-cleanup.json verified), a normal
// finish (finish.json), approved for that stage, under this manifest, same CPU sets. The worker's
// completed.json alone is not enough: it is written before teardown.
// A limited Stage 1 (allowLimited, Stage 2 only) is accepted instead when the supervisor recorded its exit as
// limitedExitCode with cleanup verified, and the worker wrote limited.json and finish.json kind "limited";
// a STOP (stopped.json) never is.
function finishedStage(dir: string, stage: Stage, manifestHash: string, allowLimited = false) {
  const name = stage === 'smoke' ? 'smoke' : `Stage ${stage}`;
  const finished = readIf(`${dir}/finished.json`), status = readIf(`${dir}/run-status.json`);
  const finish = readIf(`${dir}/finish.json`), limitedRecord = readIf(`${dir}/limited.json`);
  const limited = allowLimited && !finished && finish?.kind === 'limited' && limitedRecord !== null;
  assert.ok(status?.cleanupVerified === true && status.manifestHash === manifestHash &&
    (limited ? status.valid === false && status.exitCode === limitedExitCode : finished && status.valid === true),
    `${dir} is not a finalized, valid ${name} run (finished.json and a valid run-status.json are required)`);
  assert.ok(readIf(`${dir}/leftover-cleanup.json`)?.verified === true,
    `${dir} is not a finalized, valid ${name} run (the leftover sweep did not verify a clean host)`);
  const judgement = readJson(`${dir}/judgement.json`), metadata = readJson(`${dir}/metadata.json`);
  const record = limited ? limitedRecord : finished;
  assert.ok((limited || finished.manifestHash === manifestHash) && record.stage === stage && judgement.stage === stage && judgement.stopped === null,
    `${dir} is not a finished ${name} of this manifest`);
  assert.ok(!existsSync(`${dir}/stopped.json`), `${dir} stopped`);
  assert.ok(Array.isArray(judgement.abnormal) && (limited
    ? finish.normal === false && judgement.finish?.kind === 'limited' && judgement.abnormal.length > 0
    : finish?.normal === true && judgement.abnormal.length === 0), `${dir} is not a normal finish of the ${name}`);
  assert.equal(readIf(`${dir}/approval.json`)?.stage, stage, `${dir} has no recorded go for the ${name}`);
  assert.deepEqual(metadata.cpuSets, sets796, `${dir} ran on other CPU sets`);
  assert.ok(typeof record.at === 'string', `${dir} has no finish time`);
  assert.ok(!Number.isNaN(Date.parse(record.at)), `${dir} has no valid finish time`);
  return {judgement, finishedAt: record.at as string, limited};
}

// Stage 2 pre-validation (§5.3, review item 5): Stage 1's recorded outcome, finish, N and its source must be
// what its own measurements give. A normal Stage 1 has N from the C replicates. A limited Stage 1 (maintainer
// decision on PR #871, question 2) may give the A1 fallback N; its evidence must be complete and N computable
// (an exact spread from valid rounds), else Stage 2 is refused.
type Stage1Record = {outcome: string; noise: Noise; abnormal: string[]; evidence?: {complete: boolean}; finish?: {kind: string; shortfall: string[]}};
function stage1Noise(dir: string, judgement: Stage1Record, limited: boolean): Stage1N {
  const ms = (readJson(`${dir}/measurements.json`) as {measurements: Measurement[]}).measurements;
  const again = stage1(ms, null);
  assert.equal(judgement.outcome, again.outcome, `Stage 1's recorded outcome ${judgement.outcome} is not what its measurements give (${again.outcome})`);
  assert.ok(judgement.noise?.source === again.noise.source && judgement.noise.value === again.noise.value,
    'Stage 1\'s recorded N is not what its measurements give');
  assert.equal(JSON.stringify(judgement.abnormal), JSON.stringify(again.abnormal), 'Stage 1\'s recorded shortfall is not what its measurements give');
  assert.ok(judgement.evidence?.complete === true && again.evidence.complete, 'Stage 1\'s evidence is incomplete: unusable for Stage 2');
  assert.equal(again.finish.kind, limited ? 'limited' : 'normal', `Stage 1's measurements give a ${again.finish.kind} finish`);
  // The go is matched against the recomputed finish, so the recorded finish must be exactly that (sol review of
  // the re-approval fix): a record whose finish disagrees with its own measurements is rejected.
  assert.ok(judgement.finish?.kind === again.finish.kind && JSON.stringify(judgement.finish.shortfall) === JSON.stringify(again.finish.shortfall),
    'Stage 1\'s recorded finish (kind or shortfall) is not what its measurements give');
  // Every record of how Stage 1 ended carries the same recomputed shortfall (sol final review): finish.json's
  // reasons, and for a limited finish limited.json's shortfall. A stale or edited record is refused.
  const recomputed = JSON.stringify(again.abnormal);
  assert.equal(JSON.stringify(readJson(`${dir}/finish.json`).reasons), recomputed, 'Stage 1\'s finish.json reasons are not what its measurements give');
  if (limited) assert.equal(JSON.stringify(readJson(`${dir}/limited.json`).shortfall), recomputed, 'Stage 1\'s limited.json shortfall is not what its measurements give');
  assert.ok(limited || judgement.noise.source === 'C hot1/hot2', 'A normal Stage 1 has N from both cache replicates (C hot1/hot2)');
  // The exact spreads behind N, from Stage 1's stored p95s (review round 7): Stage 2 never uses the double.
  const spreads = noiseSpreads(ms);
  assert.ok(spreads !== null && spreads.length > 0 && Number.isFinite(judgement.noise.value) && judgement.noise.value >= 1.05,
    'Stage 1\'s N cannot be computed (no valid C replicates and no valid A1 rounds with every G95): Stage 2 is refused');
  return {...judgement.noise, spreads, stage1: {kind: limited ? 'limited' : 'normal', shortfall: again.finish.shortfall, constraints: again.finish.stage2Constraints}};
}

// The HOST-BUSY the launcher claimed for this queue names this job and carries the launch session. This stops an
// accidental direct run, which has neither variable. It cannot stop a deliberate bypass: whatever the driver
// can check locally can be written locally. Starting through the launcher (preflight, recorded go) is an
// operator rule (maintainer decision on PR #871, extra round sol 1).
function launchedJob(env: NodeJS.ProcessEnv) {
  const file = env.FUKULOW_HOST_BUSY, job = env.FUKULOW_LAUNCH_JOB;
  if (!file || !job || !existsSync(file)) return false;
  const marker = parseHostBusy(readFileSync(file, 'utf8'));
  const session = env.FUKULOW_LAUNCH_SESSION;
  return marker !== null && marker.jobs.includes(job) && (session === undefined || marker.session === session);
}

// §3 prerequisites and the stage's go, all checked before anything touches Docker or a database. Each
// missing one is a STOP before start.
export function prerequisites(args: ReturnType<typeof options>, manifestHash: string, env = process.env, logicalCpus = cpus().length) {
  // §3.2: the launcher holds HOST-BUSY for this queue and this job (it also ran the preflight and logged the go).
  assert.ok(launchedJob(env), 'Start through the launcher: HOST-BUSY is not held for this job');
  const {sets, qualification} = qualificationFor(args.cpuSets, logicalCpus, args.qualification);
  // §3.4: a passed smoke before Stage 1; §5.3: a finished Stage 1 before Stage 2.
  const prior = args.stage === '1' ? finishedStage(args.smokeOut!, 'smoke', manifestHash)
    : args.stage === '2' ? finishedStage(args.stage1Out!, '1', manifestHash, true) : null;
  if (args.stage === '1') assert.equal(prior!.judgement.outcome, 'smoke passed', 'The smoke did not pass');
  // Stage 1 is re-validated against its own measurements before the go is matched, and the go must name the
  // recomputed outcome and shortfall, never the recorded fields alone (sol review of the re-approval fix).
  let n: Stage1N | null = null;
  if (args.stage === '2') {
    assert.ok(stage1Outcomes.includes(prior!.judgement.outcome), `Stage 1 has no recognized outcome: ${prior!.judgement.outcome}`);
    n = stage1Noise(args.stage1Out!, prior!.judgement, prior!.limited);
  }
  const limitedStage1 = n?.stage1.kind === 'limited' ? {outcome: prior!.judgement.outcome as string, shortfall: n.stage1.shortfall} : null;
  const approval = approvalFor(args.approval, args.stage, env.FUKULOW_LAUNCH_JOB, prior?.finishedAt ?? null, limitedStage1);
  return {stage1Noise: n, approval, sets, qualification};
}
const stage1Outcomes = ['not reproduced', 'cause established', 'cause not established', 'repetition-linked, cause not established', 'inconclusive'];

const freeAt = (path: string) => { const s = statfsSync(path, {bigint: true}); return Number(s.bavail * s.bsize); };
const freeOrNull = (path: string) => { try { return freeAt(path); } catch { return null; } };

type PreflightDeps = {logicalCpus: number; os: NodeJS.Platform; hostGate: typeof readHostGate};

function checkHost(out: string, env: NodeJS.ProcessEnv, hostGate: typeof readHostGate, record: string) {
  const result = hostGate(env.FUKULOW_LAUNCH_SESSION ?? '', out, {launcherGateLog: env.FUKULOW_LAUNCH_GATE_LOG});
  save(`${out}/${record}`, result);
  assert.ok(result.problems.length === 0, `STOP: host preflight (§3.1): ${result.problems.join('; ')}`);
}

async function worker(env: NodeJS.ProcessEnv, {io: workerIo, logicalCpus, os, hostGate}: PreflightDeps & {io: Io}) {
  // Set by a signal (review rounds 6 and 7). The worker's only I/O is the gated set below, so no SQL,
  // docker command, session, statement or pgbench starts once it is set.
  let abortReason: string | null = null;
  const io = gatedIo(workerIo, () => abortReason);
  const {sql, docker, command, boundedCommand, clientBenchmark, clientSession} = io;
  const {frozen, sha256} = loadManifest();
  // Before anything else: the prerequisites again, and this launch's one-time token (review round 5, item 1).
  const {stage1Noise, sets, qualification} = workerGate(env, sha256, logicalCpus, os, hostGate);
  const stage = env.DIAG870_STAGE as Stage;
  const out = env.DIAG870_OUT!;
  const {querySet, transactions, clients, warmupSweeps, rows, restoreRows} = frozen.performance;
  assert.ok(env.DIAG870_RESOURCE_ID && env.FUKULOW_LAUNCH_SESSION, 'Missing supervised Docker resources or launcher session');
  const names = resourceNames(env.DIAG870_RESOURCE_ID);
  const {server, client} = names;
  refuseLeftovers(docker);

  // Prerequisites (§3): snapshot identity and disk, before anything starts.
  const source = await loadBackfill(env.DIAG870_FROM!, sha256, rows, restoreRows);
  assert.equal(source.receipt.snapshot.sha256, expectedSnapshotSha256, 'Not the verified #689 snapshot');
  writeFileSync(`${out}/${dockerStartMarker}`, '', {flag: 'wx'});
  try { resolveImage(docker, frozen.image, true); } catch (error) {
    if (error instanceof CommandTimeoutError) throw error;
    docker('pull', frozen.image);
  }
  const {id} = resolveImage(docker, frozen.image, true);
  const [diskRun, ...diskArgs] = dockerDiskArgs(id, ownershipLabel);
  const dockerFree = () => {
    try { return dfBytes(docker(diskRun, '--tmpfs', postgresDataDir, ...diskArgs)).free; }
    catch { return null; }
  };
  // Docker storage, and the host filesystems of the snapshot tar and of the output (§3.3).
  const startFree = {docker: dockerFree(), snapshot: freeOrNull(source.snapshotDirectory), output: freeOrNull(out)};
  const diskProblems = startDiskProblems(startFree);
  save(`${out}/disk-preflight.json`, {...startFree, problems: diskProblems, unit: 'bytes; thresholds in decimal GB'});
  assert.deepEqual(diskProblems, [], `disk preflight (§3.3): ${diskProblems.join('; ')}`);

  const cluster = diagnosticCluster(io, names, {snapshotDirectory: source.snapshotDirectory, image: id,
    shmBytes: frozen.shmBytes, ...frozen.timing}, env.FUKULOW_LAUNCH_SESSION);
  const {owner} = cluster;
  const placement = await cluster.start(randomUUID());
  save(`${out}/placement-start.json`, placement);
  assert.equal(owner('postgres', 'SHOW server_version_num;'), '180006');
  assert.deepEqual(JSON.parse(owner('postgres', `SELECT json_object_agg(name,setting) FROM pg_settings
    WHERE name IN (${Object.keys(frozen.settings).map(literal).join(',')});`)), frozen.settings);
  assert.equal(owner('postgres', 'SHOW log_autovacuum_min_duration;'), '0');
  assert.equal(owner('postgres', 'SELECT system_identifier FROM pg_control_system();'), source.receipt.snapshot.systemIdentifier);
  assert.deepEqual(verifyRls(text => sql(client, 'base', text, 'fukulow_app'), frozen.sessionPolicy.appSettings), source.receipt.rls);
  const path = productionPath();
  save(`${out}/metadata.json`, {label, stage, manifestHash: sha256, image: {reference: frozen.image, id}, node: process.version,
    source: command('git', ['rev-parse', 'HEAD']), worktreeStatus: command('git', ['status', '--porcelain']),
    snapshot: source.receipt.snapshot, cpuSets: sets, containers: names, diagnosticSettings, platform: platform(),
    steps: sequence(stage), cacheConstraint, qualification,
    approval: readJson(`${out}/approval.json`), hostBusy: env.FUKULOW_HOST_BUSY ?? null});

  // Samplers in their own process (§1). They are stopped on every path: before the judgement on a normal
  // path, in finally on an error, and on a signal to this worker. If the supervisor kills the worker,
  // the sampler receives the IPC disconnect and stops its in-flight commands.
  const samplesFile = `${out}/samples.jsonl`;
  const thermal = platform() === 'linux';
  const sampler = spawn(process.execPath, [fileURLToPath(new URL('./sampler.ts', import.meta.url)), '--out', samplesFile,
    '--server', server, '--client', client, ...(thermal ? ['--thermal'] : [])],
  {stdio: ['ignore', 'inherit', 'inherit', 'ipc'], detached: true});
  // The sampler leads its own process group, so a stop reaches its in-flight commands too.
  const samplerGroup = {get exitCode() { return sampler.exitCode; }, get signalCode() { return sampler.signalCode; },
    kill: (signal: NodeJS.Signals) => { try { process.kill(-sampler.pid!, signal); return true; } catch { return false; } }};
  const groupAlive = () => { try { process.kill(-sampler.pid!, 0); return true; } catch { return false; } };
  const time = clientBenchmark();
  const windows = new Map<string, {start: number; end: number; blocks: Block[]; restart: Restart | null; checked: boolean}>();
  let previous: {id: string; end: number} | null = null;
  let lastRestart: Restart | null = null;
  const app = <T>(body: (search: (text: string) => Promise<string>) => Promise<T>) => clientSession(client, 'measured', true, body);
  // After a restart, wait (up to 30 s) for a fast sample from the restarted server, so the next window's
  // start environment is not read from before the restart. The gap across the restart is checked with the
  // window: over 30 s, or no fresh sample, makes the round INVALID (review item 3).
  let restartCount = 0;
  const restart = async () => {
    const at = Date.now();
    const placement = await cluster.restart();
    save(`${out}/placement-restart-${++restartCount}.json`, {at, ...placement});
    const t = Date.now();
    while (!freshFast(readSamples(samplesFile), t) && Date.now() - t < freshWaitMs) await new Promise(r => setTimeout(r, 250));
    lastRestart = {at, fresh: freshFast(readSamples(samplesFile), t)};
  };
  const reads = () => parseCount(owner('postgres', "SELECT pg_stat_clear_snapshot(); SELECT blks_read FROM pg_stat_database WHERE datname = 'measured';"));
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
      const owned = (text: string) => boundedCommand('docker', ['exec', '-i', client, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
        '-U', 'fukulow', '-d', 'postgres'], left(), text).trim();
      try {
        return await settleWait({
          checkpoint: () => { owned('CHECKPOINT;'); },
          reading: () => {
            
            const mem = readFileSync('/proc/meminfo', 'utf8');
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
          const sample = await timeQuery(client, 'measured', path.page, query, raw, !accepts(query), `${dest}/${query}`, transactions, clients, time);
          results.push({query, sample});
          save(`${dest}/${query}.json`, sample);
        } catch (error) {
          results.push({query, error: String(error)});
        }
        blocks.push({query, start: b, end: Date.now()});
      }
      const end = Date.now();
      await new Promise(r => setTimeout(r, readCounterWaitMs));
      const readsAfter = capture('blks_read after', missing, reads);
      const sharedReads = readsDelta(readsBefore, readsAfter);
      
      const plans = opts.explain ? await explainAll(dest, missing) : null;
      
      const after = capture('stats-after', missing, stats);
      if (after !== null) save(`${dest}/stats-after.json`, after);
      windows.set(step.id, {start, end, blocks, restart: restartBefore, checked: false});
      const latencies = results.map(r => 'error' in r ? {query: r.query, error: r.error}
        : 'p95' in r.sample ? {query: r.query, p95: r.sample.p95} : {query: r.query, error: r.sample.sqlError});
      const m: Measurement = {id: step.id, kind: step.kind, arm: step.arm, order: step.order, settle: step.kind === 'copy' && step.settle,
        latencies, plans, sharedReads, invalid: ownReasons(results, load15), missingEvidence: missing, samplerChecked: false,
        env: {dirtyWritebackAtStartBytes: null, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: [], autovacuumInsideQueries: []}};
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
        const facts = windowFacts(samples, w.start, w.end, w.blocks, {thermal, serverCpus: sets.server, restart: w.restart});
        if (!reached) facts.invalid.push('sampler coverage not reached by the deadline');
        m.invalid.push(...facts.invalid.filter(r => !m.invalid.includes(r)));
        m.env = facts.env;
        m.samplerChecked = true;
        w.checked = true;
      }
    },
    idle: ms => abortableIdle(ms, () => abortReason, Date.now, ms => new Promise(r => setTimeout(r, ms))),
    // A scan that could not page through every result did not do the §5.3 work: a STOP.
    scan: async () => {
      
      const report = await app(async search => { await search(prepare(path.page)); return completeness(search); });
      save(`${out}/B.scan.json`, report);
      const broken = report.flatMap(q => q.actors.filter(a => a.paginationError).map(a => `${q.query}/${a.actor}`));
      if (broken.length) throw new Error(`completeness scan pagination errors: ${broken.join(', ')}`);
    },
    log: note,
    aborted: () => abortReason,
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
  const stopSampler = () => samplerStopped ??= stopProcess(samplerGroup, 15_000, 5_000, groupAlive).then(r => { save(`${out}/sampler-stop.json`, r); return r; });
  const onSignal = (signal: NodeJS.Signals, code: number) => process.once(signal, signalStop(signal, code, {
    abort: () => { abortReason ??= signal; },
    stop: stopSampler,
    record: () => { finishRecords(out, stage, sha256, `signal ${signal}`, [`STOP: signal ${signal}`]); },
    exit: c => process.exit(c)}));
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
    const logMissing = postgresLog(io, server, out);
    if (logMissing) stageMissing.push(logMissing);
    const judgement = stage === '1' ? stage1(result.measurements, result.stopped, stageMissing)
      : stage === '2' ? stage2(result.measurements, stage1Noise!, result.stopped, stageMissing)
      : smoke(result.measurements, result.stopped, stageMissing);
    save(`${out}/judgement.json`, {label, stage, stopped: result.stopped, cacheConstraint, ...judgement});
    note(`judgement: ${JSON.stringify('outcome' in judgement ? judgement.outcome : judgement.result)}`);
    const limited = 'finish' in judgement && judgement.finish.kind === 'limited'
      ? {nSource: judgement.finish.nSource, constraints: judgement.finish.stage2Constraints} : null;
    process.exitCode = finishRecords(out, stage, sha256, result.stopped, judgement.abnormal, limited);
  } finally {
    const r = await stopSampler();
    if (!r.verified) { note(`sampler did not exit: ${r.how}`); process.exitCode ||= stopExitCode; }
    if (!logTried) postgresLog(io, server, out);
  }
}

// The worker's own gate (SEARCH_WORKER=1 is only an environment variable, so it proves nothing): it parses
// the launch's arguments and checks every prerequisite again, binds stage and output to them, and claims the
// one-time token the launching process wrote into the output directory. A second worker, or one started
// with inherited settings, finds the token claimed or missing and stops before Docker.
export function workerGate(env: NodeJS.ProcessEnv, manifestHash: string, logicalCpus = cpus().length, os = platform(), hostGate = readHostGate) {
  assert.ok(env.DIAG870_ARGV && env.DIAG870_TOKEN && env.DIAG870_OUT, 'Not a supervised #870 worker launch');
  const args = options(JSON.parse(env.DIAG870_ARGV) as string[], os);
  const checked = prerequisites(args, manifestHash, env, logicalCpus);
  assert.ok(env.DIAG870_STAGE === args.stage && env.DIAG870_FROM === args.from && env.DIAG870_CPU_SETS === args.cpuSets,
    'The worker settings do not match the launch arguments');
  const file = `${env.DIAG870_OUT}/worker-token`, claimed = `${file}.claimed`;
  try { renameSync(file, claimed); } catch { assert.fail('The worker token is missing or already claimed'); }
  assert.equal(readFileSync(claimed, 'utf8'), env.DIAG870_TOKEN, 'The worker token does not match');
  assert.equal(JSON.stringify(readIf(`${env.DIAG870_OUT}/approval.json`)), JSON.stringify(checked.approval), 'The recorded go is not this launch\'s');
  assert.deepEqual(readIf(`${env.DIAG870_OUT}/qualification.json`), checked.qualification, 'The qualification changed after the supervisor checked it');
  checkHost(env.DIAG870_OUT, env, hostGate, 'host-preflight-worker.json');
  return checked;
}

// A signal to the worker: abort first (synchronously, so no new step, copy or Docker work starts), then
// stop the sampler (verified, or recorded as not), record the abnormal finish, and exit with `code`.
export type SignalActions = {abort(): void; stop(): Promise<{verified: boolean; how: string}>; record(): void; exit(code: number): void};
export const signalStop = (signal: string, code: number, a: SignalActions) => () => {
  a.abort();
  const finish = (line: string) => {
    note(line);
    try { a.record(); } catch (error) { note(`${signal}: finish records not saved: ${String(error)}`); }
    a.exit(code);
  };
  void a.stop().then(r => finish(`${signal}: sampler stop ${r.verified ? 'verified' : 'NOT verified'} (${r.how}); the stage ends`),
    error => finish(`${signal}: sampler stop failed: ${String(error)}`));
};

// A single non-negative integer on the last line of psql output; anything else is unreadable (Neon r5).
export function parseCount(text: string) {
  const last = text.trim().split('\n').at(-1)?.trim() ?? '';
  if (!/^\d+$/.test(last)) throw new Error(`not a count: ${JSON.stringify(last)}`);
  return Number(last);
}

// finish.json always; a normal finish writes completed.json (exit 0), anything else stopped.json with its
// reasons and no completed.json (exit 2), so the supervisor marks the run invalid and the queue ends.
// A limited Stage 1 (`limited` given) writes limited.json with its shortfall, N source and Stage 2 constraints
// instead of stopped.json, and exits limitedExitCode: the queue ends, and Stage 2 may follow only with its own go.
// Decision 1: between hot 1 and hot 2 only the statistics reads, this wait for pg_stat_database's read
// counter and the sampler check. Decision 4: shared reads are the counter's delta over the window
// (database-wide supporting evidence), never its cumulative value; an unreadable or regressed reading is null.
export const readCounterWaitMs = 1_000;
export function readsDelta(before: number | null, after: number | null) {
  return before === null || after === null || !Number.isFinite(after - before) || after < before ? null : after - before;
}

export function finishRecords(out: string, stage: Stage, manifestHash: string, stopped: string | null, abnormal: string[],
  limited: {nSource: string; constraints: string[]} | null = null) {
  const at = new Date().toISOString();
  const kind = abnormal.length === 0 ? 'normal' : limited && stopped === null ? 'limited' : 'blocked';
  save(`${out}/finish.json`, {normal: kind === 'normal', kind, reasons: abnormal});
  if (kind === 'normal') {
    save(`${out}/completed.json`, {manifestHash, label, stage, at});
    return 0;
  }
  if (kind === 'limited') {
    rmSync(`${out}/completed.json`, {force: true});
    save(`${out}/limited.json`, {label, stage, shortfall: abnormal, ...limited, at});
    note(`not a normal finish (limited: ${abnormal.join('; ')}); Stage 2 only with its own go naming this Stage 1`);
    return limitedExitCode;
  }
  rmSync(`${out}/limited.json`, {force: true});
  // A signal after a normal finish turns it abnormal: completed.json goes, so no record says otherwise.
  rmSync(`${out}/completed.json`, {force: true});
  save(`${out}/stopped.json`, {label, stage, stopped, reasons: abnormal, at});
  note(`not a normal finish: ${abnormal.join('; ')}`);
  return stopExitCode;
}

// The PostgreSQL log, both streams (it logs to stderr). Returns null when saved, else what is missing;
// after a signal the gated command refuses, so the log is skipped and recorded as missing.
export function postgresLog(io: Pick<Io, 'spawnSync'>, container: string, out: string) {
  try {
    const logs = io.spawnSync('docker', ['logs', container], {encoding: 'utf8', timeout: timeouts.docker, maxBuffer: 1024 ** 3});
    const text = `${logs.stdout ?? ''}${logs.stderr ?? ''}`;
    writeFileSync(`${out}/postgres.log`, text);
    if (logs.error || logs.status !== 0) return `postgres log: docker logs ${logs.error ? String(logs.error) : `exited ${logs.status}`}`;
    if (text.trim() === '') return 'postgres log: empty';
    return null;
  } catch (error) { return `postgres log not saved: ${String(error)}`; }
}

export async function main(argv = process.argv.slice(2), env = process.env,
  {logicalCpus = cpus().length, os = platform(), hostGate = readHostGate, io = rawIo, supervise = superviseStage} = {}) {
  if (env.SEARCH_WORKER === '1') { await worker(env, {logicalCpus, os, hostGate, io}); return; }
  const args = options(argv, os);
  const {sha256} = loadManifest();
  // Everything in §3 and the stage's go, before any Docker or database work.
  const {approval, qualification} = prerequisites(args, sha256, env, logicalCpus);
  const out = outputPath(args.out);
  mkdirSync(out, {mode: 0o700});
  checkHost(out, env, hostGate, 'host-preflight.json');
  save(`${out}/approval.json`, approval);
  save(`${out}/qualification.json`, qualification);
  const token = randomUUID();
  const resourceId = randomUUID();
  writeFileSync(`${out}/worker-token`, token, {mode: 0o600, flag: 'wx'});
  const workerEnv = {...env, DIAG870_STAGE: args.stage, DIAG870_OUT: out, DIAG870_FROM: args.from,
    DIAG870_CPU_SETS: args.cpuSets, DIAG870_RESOURCE_ID: resourceId,
    DIAG870_ARGV: JSON.stringify(argv), DIAG870_TOKEN: token};
  await supervise({entry: import.meta.url, out, manifestHash: sha256, stage: args.stage, names: resourceNames(resourceId), env: workerEnv});
  note(`${label}: stage ${args.stage} ${process.exitCode ? 'did not finish normally' : 'finished'} (${out})`);
}

if (import.meta.main) await main();
