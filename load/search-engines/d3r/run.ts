import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedCommand, command, CommandTimeoutError, docker, save, sql } from '../bench.ts';
import { probeSql } from '../definer.ts';
import { hash, resolveImage, smokeLabel } from '../manifest.ts';
import { ownedContainer, ownedVolume, ownershipLabel, refuseLeftovers, supervise, timeouts } from '../runtime.ts';
import { copySql, finishSql, fixtureSql, generate, literal } from '../seed.ts';
import { accepts, completeness, denials, fullySampled, judge, rehearsalComplete, whole, type Evidence, type Round,
  type Sample } from './acceptance.ts';
import { backfill, verifiedBackfill, verifyTerms } from './backfill.ts';
import { allPages, explainPage, prepare, type Sql } from './engine.ts';
import { argumentsForPostgres, loadManifest } from './manifest.ts';
import { productionPath, readSource, sources } from './path.ts';
import { withSession } from './session.ts';
import { directRls, verifyRls } from './rls.ts';
import { loadBackfill, preserveSnapshot, receiptFile, removeSnapshot, snapshotFile, snapshotLaunch, stageSnapshot,
  type BackfillReceipt } from './snapshot.ts';
import { timeQuery } from './timing.ts';
import { rehearsalLabel } from './labels.ts';
import { assertHeadroom, dfBytes, dockerDiskArgs, headroomSampler, outputDisk } from './headroom.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const note = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
type Mode = 'smoke' | 'rehearsal' | 'backfill-only' | 'formal' | 'cleanup';
// Rehearsal: full-size setup (seed, backfill, restore drill, denials) and one formal-size round; never evidence.
export const launchFile = 'launch.json';
export const claimFile = 'launch-claimed.json';
export const stagingDirectory = 'restore-snapshot';
const runLabel = (mode: Mode) => mode === 'smoke' ? smokeLabel : mode === 'rehearsal' ? rehearsalLabel : undefined;

export function options(argv: string[]) {
  let mode: Mode = 'formal';
  let output: string | undefined;
  let fromBackfill: string | undefined;
  const sourceOption = '--from-backfill=';
  for (const arg of argv) {
    if ((arg === '--smoke' || arg === '--rehearsal' || arg === '--backfill-only' || arg === '--cleanup') && mode === 'formal') mode = arg.slice(2) as Mode;
    else if (arg.startsWith('--out=') && !output && arg.length > 6) output = arg.slice(6);
    else if (arg.startsWith(sourceOption) && !fromBackfill && arg.length > sourceOption.length) fromBackfill = arg.slice(sourceOption.length);
    else throw new Error(`Unexpected or duplicate argument ${arg}`);
  }
  assert.ok(Boolean(fromBackfill) === (mode === 'formal' || mode === 'cleanup'),
    'Use --smoke, --rehearsal, --backfill-only, --from-backfill=DIR, or --cleanup --from-backfill=DIR');
  assert.ok(mode !== 'cleanup' || !output, 'Cleanup takes --from-backfill=DIR only');
  return {mode, output, fromBackfill};
}

function outsideGit(path: string, repository: string) {
  const absolute = resolve(path);
  const out = resolve(realpathSync(dirname(absolute)), basename(absolute));
  const gitRoot = realpathSync(repository);
  assert.ok(out !== gitRoot && !out.startsWith(gitRoot + '/'), 'Artifacts must be outside Git');
  return out;
}

// Files any harness run writes into its output directory. A new output must not be inside one.
const artifactFiles = [launchFile, claimFile, 'run-status.json', 'completed.json', 'finished.json', 'summary.json', 'image.json',
  'manifest.json', 'metadata.json', 'evidence.json', receiptFile, snapshotFile];

function outsideArtifacts(out: string) {
  for (let dir = dirname(out); ; dir = dirname(dir)) {
    const found = artifactFiles.find(file => lstatSync(join(dir, file), {throwIfNoEntry: false}));
    assert.ok(!found, `Artifacts must not be inside another run's output (${join(dir, found ?? '')})`);
    if (dir === dirname(dir)) return;
  }
}

export function outputPath(path: string, repository = root) {
  const out = outsideGit(path, repository);
  const existing = lstatSync(out, {throwIfNoEntry: false});
  assert.ok(!existing, 'Artifact destination already exists');
  outsideArtifacts(out);
  return out;
}

export type Launch = {mode: Mode; label: string | null; fromBackfill: string | null; token: string; supervisorPid: number;
  supervisorStart: string};

// Process start time; with the PID it identifies the supervisor even after the PID is reused.
export const processStart = (pid: number) => command('ps', ['-o', 'lstart=', '-p', String(pid)]).trim();

// Written by the CLI process before supervise(): the run's identity marker, also left by a failed run.
export function writeLaunch(out: string, mode: Mode, fromBackfill: string | undefined, startOf = processStart) {
  const launch: Launch = {mode, label: runLabel(mode) ?? null, fromBackfill: fromBackfill ?? null, token: randomUUID(),
    supervisorPid: process.pid, supervisorStart: startOf(process.pid)};
  save(`${out}/${launchFile}`, launch);
  return launch;
}

// Worker variables can be inherited from a shell. Only a worker that its own supervisor launched
// (no CLI arguments, the launch token, supervisor PID and supervisor start time of the marker in a
// directory holding nothing else) runs, and the mode and source are the CLI's, recorded in that marker.
// The worker claims the launch exclusively, so a captured token never admits a second worker.
export function workerOptions(env: NodeJS.ProcessEnv, argv: string[], parentPid: number, repository = root,
  startOf = processStart) {
  assert.equal(argv.length, 0, 'SEARCH_WORKER is set but CLI arguments were given; unset the inherited worker variables');
  assert.ok(env.SEARCH_D3R_OUT, 'Missing worker output directory');
  const out = outsideGit(env.SEARCH_D3R_OUT, repository);
  const stats = lstatSync(out, {throwIfNoEntry: false});
  const fresh = 'Worker output must be the fresh directory created by its own supervisor';
  assert.ok(stats?.isDirectory() && JSON.stringify(readdirSync(out)) === JSON.stringify([launchFile]), fresh);
  outsideArtifacts(out);
  const launch: Launch = JSON.parse(readFileSync(join(out, launchFile), 'utf8'));
  assert.ok(typeof env.SEARCH_D3R_LAUNCH === 'string' && env.SEARCH_D3R_LAUNCH.length > 0 &&
    launch.token === env.SEARCH_D3R_LAUNCH && launch.supervisorPid === parentPid &&
    typeof launch.supervisorStart === 'string' && launch.supervisorStart.length > 0 &&
    launch.supervisorStart === startOf(parentPid), fresh);
  assert.ok(launch.mode === env.SEARCH_D3R_MODE && launch.fromBackfill === (env.SEARCH_D3R_FROM || null),
    'Worker variables disagree with the launch');
  const {mode} = launch;
  const fromBackfill = launch.fromBackfill ?? undefined;
  assert.ok(['smoke', 'rehearsal', 'backfill-only', 'formal'].includes(mode), 'Invalid worker mode');
  assert.ok(Boolean(fromBackfill) === (mode === 'formal'), 'Only a formal worker reads a verified backfill');
  try {
    writeFileSync(join(out, claimFile), JSON.stringify({token: launch.token, workerPid: process.pid}) + '\n',
      {flag: 'wx', mode: 0o600});
  } catch {
    assert.fail(`${fresh}; the launch was already claimed`);
  }
  return {mode, output: out, fromBackfill};
}

async function worker(mode: Mode, out: string, {frozen, sha256}: ReturnType<typeof loadManifest>,
  source: Awaited<ReturnType<typeof loadBackfill>> | undefined) {
  assert.ok(mode !== 'formal' || source, 'Formal evaluation requires a verified backfill');
  const container = ownedContainer();
  const volume = ownedVolume();
  assert.ok(container && volume, 'Missing supervised Docker resources');
  const owner = (db: string, text: string) => sql(container, db, text);
  const app = (db: string, text: string) => sql(container, db, text, 'fukulow_app');
  const path = productionPath();
  const conditions = mode === 'smoke' ? {...frozen.performance, ...frozen.smoke.performance}
    : mode === 'rehearsal' ? {...frozen.performance, ...frozen.rehearsal.performance} : frozen.performance;
  const phase = (name: string, event: string) => note(`${runLabel(mode) ? runLabel(mode) + ' ' : ''}${name} ${event}`);
  phase('run', 'started');
  try {
    resolveImage(docker, frozen.image, true);
  } catch (error) {
    if (error instanceof CommandTimeoutError) throw error;
    docker('pull', frozen.image);
  }
  const {id} = resolveImage(docker, frozen.image, true);
  const image = {reference: frozen.image, id};
  save(`${out}/image.json`, image);
  save(`${out}/manifest.json`, {frozen, sha256});
  async function awaitReady() {
    for (let i = 0; i < frozen.timing.startupAttempts; i++) {
      try {
        docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'fukulow', '-d', 'postgres');
        if (owner('postgres', 'SELECT NOT pg_is_in_recovery();') === 't') return;
      } catch (error) {
        if (error instanceof CommandTimeoutError) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, frozen.timing.startupPollMs));
    }
    throw new Error('PostgreSQL startup timed out');
  }

  // Starts the owned cluster, from a staged physical snapshot when one is given, and checks its settings.
  async function start(snapshotDirectory?: string) {
    const launch = snapshotDirectory ? snapshotLaunch(snapshotDirectory) : {options: [], args: []};
    docker('volume', 'create', '--label', ownershipLabel, volume);
    command('docker', ['run', '-d', '--label', ownershipLabel, '--name', container, '--network=none',
      `--shm-size=${frozen.shmBytes}`, '--mount', `type=volume,source=${volume},target=/var/lib/postgresql`,
      ...launch.options, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=postgres',
      id, ...launch.args, ...argumentsForPostgres],
    undefined, {...process.env, POSTGRES_PASSWORD: randomUUID()});
    if (snapshotDirectory) {
      boundedCommand('docker', ['exec', container, 'sh', '-ec',
        'until test -e /tmp/backfill-extracted; do sleep 1; done'], timeouts.psql);
    }
    await awaitReady();
    assert.equal(owner('postgres', 'SHOW server_version_num;'), '180006');
    assert.equal(owner('postgres', 'SHOW shared_preload_libraries;'), '');
    assert.equal(owner('postgres', "SELECT count(*) FROM pg_available_extensions WHERE name = 'pgroonga';"), '0');
    const current = JSON.parse(owner('postgres', `SELECT json_object_agg(name,setting) FROM pg_settings
      WHERE name IN (${Object.keys(frozen.settings).map(literal).join(',')});`));
    assert.deepEqual(current, frozen.settings);
    return current;
  }
  const settings = await start(source?.snapshotDirectory);
  save(`${out}/metadata.json`, {manifestHash: sha256, mode, label: runLabel(mode),
    at: new Date().toISOString(), node: process.version, source: command('git', ['rev-parse', 'HEAD']),
    worktreeStatus: command('git', ['status', '--porcelain']),
    image, settings, sessionPolicy: frozen.sessionPolicy, serverSqlHashes: path.hashes, conditions,
    architecture: arch(), os: process.platform, cpu: cpus()[0]?.model, cpus: cpus().length, memory: totalmem(),
    docker: JSON.parse(docker('info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memory":{{.MemTotal}}}')),
    database: owner('postgres', 'SELECT version(); SELECT datcollate, datctype FROM pg_database WHERE datname = current_database();'),
  });
  const currentSystemIdentifier = () => owner('postgres', 'SELECT system_identifier FROM pg_control_system();');
  if (source) {
    assert.equal(currentSystemIdentifier(), source.receipt.snapshot.systemIdentifier, 'Restored cluster identity differs');
    save(`${out}/${receiptFile}`, source.receipt);
  }
  const role = readSource('deploy/db-roles.sql');
  const roleSettings = readSource('deploy/db-role-settings.sql');
  const grants = readSource('deploy/db-grants.sql');
  if (!source) owner('postgres', `BEGIN;\n${roleSettings}\nSET LOCAL fukulow.app_password = '${randomUUID()}';\n${role}\nCOMMIT;`);
  const engine = readSource(sources.engine);
  const openApp = <T>(db: string, body: Parameters<typeof withSession<T>>[3]) => withSession(container, db, true, body);
  const openOwner = <T>(db: string, body: Parameters<typeof withSession<T>>[3]) => withSession(container, db, false, body);

  const rlsFor = (db: string) => verifyRls(text => app(db, text), frozen.sessionPolicy.appSettings);

  function create(db: string) {
    owner('postgres', `CREATE DATABASE ${db} TEMPLATE template0;`);
    for (const migration of frozen.migrations) owner(db, `BEGIN;\n${readSource(migration)}\nCOMMIT;`);
    owner(db, frozen.setup.forceSearchRls);
    owner(db, grants);
    const verification = rlsFor(db);
    owner(db, fixtureSql());
    return verification;
  }

  function seedDb(db: string, count: number) {
    const tsv = `${out}/${db}-messages.tsv`;
    const data = generate(tsv, count);
    assert.ok(Number(data.old) > 0, 'The frozen generator supplied no Messages older than 180 days');
    save(`${out}/${db}-seed.json`, data);
    docker('cp', tsv, `${container}:/tmp/messages.tsv`);
    owner(db, copySql);
    owner(db, finishSql);
    rmSync(tsv);
    docker('exec', container, 'rm', '/tmp/messages.tsv');
    phase(db, `seeded ${count} Messages (${data.old} older than 180 days)`);
  }

  async function fill(db: string, count: number) {
    phase('backfill', `started (${db})`);
    const record = await openOwner(db, own => openApp(db, search => backfill(own, search, engine, count)));
    save(`${out}/${db}-backfill.json`, {phase: 'backfill', database: db, ...record});
    phase('backfill', `finished (${db}, ${record.inserted} term rows, verified=${record.verification.equal})`);
    assert.ok(verifiedBackfill(record, count), 'INVALID: backfill verification mismatch or missing evidence');
    owner(db, 'VACUUM ANALYZE public.message_search_terms;');
    return record;
  }

  async function complete(db: string) {
    return openApp(db, async search => {
      await search(prepare(path.page));
      return completeness(search);
    });
  }

  async function restoreDrill(expectedTermRows: number) {
    phase('restore', 'started');
    const checksum = (db: string) => owner(db,
      "SELECT count(*), md5(string_agg(id::text || body, '|' ORDER BY id)) FROM messages;");
    const before = checksum('small');
    docker('exec', container, 'pg_dump', '-U', 'fukulow', '-d', 'small', '-Fc', '-f', '/tmp/drill.dump');
    docker('cp', `${container}:/tmp/drill.dump`, `${out}/d3r-small.dump`);
    owner('postgres', 'CREATE DATABASE restored TEMPLATE template0;');
    const start = performance.now();
    docker('exec', container, 'pg_restore', '-U', 'fukulow', '-d', 'restored',
      '--exit-on-error', '--no-owner', '--no-acl', '/tmp/drill.dump');
    const restoreMs = performance.now() - start;
    owner('restored', grants);
    const rls = {settings: rlsFor('restored'), cleanup: directRls(text => app('restored', text))};
    const after = checksum('restored');
    const restoredTermRows = Number(owner('restored', 'SELECT count(*) FROM public.message_search_terms;'));
    const terms = await openOwner('restored', own => verifyTerms(own, conditions.restoreRows, restoredTermRows));
    const evidence = {restoreMs, before, after, rls, terms, termRows: restoredTermRows, expectedTermRows,
      complete: await complete('restored')};
    save(`${out}/restore.json`, evidence);
    owner('postgres', 'DROP DATABASE restored; DROP DATABASE small;');
    phase('restore', 'finished');
    return evidence;
  }

  const completion = {manifestHash: sha256, runKind: mode, at: new Date().toISOString(), label: runLabel(mode)};
  let records: BackfillReceipt['records'];
  let rls: BackfillReceipt['rls'];
  if (source) {
    records = source.receipt.records;
    rls = rlsFor('base');
    assert.deepEqual(rls, source.receipt.rls);
  } else {
    rls = create('base');
    seedDb('base', conditions.rows);
    const base = await fill('base', conditions.rows);
    create('small');
    seedDb('small', conditions.restoreRows);
    const small = await fill('small', conditions.restoreRows);
    create('denial');
    owner('denial', probeSql);
    const denial = await fill('denial', 20_011);
    records = {base, small, denial};
  }
  if (mode === 'rehearsal') {
    // The formal physical handoff, on a rehearsal-owned snapshot: create, verify and archive, stop the
    // seeded cluster, stage and checksum, start the restored cluster. Both archive copies stay through the
    // measured round, as in a formal run, so the disk peak is at least the formal one; completeRun deletes them.
    // Its receipt is never written as a backfill receipt, so a formal run cannot load it.
    const staging = `${out}/${stagingDirectory}`;
    phase('handoff', 'started');
    const snapshot = await rehearsalHandoff({
      systemIdentifier: currentSystemIdentifier,
      preserve: identifier => preserveSnapshot(container, out, identifier),
      stop: () => {
        docker('rm', '-f', container);
        docker('volume', 'rm', volume);
      },
      stage: async identity => {
        mkdirSync(staging, {mode: 0o700});
        return stageSnapshot(`${out}/${snapshotFile}`, identity, staging);
      },
      start: async directory => { await start(directory); },
      discard: () => discardRehearsalSnapshot(out),
    });
    assert.deepEqual(rlsFor('base'), rls, 'Restored cluster RLS differs');
    save(`${out}/rehearsal-handoff.json`, {label: rehearsalLabel, snapshot});
    phase('handoff', `finished (${snapshot.bytes} bytes)`);
  }
  save(`${out}/rls.json`, rls);
  if (mode === 'backfill-only') {
    const snapshot = await preserveSnapshot(container, out, currentSystemIdentifier());
    const receipt: BackfillReceipt = {manifestHash: sha256, snapshot, records, rls};
    save(`${out}/${receiptFile}`, receipt);
    save(`${out}/completed.json`, {...completion, backfillReceiptHash: hash(JSON.stringify(receipt))});
    return;
  }

  const restore = await restoreDrill(records.small.termRows);
  if (mode === 'rehearsal') stopUnlessWhole('restore drill', restore);
  rlsFor('denial');
  const accessChecks = await openApp('denial', async search => {
    await search(prepare(path.page));
    return denials(search);
  });
  if (mode === 'rehearsal') stopUnlessWhole('denial checks', accessChecks);
  owner('postgres', 'DROP DATABASE denial;');

  const {querySet} = conditions;
  const rounds: Round[] = [];
  const plans: Evidence['plans'] = [];
  let found: Evidence['complete'] = [];
  let measuredRls = '';
  // Rehearsal only: disk use through the measured round, projected onto the formal run's remaining rounds.
  const formalRounds = frozen.performance.rounds;
  const headroom = headroomSampler(mode === 'rehearsal', {
    docker: () => dfBytes(docker(...dockerDiskArgs(id, ownershipLabel))),
    output: () => outputDisk(out),
  }, samples => assertHeadroom(out, samples, formalRounds, conditions.rounds, save));
  for (let round = 1; round <= conditions.rounds; round++) {
    const dest = `${out}/round-${round}`;
    headroom.sample(`round ${round} start`);
    mkdirSync(dest);
    await resetMeasured(text => owner('postgres', text), async () => {
      docker('restart', container);
      await awaitReady();
    });
    save(`${dest}/rls.json`, rlsFor('measured'));
    phase(`round ${round}`, 'started');
    if (round === 1) measuredRls = directRls(text => app('measured', text));
    await recordedWarmup(`${dest}/warmup.json`, path.page, querySet, conditions.warmupSweeps,
      body => openApp('measured', body), mode === 'rehearsal');
    headroom.sample(`round ${round} after warm-up`);
    const latencies = await measureBlocks(querySet, (query, raw) => timeQuery(container, 'measured', path.page, query, raw,
      !accepts(query), `${dest}/${query}`, conditions.transactions, conditions.clients), result => {
      phase(`round ${round}`, 'p95' in result ? `${result.query} p95=${result.p95.toFixed(3)} ms` : `${result.query} ${result.sqlError}`);
      headroom.sample(`round ${round} after ${result.query}`);
    }, mode === 'rehearsal');
    rounds.push({round, latencies});
    save(`${dest}/latencies.json`, latencies);
    if (round === 1) {
      await openApp('measured', async search => {
        await search(prepare(path.page));
        for (const [query, raw] of querySet.filter(([id]) => accepts(id))) {
          const {explain, ...facts} = await explainPage(search, raw);
          plans.push({query, ...facts});
          save(`${dest}/${query}-plan.json`, explain);
        }
      });
      phase('completeness', 'started');
      found = await complete('measured');
      save(`${out}/completeness.json`, found);
      phase('completeness', 'finished');
    }
    headroom.sample(`round ${round} before dropping measured`);
    owner('postgres', 'DROP DATABASE measured;');
    headroom.sample(`round ${round} end`);
    phase(`round ${round}`, 'finished');
  }
  if (mode === 'rehearsal') assertHeadroom(out, headroom.samples, formalRounds, conditions.rounds, save);
  const denialReport = {...accessChecks, measuredRls};
  save(`${out}/denials.json`, denialReport);
  const evidence: Evidence = {valid: true, formal: mode === 'formal', backfill: records.base, rounds, plans, complete: found,
    denials: denialReport, restore};
  save(`${out}/evidence.json`, evidence);
  completeRun(out, mode, evidence, completion);
  phase('run', 'completed');
}

// completed.json is the worker's last write, and the supervisor publishes a valid status only after it.
// A rehearsal first deletes its archives and verifies that they are gone (runtime.ts cannot), so a failed
// deletion fails the worker and the supervisor records the run invalid, with no finished.json or summary.json.
export function completeRun(out: string, mode: Mode, evidence: Evidence, completion: object) {
  if (mode === 'rehearsal') {
    // Only completeness is kept; the formal judgement of rehearsal data is never computed or reported.
    const aggregationComplete = rehearsalComplete(evidence);
    save(`${out}/rehearsal.json`, {label: rehearsalLabel, aggregationComplete});
    assert.ok(aggregationComplete, 'Rehearsal evidence is incomplete for the formal aggregation');
    discardRehearsalSnapshot(out);
  }
  save(`${out}/completed.json`, completion);
}

// A rehearsal stops as soon as a recorded check is not whole (a pagination error, a hole), instead of
// after all benchmarks; rehearsalComplete would reject the same evidence at the end.
export function stopUnlessWhole(step: string, value: unknown) {
  if (!whole(value)) throw new Error(`${rehearsalLabel} INVALID: ${step} recorded an error or missing item; stopping`);
}

// A rehearsal stops at the first query block that is not fully sampled (PR #781 fail fast). The formal
// run keeps measuring, because the frozen judge counts a short-query SQL abort as a result.
export async function measureBlocks(querySet: readonly (readonly [string, string])[],
  time: (query: string, raw: string) => Promise<Sample>, report: (sample: Sample) => void, gate: boolean) {
  const latencies: Sample[] = [];
  for (const [query, raw] of querySet) {
    const result = await time(query, raw);
    latencies.push(result);
    report(result);
    if (gate && !fullySampled(result)) throw new Error(`${rehearsalLabel} INVALID: ${query} is not fully sampled; stopping`);
  }
  return latencies;
}

export type HandoffSteps = {
  systemIdentifier: () => string;
  preserve: (systemIdentifier: string) => Promise<BackfillReceipt['snapshot']>;
  stop: () => void;
  stage: (identity: BackfillReceipt['snapshot']) => Promise<string>;
  start: (directory: string) => Promise<void>;
  discard: () => void;
};

// The order keeps peak disk at the formal handoff's: the seeded cluster is removed before staging.
// On success both archive copies stay, as the formal run keeps its source and staged archives through
// the measured rounds; the worker deletes them before completing. A failed handoff ends the run and deletes them.
export async function rehearsalHandoff(steps: HandoffSteps) {
  try {
    const snapshot = await steps.preserve(steps.systemIdentifier());
    steps.stop();
    await steps.start(await steps.stage(snapshot));
    assert.equal(steps.systemIdentifier(), snapshot.systemIdentifier, 'Restored cluster identity differs');
    return snapshot;
  } catch (error) {
    try {
      steps.discard();
    } catch (discardError) {
      throw new AggregateError([error, discardError], 'Rehearsal handoff failed and its archives were not all deleted');
    }
    throw error;
  }
}

// Deletes only the archive copies, each attempted on its own and checked to be gone, and reports every
// failure. The staging directory stays while the container runs, because it is the container's bind
// mount and docker restart needs it; the CLI removes it at the end.
export function discardRehearsalSnapshot(out: string) {
  const failures: unknown[] = [];
  for (const archive of [`${out}/${snapshotFile}`, `${out}/${stagingDirectory}/${snapshotFile}`]) {
    try {
      rmSync(archive, {force: true});
      if (lstatSync(archive, {throwIfNoEntry: false})) throw new Error(`${archive} still exists after deletion`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, `Could not delete rehearsal archives: ${failures.join('; ')}`);
}

export async function resetMeasured(owner: (text: string) => string, restart: () => Promise<void>) {
  owner('CREATE DATABASE measured TEMPLATE base;');
  await restart();
}

export type WarmupError = {sweep: number; query: string; paginationError: string};
// Returns the warm-up pagination errors, which the worker records. A rehearsal stops at the first one;
// the formal run keeps going, because no frozen check reads the warm-up.
export async function warmup(page: string, querySet: readonly (readonly [string, string])[], sweeps: number,
  open: (body: (sql: Sql) => Promise<void>) => Promise<void>, gate = false, errors: WarmupError[] = []) {
  for (let sweep = 1; sweep <= sweeps; sweep++) {
    for (const [query, raw] of querySet) {
      await open(async search => {
        await search(prepare(page));
        const {paginationError} = await allPages(search, [1, 2], raw, {}, true);
        if (paginationError) errors.push({sweep, query, paginationError});
      });
      if (gate && errors.length) {
        throw new Error(`${rehearsalLabel} INVALID: warm-up ${query}: ${errors[0].paginationError}; stopping`);
      }
    }
  }
  return errors;
}

// Writes the warm-up records to file even when the warm-up stops a rehearsal or fails, including the failing one.
export async function recordedWarmup(file: string, ...args: Parameters<typeof warmup>) {
  const [page, querySet, sweeps, open, gate] = args;
  const errors: WarmupError[] = [];
  try {
    return await warmup(page, querySet, sweeps, open, gate, errors);
  } finally {
    save(file, errors);
  }
}

// The supervisor has already written run-status.json. If the rehearsal archives are still on disk here
// (the worker failed before deleting them, and this last attempt failed too), the status must not claim
// a verified cleanup: mark it invalid and drop any finished.json or summary.json.
export function invalidateUncleanRun(out: string) {
  rmSync(`${out}/finished.json`, {force: true});
  rmSync(`${out}/summary.json`, {force: true});
  const file = `${out}/run-status.json`;
  const status = lstatSync(file, {throwIfNoEntry: false}) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeFileSync(file, JSON.stringify({...status, valid: false, cleanupVerified: false, exitCode: status.exitCode || 1}) + '\n');
}

// The CLI's last step: deletes the rehearsal archives again and always removes the staging directory.
// Returns false when an archive could not be deleted; the run status is then already invalid.
export function cleanUpRun(out: string, mode: Mode, staged: boolean) {
  let clean = true;
  try {
    if (mode === 'rehearsal') {
      try {
        discardRehearsalSnapshot(out);
      } catch (error) {
        console.error(String(error));
        invalidateUncleanRun(out);
        clean = false;
      }
    }
  } finally {
    if (staged || mode === 'rehearsal') rmSync(`${out}/${stagingDirectory}`, {recursive: true, force: true});
  }
  return clean;
}

async function main() {
  const isWorker = process.env.SEARCH_WORKER === '1';
  const args = isWorker ? workerOptions(process.env, process.argv.slice(2), process.ppid) : options(process.argv.slice(2));
  assert.ok(['smoke', 'rehearsal', 'backfill-only', 'formal', 'cleanup'].includes(args.mode));
  const manifest = loadManifest();
  const {rows, restoreRows} = manifest.frozen.performance;
  if (args.mode === 'cleanup') {
    assert.ok(args.fromBackfill);
    const source = await loadBackfill(args.fromBackfill, manifest.sha256, rows, restoreRows);
    removeSnapshot(source.directory);
    note(`Removed preserved backfill snapshot from ${source.directory}`);
    return;
  }
  const out = isWorker ? args.output : outputPath(args.output ?? `/private/tmp/fukulow-d3r-689-${Date.now()}`);
  assert.ok(out);
  const restoreDirectory = `${out}/${stagingDirectory}`;
  const fromBackfill = args.fromBackfill && resolve(args.fromBackfill);
  process.chdir(root);
  if (isWorker) {
    let source;
    if (fromBackfill) {
      mkdirSync(restoreDirectory, {mode: 0o700});
      source = await loadBackfill(fromBackfill, manifest.sha256, rows, restoreRows, restoreDirectory);
    }
    await worker(args.mode, out, manifest, source);
    return;
  }
  if (args.mode === 'smoke') process.env.SEARCH_SMOKE = '1';
  else delete process.env.SEARCH_SMOKE;
  refuseLeftovers(docker);
  mkdirSync(out, {mode: 0o700});
  process.env.SEARCH_D3R_LAUNCH = writeLaunch(out, args.mode, fromBackfill).token;
  process.env.SEARCH_D3R_MODE = args.mode;
  process.env.SEARCH_D3R_OUT = out;
  if (fromBackfill) process.env.SEARCH_D3R_FROM = fromBackfill;
  else delete process.env.SEARCH_D3R_FROM;
  try {
    await supervise(import.meta.url, out, manifest.sha256, () => {
      const run = JSON.parse(readFileSync(`${out}/run-status.json`, 'utf8'));
      assert.ok(run.valid && run.cleanupVerified && run.manifestHash === manifest.sha256);
      const status = args.mode === 'formal'
        ? judge(JSON.parse(readFileSync(`${out}/evidence.json`, 'utf8'))) : 'NOT EVALUATED';
      save(`${out}/summary.json`, {status, mode: args.mode, manifestHash: manifest.sha256, label: runLabel(args.mode)});
      note(`${status} (${out}/summary.json)`);
    });
  } finally {
    if (!cleanUpRun(out, args.mode, Boolean(fromBackfill))) process.exitCode = 1;
  }
  if (process.exitCode) note('NOT EVALUATED (run or cleanup incomplete)');
}

if (import.meta.main) await main();
