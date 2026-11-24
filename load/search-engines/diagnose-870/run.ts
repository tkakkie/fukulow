import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
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
import { cacheConstraint, ownReasons, stage1, stage2, type Block, type Measurement, type Plan } from './judge.ts';
import { execute, GB, type Deps } from './orchestrate.ts';
import { ordered, sequence, type MeasuredStep, type Stage } from './plan.ts';
import { covered, readSamples, windowFacts } from './sampler.ts';

// #870 diagnostic driver (design rev 2, approved 2026-11-24). One launch runs one stage once on the
// verified #689 snapshot; nothing reruns. Its records are diagnosis only and never #689 evidence.
// It starts only through the launcher (#867), which holds HOST-BUSY, checks the idle host and records the go.

export const label = 'DIAGNOSTIC #870 / NOT #689 EVIDENCE';
// §3.3, in decimal GB as approved.
export const minDockerStartBytes = 175 * GB;
export const minHostFreeBytes = 40 * GB;
// A STOP or a failed smoke ends the launcher queue (non-zero exit); the records stay.
export const stopExitCode = 2;
const note = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

export function options(argv: string[]) {
  const {values} = parseArgs({args: argv, options: {stage: {type: 'string'}, 'from-backfill': {type: 'string'},
    out: {type: 'string'}, 'cpu-sets': {type: 'string'}, 'stage1-out': {type: 'string'}, 'smoke-out': {type: 'string'},
    qualification: {type: 'string'}}});
  const stage = values.stage as Stage;
  assert.ok(['smoke', '1', '2'].includes(stage), '--stage must be smoke, 1 or 2');
  assert.ok(values['from-backfill'] && values.out, '--from-backfill and --out are required');
  assert.ok(stage !== '1' || values['smoke-out'], 'Stage 1 needs --smoke-out (a passed smoke, §3.4)');
  assert.ok(stage !== '2' || values['stage1-out'], 'Stage 2 needs --stage1-out (its N comes from Stage 1)');
  if (platform() === 'linux') {
    assert.ok(values['cpu-sets'] && values.qualification, 'On Linux the #796 CPU sets and --qualification are required (§3.1)');
  }
  return {stage, from: resolve(values['from-backfill']), out: values.out, cpuSets: values['cpu-sets'],
    stage1Out: values['stage1-out'] && resolve(values['stage1-out']), smokeOut: values['smoke-out'] && resolve(values['smoke-out']),
    qualification: values.qualification && resolve(values.qualification)};
}

// A finished earlier stage of this diagnosis: completed under this manifest, not stopped, same CPU sets.
function finishedStage(dir: string, stage: Stage, manifestHash: string, cpuSets: string | undefined) {
  const completed = readJson(`${dir}/completed.json`), judgement = readJson(`${dir}/judgement.json`), metadata = readJson(`${dir}/metadata.json`);
  assert.ok(completed.manifestHash === manifestHash && completed.stage === stage && judgement.stage === stage && judgement.stopped === null,
    `${dir} is not a finished ${stage === 'smoke' ? 'smoke' : `Stage ${stage}`} of this manifest`);
  assert.equal(JSON.stringify(metadata.cpuSets ?? null), JSON.stringify(cpuSets ? parseCpuSets(cpuSets, cpus().length) : null),
    `${dir} ran on other CPU sets`);
  return judgement;
}

// §3 prerequisites, checked before the supervisor starts anything. Each missing one is a STOP before start.
export function prerequisites(args: ReturnType<typeof options>, manifestHash: string, env = process.env) {
  // §3.2: the launcher holds HOST-BUSY for this run.
  assert.ok(env.FUKULOW_HOST_BUSY && existsSync(env.FUKULOW_HOST_BUSY), 'Start through the launcher: HOST-BUSY is not held');
  if (args.cpuSets) {
    const [given, fixed] = [args.cpuSets, qualifiedCpuSets].map(t => parseCpuSets(t, cpus().length));
    assert.ok(cpuList(given.server) === cpuList(fixed.server) && cpuList(given.client) === cpuList(fixed.client),
      `CPU sets must be the #796 sets ${qualifiedCpuSets}`);
  }
  // §3.1: the #796 qualification record, PASS, on these sets.
  if (args.qualification) {
    const q = readJson(args.qualification);
    assert.ok(q.issue === 796 && q.result === 'PASS' && q.cpuSets === qualifiedCpuSets, 'The #796 qualification is not recorded as PASS on the #796 CPU sets');
  }
  if (args.stage === '1') {
    const smoke = finishedStage(args.smokeOut!, 'smoke', manifestHash, args.cpuSets);
    assert.equal(smoke.outcome, 'smoke passed', 'The smoke did not pass');
  }
  if (args.stage === '2') {
    const s1 = finishedStage(args.stage1Out!, '1', manifestHash, args.cpuSets);
    assert.ok(Number.isFinite(s1.noise?.value) && s1.noise.value >= 1.05, 'Stage 1 has no usable N');
    return {stage1Noise: s1.noise.value as number};
  }
  return {stage1Noise: null};
}

const freeAt = (path: string) => { const s = statfsSync(path, {bigint: true}); return Number(s.bavail * s.bsize); };

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
  const startFree = {docker: dockerFree(), snapshot: freeAt(source.snapshotDirectory), output: freeAt(out)};
  save(`${out}/disk-preflight.json`, {...startFree, unit: 'bytes; thresholds in decimal GB'});
  assert.ok(startFree.docker !== null && startFree.docker >= minDockerStartBytes, `Docker free < 175 GB: ${startFree.docker}`);
  assert.ok(startFree.snapshot >= minHostFreeBytes, `snapshot filesystem free < 40 GB: ${startFree.snapshot}`);
  assert.ok(startFree.output >= minHostFreeBytes, `output filesystem free < 40 GB: ${startFree.output}`);

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
    hostBusy: env.FUKULOW_HOST_BUSY ?? null});

  // Samplers in their own process (§1); stopped in finally.
  const samplesFile = `${out}/samples.jsonl`;
  // The IPC channel ends the sampler if this worker dies without its finally.
  const thermal = platform() === 'linux';
  const sampler = spawn(process.execPath, [fileURLToPath(new URL('./sampler.ts', import.meta.url)), '--out', samplesFile,
    '--container', container, ...(sets ? ['--client-cpus', cpuList(sets.client)] : []), ...(thermal ? ['--thermal'] : [])],
  {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
  const samplerExit = new Promise<void>(r => sampler.once('exit', () => r()));
  const time = sets ? pinnedBenchmark(sets.client) : benchmark;
  const windows = new Map<string, {start: number; end: number; blocks: Block[]; checked: boolean}>();
  const app = <T>(body: (search: (text: string) => Promise<string>) => Promise<T>) => pinnedSession(container, 'measured', true, sets?.client, body);
  const restart = async () => { docker('restart', container); await ready(); };
  const reads = () => Number(owner('postgres', "SELECT pg_stat_clear_snapshot(); SELECT blks_read FROM pg_stat_database WHERE datname = 'measured';").split('\n').at(-1));
  const stats = () => owner('measured', `SELECT json_build_object(
    'io', (SELECT json_agg(row_to_json(i)) FROM pg_stat_io i WHERE reads > 0 OR hits > 0),
    'tables', (SELECT json_agg(row_to_json(t)) FROM pg_stat_user_tables t WHERE relname IN ('messages', 'message_search_terms')),
    'reltuples', (SELECT json_object_agg(relname, reltuples) FROM pg_class WHERE relname IN ('messages', 'message_search_terms')),
    'pg_stats', (SELECT json_agg(json_build_object('table', tablename, 'column', attname, 'null_frac', null_frac, 'avg_width', avg_width,
      'n_distinct', n_distinct, 'correlation', correlation)) FROM pg_stats WHERE schemaname = 'public' AND tablename IN ('messages', 'message_search_terms')),
    'checkpointer', (SELECT row_to_json(c) FROM pg_stat_checkpointer c), 'wal', (SELECT row_to_json(w) FROM pg_stat_wal w));`);

  const deps: Deps = {
    dockerFreeBytes: dockerFree,
    copy: async () => { owner('postgres', 'DROP DATABASE IF EXISTS measured;'); owner('postgres', 'CREATE DATABASE measured TEMPLATE base;'); },
    // Every command gets the time left before the cap; reaching the cap, or a command timing out at it,
    // is false (that round is INVALID), never a STOP.
    settle: async capMs => {
      const deadline = Date.now() + capMs;
      const left = () => deadline - Date.now();
      const owned = (text: string) => boundedCommand('docker', ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
        '-U', 'fukulow', '-d', 'postgres'], Math.max(1, left()), text).trim();
      try {
        owned('CHECKPOINT;');
        for (;;) {
          if (left() <= 0) return false;
          const mem = boundedCommand('docker', ['exec', container, 'cat', '/proc/meminfo'], Math.max(1, Math.min(left(), timeouts.docker)));
          const kib = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB$`, 'm').exec(mem)?.[1] ?? NaN) * 1024;
          const autovacuum = Number(owned("SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker';"));
          if (left() <= 0) return false;
          if (kib('Dirty') + kib('Writeback') < 64 * 1024 ** 2 && autovacuum === 0) return true;
          await new Promise(r => setTimeout(r, Math.min(1_000, Math.max(0, left()))));
        }
      } catch (error) {
        if (error instanceof CommandTimeoutError && left() <= 0) return false;
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
      save(`${dest}/stats-before.json`, JSON.parse(stats()));
      const load15 = loadavg()[2];
      const readsBefore = reads();
      const blocks: Block[] = [];
      const results: Parameters<typeof ownReasons>[0] = [];
      const start = Date.now();
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
      const sharedReads = reads() - readsBefore;
      // An EXPLAIN failure keeps the measurement: that query's plan records the error, so H3 is withheld.
      let plans: Measurement['plans'] = null;
      if (opts.explain) {
        const list: Plan[] = [];
        try {
          await app(async search => {
            await search(prepare(path.page));
            for (const [query, raw] of querySet.filter(([q]) => accepts(q))) {
              try {
                const {explain} = await explainPage(search, raw);
                save(`${dest}/${query}-plan.json`, explain);
                list.push({query, ...planShape(explain)});
              } catch (error) { list.push({query, error: String(error)}); }
            }
          });
        } catch (error) { note(`${step.id}: EXPLAIN session failed: ${String(error)}`); }
        plans = list;
      }
      save(`${dest}/stats-after.json`, JSON.parse(stats()));
      windows.set(step.id, {start, end, blocks, checked: false});
      const latencies = results.map(r => 'error' in r ? {query: r.query, error: r.error}
        : 'p95' in r.sample ? {query: r.query, p95: r.sample.p95} : {query: r.query, error: r.sample.sqlError});
      const m: Measurement = {id: step.id, kind: step.kind, arm: step.arm, order: step.order, settle: step.kind === 'copy' && step.settle,
        latencies, plans, sharedReads, invalid: ownReasons(results, load15), env: {dirtyWritebackAtStartBytes: null, meanTemperatureC: null, meanFrequencyKHz: null, autovacuumQueries: []}};
      save(`${dest}/measurement.json`, {...m, window: {start, end, blocks}, load15});
      note(`${step.id} measured`);
      return m;
    },
    validate: async ms => {
      for (const m of ms) {
        const w = windows.get(m.id);
        if (!w || w.checked) continue;
        let samples = readSamples(samplesFile);
        while (!covered(samples, w.end, thermal, Date.now())) {
          await new Promise(r => setTimeout(r, 500));
          samples = readSamples(samplesFile);
        }
        const facts = windowFacts(samples, w.start, w.end, w.blocks, {thermal, serverCpus: sets?.server ?? null});
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

  try {
    const result = await execute(sequence(stage), deps);
    save(`${out}/measurements.json`, result);
    // The smoke passes only when its round ran and is valid; its numbers are not used.
    const smoke = (ms: Measurement[], stopped: string | null) => ({note: 'SMOKE: numbers are not used',
      outcome: !stopped && ms.length === 1 && ms[0].invalid.length === 0 ? 'smoke passed' : 'smoke failed'});
    const judgement = stage === '1' ? stage1(result.measurements, result.stopped)
      : stage === '2' ? stage2(result.measurements, Number(env.DIAG870_STAGE1_NOISE))
      : smoke(result.measurements, result.stopped);
    save(`${out}/judgement.json`, {label, stage, stopped: result.stopped, cacheConstraint, ...judgement});
    note(`judgement: ${JSON.stringify('outcome' in judgement ? judgement.outcome : judgement.result)}`);
    // A STOP or a failed smoke keeps every record but writes no completed.json, so the supervisor marks the
    // run invalid and the launcher ends the queue.
    if (result.stopped || ('outcome' in judgement && judgement.outcome === 'smoke failed')) {
      save(`${out}/stopped.json`, {label, stage, stopped: result.stopped, at: new Date().toISOString()});
      process.exitCode = stopExitCode;
      return;
    }
    save(`${out}/completed.json`, {manifestHash: sha256, label, stage, at: new Date().toISOString()});
  } finally {
    sampler.kill('SIGTERM');
    await Promise.race([samplerExit, new Promise(r => setTimeout(r, 15_000))]);
    if (sampler.exitCode === null && sampler.signalCode === null) sampler.kill('SIGKILL');
    // Throwaway disk probes carry the ownership label; remove any left behind (the run's own container
    // and volume are the supervisor's).
    try {
      const left = docker('ps', '-aq', '--filter', `label=${ownershipLabel}`).split('\n').map(x => x.trim()).filter(Boolean);
      const own = docker('ps', '-aq', '--filter', `name=^${container}$`).trim();
      for (const c of left.filter(c => c !== own)) docker('rm', '-f', c);
    } catch (error) { note(`probe cleanup failed: ${String(error)}`); }
    // Both streams: PostgreSQL logs to stderr.
    try {
      const logs = spawnSync('docker', ['logs', container], {encoding: 'utf8', timeout: timeouts.docker, maxBuffer: 1024 ** 3});
      writeFileSync(`${out}/postgres.log`, `${logs.stdout ?? ''}${logs.stderr ?? ''}`);
      if (logs.status !== 0) note(`docker logs exited ${logs.status}`);
    } catch (error) { note(`postgres log not saved: ${String(error)}`); }
  }
}

async function main() {
  if (process.env.SEARCH_WORKER === '1') { await worker(process.env); return; }
  const args = options(process.argv.slice(2));
  const {sha256} = loadManifest();
  const {stage1Noise} = prerequisites(args, sha256);
  const out = outputPath(args.out);
  refuseLeftovers(docker);
  mkdirSync(out, {mode: 0o700});
  Object.assign(process.env, {DIAG870_STAGE: args.stage, DIAG870_OUT: out, DIAG870_FROM: args.from,
    DIAG870_CPU_SETS: args.cpuSets ?? '', DIAG870_STAGE1_NOISE: stage1Noise === null ? '' : String(stage1Noise),
    DIAG870_QUALIFICATION: args.qualification ?? ''});
  // The supervisor runs this file as the worker, owns the container and volume, and always removes them.
  await supervise(import.meta.url, out, sha256, () => note(`${label}: stage ${args.stage} finished (${out})`));
  if (process.exitCode === 0 || process.exitCode === undefined) return;
  note(`${label}: stage ${args.stage} did not finish (see ${out}/stopped.json or the log); the queue ends`);
}

if (import.meta.main) await main();
