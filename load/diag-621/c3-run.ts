// Harness history (#621 C3):
// - 2026-11-21 (#961, b04a5288): C3 diagnostic harness for the send path.
// - 2026-11-26 (#1034): the first smoke stays INVALID (#621 comment 7172147501). Autovacuum of system catalogs, triggered
//   by CREATE DATABASE, ran in 3 windows, and 2 more were INVALID through their INVALID paired base. Each clone and the
//   seed now get VACUUM (ANALYZE) of every connectable database's catalogs, then a plain VACUUM of pg_statistic, and the
//   run waits until autovacuum has finished, before the app starts (c3-catalog-settle.ts). Every attempt, failed ones
//   included, goes into manifest.json and the window's catalog-settle.json. Measurement conditions, INVALID rules and
//   evaluation criteria are unchanged.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { seed, type Stack } from '../slice5/stack.ts';
import { deadlineMs, measuredSeconds, prepareWindow, rate, schedule, type Window } from './c3-plan.ts';
import { verifyPins, verifySmoke, type Pin, type Pins } from './c3-pins.ts';
import { countChecks, disableMaintenance, fixtureChecks, fixtureReasons, maintenanceReasons, maintenanceSQL,
  settleFixture, shapeSQL, workersSQL, type Maintenance, type Workers } from './c3-fixture.ts';
import { connectionEvidence, logSettings, parseTraffic } from './c3-logs.ts';
import { settleCatalogs, settleRecorder, type CatalogSettle } from './c3-catalog-settle.ts';
import { c3ExitCode, summarizeC3, type WindowResult } from './c3-summary.ts';
import { evictionReason, statementEvidence, statementSQL } from './c3-statements.ts';
import { cpuWindow, DrainPending, latency, loadBoundaries, storageCoverage, storageReason, trafficReasons } from './c3-timing.ts';
import { bounded, dump, json, read, runtime, ticks } from './c3-runtime.ts';
import { decide, type Statement } from './validity.ts';
import { checkpoint, controlSQL, walCheckpoints, type Control } from './window.ts';

const [outputArg, pinsArg, mode, smokeArg, warmArg, ...extra] = process.argv.slice(2);
const smoke = mode === '--smoke';
if (!outputArg || !pinsArg || extra.length || !(smoke && !smokeArg && !warmArg || mode === '--full' && smokeArg && ['3', '10'].includes(warmArg))) {
  console.error('INVALID: usage: c3-run.ts <new-output-dir> <pins.json> (--smoke | --full <smoke-summary.json> <3|10>)');
  process.exit(1);
}

const started = performance.now(), deadline = started + deadlineMs, output = resolve(outputArg);
mkdirSync(output, { mode: 0o700 });
const scratch = mkdtempSync(resolve(tmpdir(), 'diag621-c3-'));
const interrupt = new AbortController();
const onInterrupt = (signal: NodeJS.Signals) => interrupt.abort(new Error(`run interrupted by ${signal}`));
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
const signal = interrupt.signal;
const namespace = `fk621c3-${randomUUID().slice(0, 12)}`, pg = `${namespace}-pg`;
const label = `io.fukulow.diag621c3=${namespace}`;
const runtimeEnv = runtime(deadline, pg, label, signal);
const { active, docker, sql, wait } = runtimeEnv;
const pgImage = 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42';
const k6Image = 'grafana/k6:2.4.0@sha256:d41bb79cd8de5a7ad619b53570e3712633e8bff0937010a5c6c57a4747e7a276';
const observerImage = 'node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc';
const password = randomUUID(), setupToken = randomUUID();
const warmSeconds = smoke ? 3 : Number(warmArg);
const plan = schedule(smoke), problems: string[] = [], results: WindowResult[] = [];
const storageFile = resolve(output, 'tmpfs.ndjson');
const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', timeout: active() });
const databaseEnv = (role: string, db: string) => ['-e', `DATABASE_URL=postgres://${role}:${password}@${pg}:5432/${db}`];
const source = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const reason = (error: unknown) => (error instanceof SyntaxError ? 'malformed diagnostic evidence' : (error as Error).message)
  .replaceAll(password, '[redacted]').replaceAll(setupToken, '[redacted]');
let pins: Pins, recordedPins: Pins | undefined, dbStarted = false, networkStarted = false;
const manifest: Record<string, unknown> = {}, catalogSettles: CatalogSettle[] = [];
const settle = (stage: string, windowFile?: string) => settleCatalogs(stage, sql, { capMs: Math.min(60000, active()), signal,
  report: settleRecorder(catalogSettles, (settles, latest) => {
    dump(resolve(output, 'manifest.json'), { ...manifest, catalogSettles: settles });
    if (windowFile) dump(windowFile, latest);
  }) });

const stop = runtimeEnv.remove;

async function appStart(name: string, db: string, pin: Pin) {
  docker('start independently pinned app', ['run', '--pull=never', '-d', '--name', name, '--label', label, '--network', namespace,
    '--network-alias', 'fk621-app', '-p', '127.0.0.1::8080', ...databaseEnv('fukulow_app', db), '-e', 'FUKULOW_ADDR=0.0.0.0:8080',
    '-e', 'FUKULOW_COOKIE_SECURE=false', '-e', `FUKULOW_SETUP_TOKEN=${setupToken}`, '-e', 'FUKULOW_SEND_BURST=10',
    '-e', 'FUKULOW_SEND_REFILL_PER_SECOND=1', pin.imageId]);
  if (docker('inspect running app image', ['inspect', '--format', '{{.Image}}', name]) !== pin.imageId) throw new Error('running app image mismatch');
  const port = docker('read app port', ['port', name, '8080/tcp']).split(':').at(-1);
  const url = `http://127.0.0.1:${port}`;
  await wait('app readiness', async () => {
    const response = await fetch(url + '/api/v1/ready', { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(1000, active()))]) }).catch(() => null);
    await response?.body?.cancel();
    return response?.ok;
  });
  return url;
}

function observe(name: string, path: string, app?: string) {
  return runtimeEnv.task(['run', '--pull=never', '--rm', '--name', name, '--label', label, '--network', 'none', '--read-only',
    '--pid=host', '--cgroupns=host', '--cap-drop=ALL', '--cap-add=SYS_PTRACE',
    '-v', `${source('./c3-observer.ts')}:/observer.ts:ro`, observerImage, 'node', '--experimental-strip-types', '/observer.ts',
    runtimeEnv.pid(pg), ...(app ? [runtimeEnv.pid(app)] : [])], path);
}

async function traffic(dir: string, fixture: string, stage: string, seconds: number) {
  const name = `${namespace}-${stage}`, path = resolve(dir, `k6-${stage}.log`), points = `k6-${stage}-points.ndjson`;
  const task = runtimeEnv.task(['run', '--pull=never', '--rm', '--name', name, '--label', label, '--user', '0:0', '--network', namespace,
    '-v', `${fixture}:/fixture.json:ro`, '-v', `${source('./c3-driver.ts')}:/driver.ts:ro`, '-v', `${dir}:/evidence`,
    '-e', `SECONDS=${seconds}`, k6Image, 'run', '--quiet', '--no-color', '--log-output=stdout', '--log-format=raw',
    '--out', `json=/evidence/${points}`, '/driver.ts'], path);
  try {
    const exit = await bounded(task.done, Math.min(90000, active()), signal, `k6 ${stage} timed out`);
    if (exit !== 0) throw new Error(`k6 ${stage} exited ${exit}`);
  } catch (error) {
    task.stop();
    try { stop(name); } catch (cleanup) { problems.push(reason(cleanup)); }
    throw error;
  }
  return parseTraffic(read(path), read(resolve(dir, points)));
}

const walSQL = `SELECT json_build_object('records',wal_records,'fpi',wal_fpi,'bytes',wal_bytes) FROM pg_stat_wal;`;
type Wal = { records: number; fpi: number; bytes: number };
type ShapeEvidence = { constraints: unknown; inline: boolean; heap_bytes: number; index_bytes: number };
type Fixture = Awaited<ReturnType<typeof seed>> & { count: number; shape: ShapeEvidence };

async function prepareSeed(): Promise<Fixture> {
  sql('postgres', 'CREATE DATABASE seed_base;', 'create shared seed');
  docker('migrate seed using base image', ['run', '--pull=never', '--rm', '--label', label, '--network', namespace,
    ...databaseEnv('fukulow', 'seed_base'), '-e', `POSTGRES_APP_PASSWORD=${password}`, '--entrypoint', 'fukulow-server', pins.base.imageId, 'migrate']);
  sql('seed_base', 'CREATE EXTENSION pg_stat_statements;', 'install statement statistics');
  const name = `${namespace}-seed`, url = await appStart(name, 'seed_base', pins.base);
  const seedLimit = active();
  const seeded = await bounded(seed({ base: url, env: { LOAD_SETUP_TOKEN: setupToken },
    sql: (query: string) => sql('seed_base', query, 'seed Members and Sessions') } as unknown as Stack),
  seedLimit, signal, 'run reached its 60 minute hard stop while seeding');
  stop(name);
  const { organization, channels } = seeded;
  sql('seed_base', settleFixture(organization, channels), 'prefill, backfill and settle seed');
  const fixture = json<Record<string, number>>(sql('seed_base', fixtureChecks, 'check seed terms and Unread counts'));
  const counts = json<Record<string, number>>(sql('seed_base', countChecks, 'check seed integrity'));
  const shape = json<ShapeEvidence>(sql('seed_base', shapeSQL, 'read seed channel_log shape'));
  const used = ticks(storageFile).map(row => row.used), storage = storageReason(used);
  dump(resolve(output, 'seed.json'), { fixture, counts, shape, peakTmpfsBytes: Math.max(0, ...used) });
  const why = fixtureReasons(fixture, counts, 20000);
  if (storage) why.push(storage);
  if (why.length) throw new Error(why.join('; '));
  return { ...seeded, count: 20000, shape };
}

function monitor(dir: string) {
  const samples: Workers[] = [];
  let stopped = false, failure: unknown;
  const done = (async () => {
    while (!stopped) {
      const row = json<Workers>(await runtimeEnv.asyncSQL('postgres', workersSQL));
      samples.push(row);
      appendFileSync(resolve(dir, 'maintenance.ndjson'), JSON.stringify(row) + '\n');
      await sleep(250);
    }
  })().catch(error => { failure = error; });
  return { samples, async stop() { stopped = true; await done; if (failure) throw failure; } };
}

async function windowRun(window: Window, seedFixture: Fixture): Promise<WindowResult> {
  const dir = resolve(output, window.id), app = `${namespace}-app`, observer = `${namespace}-cpu`;
  const fixtureFile = resolve(scratch, 'fixture.json'), cpuPath = resolve(dir, 'cpu.ndjson');
  mkdirSync(dir);
  const result: WindowResult = { window, reasons: [] };
  const record = (name: string, value: unknown) => { dump(resolve(dir, `${name}.json`), value); return value; };
  let appUp = false, clone: string | undefined, cpuUp = false, storageStart = 0, worker: ReturnType<typeof monitor> | undefined;
  try {
    storageStart = ticks(storageFile).length;
    const { organization, channels, tokens } = seedFixture;
    dump(fixtureFile, { organization, channels: window.shape === 'hot-17' ? channels.slice(0, 1) : channels, tokens });
    const db = await prepareWindow(window, {
      clone(name) {
        sql('postgres', 'CHECKPOINT;', 'checkpoint before sample clone');
        sql('postgres', `CREATE DATABASE ${name} TEMPLATE seed_base;`, 'clone settled seed');
        clone = name;
      },
      disableMaintenance: name => { sql(name, disableMaintenance, 'disable automatic maintenance on clone'); },
      settle: () => settle(window.id, resolve(dir, 'catalog-settle.json')),
      async restart(arm, name) { appUp = true; await appStart(app, name, pins[arm]); },
    });
    const cpuTask = observe(observer, cpuPath, app);
    cpuUp = true;
    await wait('first cgroup sample', () => ticks(cpuPath).length);
    const maintenanceBefore = json<Maintenance[]>(sql(db, maintenanceSQL, 'read before-window maintenance counters'));
    record('maintenance-before', maintenanceBefore);
    worker = monitor(dir);
    await wait('first maintenance sample', () => worker?.samples.length);
    sql(db, `DO $$ BEGIN RAISE LOG 'C3_COVERAGE_BEGIN'; END $$;`, 'write begin marker');
    const warm = await traffic(dir, fixtureFile, 'warm', warmSeconds);
    result.reasons.push(...trafficReasons(warm, false));
    const cp = checkpoint((query, operation) => sql('postgres', query, operation));
    record('checkpoint', cp);
    if (!cp.ok) throw new Error(`checkpoint: ${cp.reason}`);
    sql(db, 'SELECT pg_stat_statements_reset();', 'reset statement statistics');
    const controlBefore = json<Control>(sql(db, controlSQL, 'read control before measured sends'));
    const walBefore = json<Wal>(sql(db, walSQL, 'read WAL statistics before measured sends'));
    const dealloc = () => Number(sql(db, 'SELECT dealloc FROM pg_stat_statements_info;', 'read statement eviction count'));
    const deallocBefore = dealloc();
    record('measurement-before', { controlBefore, walBefore, deallocBefore });
    const trafficMeasured = await traffic(dir, fixtureFile, 'measure', measuredSeconds);
    result.reasons.push(...trafficReasons(trafficMeasured, true));
    const { start: warmStart, first, last } = loadBoundaries(warm, trafficMeasured);
    const cpu = await wait('coverage through the drain', () => {
      try { return cpuWindow(ticks(cpuPath), warmStart, first, last); }
      catch (error) { if (error instanceof DrainPending) return; throw error; }
    }, 3500);
    record('cpu-window', cpu);
    if (cpu.app.usec <= 0) result.reasons.push('app CPU use not captured');
    sql(db, `DO $$ BEGIN RAISE LOG 'C3_COVERAGE_END'; END $$;`, 'write after-drain marker');
    const controlAfter = json<Control>(sql(db, controlSQL, 'read control after measured sends'));
    const walAfter = json<Wal>(sql(db, walSQL, 'read WAL statistics after measured sends'));
    const statWal = { records: walAfter.records - walBefore.records, fpi: walAfter.fpi - walBefore.fpi, bytes: walAfter.bytes - walBefore.bytes };
    const statementInfo = { dealloc: dealloc() };
    record('measurement-after', { controlAfter, walAfter, statWal, statementInfo });
    const eviction = evictionReason(deallocBefore, statementInfo.dealloc);
    if (eviction) result.reasons.push(eviction);
    const statements = json<Statement[]>(sql(db, statementSQL, 'read app statement statistics'));
    record('pg_stat_statements', statements);
    const wal = walCheckpoints((query, operation) => sql('postgres', query, operation), cp.before.lsn, controlAfter.lsn);
    record('checkpoint-wal', wal);
    if (!wal.ok) throw new Error(wal.reason);
    if (typeof controlBefore.lsn !== 'string' || !/^[\dA-F]{1,8}\/[\dA-F]{1,8}$/.test(controlBefore.lsn)) throw new Error('measured WAL start malformed');
    const walBytes = Number(sql(db, `SELECT pg_wal_lsn_diff('${wal.to}','${controlBefore.lsn}');`, 'read WAL LSN delta'));
    await worker.stop();
    worker = undefined;
    const lastWorker = json<Workers>(sql('postgres', workersSQL, 'read after-drain worker sample'));
    const samples = read(resolve(dir, 'maintenance.ndjson')).trim().split('\n').map(line => json<Workers>(line));
    samples.push(lastWorker);
    const maintenanceAfter = json<Maintenance[]>(sql(db, maintenanceSQL, 'read after-window maintenance counters'));
    record('maintenance-after', { maintenanceAfter, lastWorker });
    result.reasons.push(...maintenanceReasons(maintenanceBefore, maintenanceAfter, samples, warm.scenario, cpu.endWallMs));
    stop(observer);
    cpuUp = false;
    await bounded(cpuTask.done, Math.min(5000, active()), signal, 'CPU sampler did not exit after removal');
    stop(app);
    appUp = false;
    const log = connectionEvidence(runtimeEnv.logs(), db, warm.scenario, first, cpu.endWallMs);
    record('connections', log);
    result.late = log.late.length > 0;
    if (log.automaticMaintenance.length) result.reasons.push('automatic maintenance logged in the window');
    const fixture = json<Record<string, number>>(sql(db, fixtureChecks, 'verify exact search terms and Unread counts'));
    const counts = json<Record<string, number>>(sql(db, countChecks, 'verify write totals and integrity'));
    const shapeAfter = json<ShapeEvidence>(sql(db, shapeSQL, 'read clone channel_log shape'));
    const { load } = trafficMeasured, accepted = load.accepted;
    const expected = seedFixture.count + warm.load.accepted + accepted;
    const checks = fixtureReasons(fixture, counts, expected);
    const verification = { shapeAfter, verified: checks.length === 0 && shapeAfter.inline === false
      && JSON.stringify(shapeAfter.constraints) === JSON.stringify(seedFixture.shape.constraints) };
    record('verification', { ...verification, fixture, counts, expected });
    result.reasons.push(...checks, ...decide({ id: window.id, valid: true, reasons: [], checkpoint: cp, warmup: warm.load,
      walCheckpoints: wal, measured: { accepted, load, controlBefore, controlAfter, cpuUsec: cpu.db.usec, walBytes, statWal, statementInfo },
      verification }, statements).reasons);
    result.statements = statementEvidence(statements, accepted);
    const latencyUsec = latency(trafficMeasured.requests, first);
    record('latency', latencyUsec);
    result.metrics = { dbCpuUsec: cpu.db.usec / accepted, appCpuUsec: cpu.app.usec / accepted, executorUsec: result.statements.executorUsec,
      latencyP50Usec: latencyUsec.all.p50, latencyP95Usec: latencyUsec.all.p95, walBytes: walBytes / accepted,
      walRecords: statWal.records / accepted, walFpi: statWal.fpi / accepted };
  } catch (error) { result.reasons.push(reason(error)); }
  finally {
    const cleanupStep = async (action: () => unknown) => {
      try { await action(); } catch (error) { const why = reason(error); result.reasons.push(why); problems.push(why); }
    };
    await cleanupStep(() => worker?.stop());
    if (cpuUp) await cleanupStep(() => stop(observer));
    if (appUp) await cleanupStep(() => stop(app));
    await cleanupStep(() => {
      const samples = ticks(storageFile).slice(Math.max(0, storageStart - 1));
      const used = samples.map(row => row.used);
      record('tmpfs', { samples, peakBytes: Math.max(0, ...used) });
      const storage = storageReason(used);
      if (storage) result.reasons.push(storage);
      if (!storageCoverage(samples, Date.now())) result.reasons.push('tmpfs sampling did not cover the window');
    });
    if (clone) await cleanupStep(() => sql('postgres', `DROP DATABASE ${clone};`, 'drop clone'));
    record('result', result);
  }
  return result;
}

try {
  const busy = process.env.FUKULOW_HOST_BUSY;
  if (!busy || !existsSync(busy) || !process.env.FUKULOW_LAUNCH_JOB) throw new Error('run requires the approved launcher and its HOST-BUSY marker');
  pins = json<Pins>(read(resolve(pinsArg)));
  recordedPins = pins;
  Object.assign(manifest, { smoke, warmSeconds, rate, measuredSeconds, schedule: plan, pins, pgImage, k6Image, observerImage, logSettings });
  dump(resolve(output, 'manifest.json'), manifest);
  if (!smoke) verifySmoke(json(read(resolve(smokeArg))), pins, warmSeconds);
  verifyPins(pins, git, image => json(docker('inspect pinned image', ['image', 'inspect', '--format',
    '{"id":{{json .Id}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}', image])),
  (arm, evidence) => dump(resolve(output, `pin-${arm}.json`), evidence));
  docker('create private network', ['network', 'create', '--label', label, namespace]);
  networkStarted = true;
  const deploy = resolve(git(['rev-parse', '--show-toplevel']).trim(), 'deploy');
  const mounts = ['db-roles.sql', 'db-role-settings.sql', 'db-grants.sql'].flatMap(file => ['-v', `${deploy}/${file}:/opt/fukulow/${file}:ro`]);
  docker('start disposable PostgreSQL', ['run', '--pull=never', '-d', '--name', pg, '--label', label, '--network', namespace,
    '--tmpfs', '/var/lib/postgresql:rw,size=2147483648', '-e', 'POSTGRES_USER=fukulow', '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', `POSTGRES_APP_PASSWORD=${password}`, '-v', `${deploy}/init-db-roles.sh:/docker-entrypoint-initdb.d/10-db-roles.sh:ro`,
    ...mounts, pgImage, 'postgres', ...['shared_preload_libraries=pg_stat_statements', 'pg_stat_statements.track=all',
      'max_wal_size=8GB', 'checkpoint_timeout=30min', ...logSettings].flatMap(setting => ['-c', setting])]);
  dbStarted = true;
  await wait('PostgreSQL TCP readiness', () => {
    try { docker('probe TCP readiness', ['exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'fukulow', '-d', 'postgres']); return true; }
    catch { return false; }
  });
  observe(`${namespace}-storage`, storageFile);
  await wait('first tmpfs sample', () => ticks(storageFile).length);
  sql('postgres', 'CREATE EXTENSION pg_walinspect; ALTER ROLE fukulow_app SET pg_stat_statements.track_planning=off;', 'enable checkpoint evidence');
  const seedFixture = await prepareSeed();
  if (sql('seed_base', 'SHOW pg_stat_statements.track_planning;', 'verify app planning setting', 'fukulow_app') !== 'off') throw new Error('planning tracking mismatch');
  await settle('after seed');
  for (const window of plan) {
    active();
    console.log(`Window ${window.index}/${plan.length}: ${window.id}`);
    results.push(await windowRun(window, seedFixture));
    dump(resolve(output, 'progress.json'), results);
    if (problems.length) break;
  }
  active();
} catch (error) { problems.push(reason(error)); }
finally {
  if (dbStarted) {
    try { writeFileSync(resolve(output, 'postgres.log'), runtimeEnv.logs(15000)); }
    catch (error) { problems.push(reason(error)); }
  }
  if (networkStarted) try { runtimeEnv.cleanup(); } catch (error) { problems.push(reason(error)); }
  if (signal.aborted && !problems.includes(reason(signal.reason))) problems.push(reason(signal.reason));
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  rmSync(scratch, { recursive: true, force: true });
  const summary = summarizeC3(smoke, results, problems);
  dump(resolve(output, 'summary.json'), { ...summary, pins: recordedPins, elapsedSeconds: (performance.now() - started) / 1000 });
  for (const row of summary.windows) dump(resolve(output, row.window.id, 'result.json'), row);
  if (!summary.valid) console.error('INVALID: see summary.json and the retained raw evidence');
  else if ('primary' in summary) console.log(JSON.stringify(summary.primary));
  else if ('warmSeconds' in summary) console.log(`Smoke selected ${summary.warmSeconds} s warm-up; no reading.`);
  process.exitCode = c3ExitCode(summary);
}
