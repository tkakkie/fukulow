import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { dfBytes, dockerDiskArgs, outputDisk } from '../d3r/headroom.ts';
import { argumentsForPostgres, loadManifest } from '../d3r/manifest.ts';
import { productionPath } from '../d3r/path.ts';
import { outputPath, recordedWarmup } from '../d3r/run.ts';
import { verifyRls } from '../d3r/rls.ts';
import { withSession } from '../d3r/session.ts';
import { loadBackfill } from '../d3r/snapshot.ts';
import { timeQuery } from '../d3r/timing.ts';
import { checkPins, diagnosticSettings, expectedSnapshotSha256, launchArgs, pinnedBenchmark, planShape } from './cluster.ts';
import { ownReasons, stage1, stage2, type Block, type Measurement } from './judge.ts';
import { execute, type Deps } from './orchestrate.ts';
import { ordered, sequence, type MeasuredStep, type Stage } from './plan.ts';
import { readSamples, windowFacts } from './sampler.ts';

// #870 diagnostic driver (design rev 2, approved 2026-11-24). One launch runs one stage once on the
// verified #689 snapshot; nothing reruns. Its records are diagnosis only and never #689 evidence.
// Start it through the launcher (#867), which holds HOST-BUSY and records the go.

export const label = 'DIAGNOSTIC #870 / NOT #689 EVIDENCE';
const GiB = 1024 ** 3;
export const minDockerStartBytes = 175 * GiB;
export const minHostFreeBytes = 40 * GiB;
const samplerSettleMs = 12_000;
const note = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

export function options(argv: string[]) {
  const {values} = parseArgs({args: argv, options: {stage: {type: 'string'}, 'from-backfill': {type: 'string'},
    out: {type: 'string'}, 'cpu-sets': {type: 'string'}, 'stage1-out': {type: 'string'}}});
  const stage = values.stage as Stage;
  assert.ok(['smoke', '1', '2'].includes(stage), '--stage must be smoke, 1 or 2');
  assert.ok(values['from-backfill'] && values.out, '--from-backfill and --out are required');
  assert.ok(stage !== '2' || values['stage1-out'], 'Stage 2 needs --stage1-out (its N comes from Stage 1)');
  if (platform() === 'linux') assert.ok(values['cpu-sets'], 'On Linux the #796 CPU sets are required (--cpu-sets)');
  return {stage, from: resolve(values['from-backfill']), out: values.out, cpuSets: values['cpu-sets'], stage1Out: values['stage1-out']};
}

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
  const startFree = {docker: dockerFree(), host: outputDisk(out).free};
  save(`${out}/disk-preflight.json`, startFree);
  assert.ok(startFree.docker !== null && startFree.docker >= minDockerStartBytes, `Docker free < 175 GiB: ${startFree.docker}`);
  assert.ok(startFree.host >= minHostFreeBytes, `host free < 40 GiB: ${startFree.host}`);

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
    steps: sequence(stage), cacheConstraint: 'restart-only empties shared buffers only; no drop_caches; not a cold-cache measurement'});

  // Samplers in their own process (§1); stopped in finally.
  const samplesFile = `${out}/samples.jsonl`;
  const sampler = spawn(process.execPath, [fileURLToPath(new URL('./sampler.ts', import.meta.url)), '--out', samplesFile,
    '--container', container, ...(sets ? ['--client-cpus', cpuList(sets.client)] : []), ...(platform() === 'linux' ? ['--thermal'] : [])],
  {stdio: 'inherit'});
  const time = sets ? pinnedBenchmark(sets.client) : benchmark;
  const windows = new Map<string, {start: number; end: number; blocks: Block[]; checked: boolean}>();
  const app = <T>(body: (search: (text: string) => Promise<string>) => Promise<T>) => withSession(container, 'measured', true, body);
  const restart = async () => { docker('restart', container); await ready(); };
  const reads = () => Number(owner('postgres', "SELECT pg_stat_clear_snapshot(); SELECT blks_read FROM pg_stat_database WHERE datname = 'measured';").split('\n').at(-1));
  const stats = () => owner('measured', `SELECT json_build_object(
    'io', (SELECT json_agg(row_to_json(i)) FROM pg_stat_io i WHERE reads > 0 OR hits > 0),
    'tables', (SELECT json_agg(row_to_json(t)) FROM pg_stat_user_tables t WHERE relname IN ('messages', 'message_search_terms')),
    'reltuples', (SELECT json_object_agg(relname, reltuples) FROM pg_class WHERE relname IN ('messages', 'message_search_terms')),
    'checkpointer', (SELECT row_to_json(c) FROM pg_stat_checkpointer c), 'wal', (SELECT row_to_json(w) FROM pg_stat_wal w));`);

  const deps: Deps = {
    dockerFreeBytes: dockerFree,
    copy: async () => { owner('postgres', 'DROP DATABASE IF EXISTS measured;'); owner('postgres', 'CREATE DATABASE measured TEMPLATE base;'); },
    settle: async capMs => {
      const deadline = Date.now() + capMs;
      owner('postgres', 'CHECKPOINT;');
      for (;;) {
        const mem = docker('exec', container, 'cat', '/proc/meminfo');
        const kib = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB$`, 'm').exec(mem)?.[1] ?? NaN) * 1024;
        const autovacuum = Number(owner('postgres', "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker';"));
        if (kib('Dirty') + kib('Writeback') < 64 * 1024 ** 2 && autovacuum === 0) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(r => setTimeout(r, 1_000));
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
      let plans: Measurement['plans'] = null;
      if (opts.explain) {
        plans = await app(async search => {
          await search(prepare(path.page));
          const list = [];
          for (const [query, raw] of querySet.filter(([q]) => accepts(q))) {
            const {explain} = await explainPage(search, raw);
            save(`${dest}/${query}-plan.json`, explain);
            list.push({query, ...planShape(explain)});
          }
          return list;
        });
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
    revalidate: ms => {
      const samples = readSamples(samplesFile);
      for (const m of ms) {
        const w = windows.get(m.id);
        if (!w || w.checked || Date.now() - w.end < samplerSettleMs) continue;
        const facts = windowFacts(samples, w.start, w.end, w.blocks, {thermal: platform() === 'linux', serverCpus: sets?.server ?? null});
        m.invalid.push(...facts.invalid.filter(r => !m.invalid.includes(r)));
        m.env = facts.env;
        w.checked = true;
      }
    },
    idle: ms => new Promise(r => setTimeout(r, ms)),
    scan: async () => { save(`${out}/B.scan.json`, await app(async search => { await search(prepare(path.page)); return completeness(search); })); },
    log: note,
  };

  try {
    const result = await execute(sequence(stage), deps);
    await new Promise(r => setTimeout(r, samplerSettleMs));
    deps.revalidate(result.measurements);
    save(`${out}/measurements.json`, result);
    const judgement = stage === '1' ? stage1(result.measurements, result.stopped)
      : stage === '2' ? stage2(result.measurements, JSON.parse(readFileSync(`${env.DIAG870_STAGE1}/judgement.json`, 'utf8')).noise.value)
      : {note: 'SMOKE: numbers are not used'};
    save(`${out}/judgement.json`, {label, stage, stopped: result.stopped, ...judgement});
    note(`judgement: ${JSON.stringify('outcome' in judgement ? judgement.outcome : 'result' in judgement ? judgement.result : judgement.note)}`);
    save(`${out}/completed.json`, {manifestHash: sha256, label, stage, at: new Date().toISOString()});
  } finally {
    sampler.kill('SIGTERM');
    try { writeFileSync(`${out}/postgres.log`, boundedCommand('docker', ['logs', container], timeouts.docker) + '\n'); } catch (error) { note(`postgres log not saved: ${String(error)}`); }
  }
}

async function main() {
  if (process.env.SEARCH_WORKER === '1') { await worker(process.env); return; }
  const args = options(process.argv.slice(2));
  if (args.cpuSets) parseCpuSets(args.cpuSets, cpus().length);
  const {sha256} = loadManifest();
  const out = outputPath(args.out);
  refuseLeftovers(docker);
  mkdirSync(out, {mode: 0o700});
  Object.assign(process.env, {DIAG870_STAGE: args.stage, DIAG870_OUT: out, DIAG870_FROM: args.from,
    DIAG870_CPU_SETS: args.cpuSets ?? '', DIAG870_STAGE1: args.stage1Out ? resolve(args.stage1Out) : ''});
  // The supervisor runs this file as the worker, owns the container and volume, and always removes them.
  await supervise(import.meta.url, out, sha256, () => note(`${label}: stage ${args.stage} finished (${out})`));
}

if (import.meta.main) await main();
