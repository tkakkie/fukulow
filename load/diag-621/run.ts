// #621 C1/C2 diagnostic runner (diagnosis only, no PASS/FAIL). Ported from the 2026-11-23 local
// harness: one app image (post-#677, fk621d:post), measurement-only SQL overlays applied to disposable
// clones only, warm app, planning tracking off, many-17 and hot-17, tmpfs. Changes approved on
// 2026-11-24: rotated arm order (plan.ts), an explicit checkpoint before every measured window
// (window.ts), and FPI, WAL, DB CPU and executor time reported separately (summary.ts). Added before any
// run: a checkpoint start or completion in WAL during the window makes it INVALID (pg_walinspect in the
// maintenance database only, so the measured fixture is unchanged), and one validity decision (validity.ts).
// Usage: node load/diag-621/run.ts <new-output-dir> <build-dir> [--smoke]
// <build-dir> holds the image's `revision` file and its `deploy/` directory.
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { autovacuumSQL, channelLogSQL, checksumSQL, prefillSQL, settleSQL } from '../slice5/fixture.ts';
import { seed, type Stack } from '../slice5/stack.ts';
import { conditions, OVERLAY_ARMS, PHASES, windows, type Window } from './plan.ts';
import { summarize } from './summary.ts';
import { decide, type Statement } from './validity.ts';
import { checkpoint, controlSQL, runWindow, walCheckpoints, type Control, type WindowResult } from './window.ts';

const [outputArg, buildArg, ...flags] = process.argv.slice(2);
if (!outputArg || !buildArg || flags.some(f => f !== '--smoke')) throw new Error('usage: run.ts <new-output-dir> <build-dir> [--smoke]');
const output = resolve(outputArg), build = resolve(buildArg), smoke = flags.includes('--smoke');
const { rate, warmSeconds, measuredSeconds } = conditions(smoke);
mkdirSync(output, { mode: 0o700 });
const scratch = mkdtempSync(resolve(output, '.scratch.'));
const owner = `fk621c-${scratch.slice(-6).toLowerCase()}`;
const label = 'io.fukulow.diag621c12=' + owner;
const pg = 'fk621c-pg';
const pgImage = 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42';
const k6Image = 'grafana/k6:1.8.2';
const imageTag = 'fk621d:post';
// The post-#677 image of the 2026-11-23 run (#621): squash revision and the image ID it recorded.
const pinnedRevision = 'f7c9e2d3a56d9a16b39e5212a6ac6f8197eea5e9';
const pinnedImageId = 'sha256:c159dc07304bf2a80ec5c151ed3ffaca7db4a98a6b829066ff70d2133db5a511';
const password = randomUUID(), setupToken = randomUUID();
const fixturePath = resolve(scratch, 'fixture.json');
const driverPath = fileURLToPath(new URL('./driver.ts', import.meta.url));
const fixtures: Record<string, { shape: Shape }> = {};
const checksums: Record<string, string> = {};
let base: { organization: string; channels: string[]; tokens: string[]; seeded: number };
let blocks: Record<string, string>;
let image: { tag: string; revision: string; id: string };
type Shape = { constraints: unknown; indexes: number; inline_digest: boolean; heap_bytes: number; index_bytes: number };
const asyncRun = promisify(execFile);
const dump = (dir: string, name: string, data: unknown) => writeFileSync(resolve(dir, name), JSON.stringify(data, null, 2) + '\n');
const dbEnv = (role: string, db: string) => ['-e', `DATABASE_URL=postgres://${role}:${password}@${pg}:5432/${db}`];

function docker(operation: string, args: string[], input?: string) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 180000 });
  if (result.status !== 0) {
    // psql runs with VERBOSITY=verbose, so a server error line carries its SQLSTATE.
    const line = (result.stderr ?? '').split('\n').find(l => /^(psql:[^ ]* )?(ERROR|FATAL|PANIC): /.test(l));
    const detail = line ? `: ${line.replace(/^psql:[^ ]* /, '').split(password).join('***').slice(0, 240)}` : '';
    throw new Error(`${operation} failed (Docker ${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.signal ?? result.status})${detail}`);
  }
  return result.stdout.trim();
}
const psql = (db: string, sql: string, operation = 'psql', role = 'fukulow') => docker(operation,
  ['exec', '-i', pg, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-U', role, '-d', db], sql);
// Storage and the backends attached to the template, without query text, for a failed seed clone.
function cloneDiagnostics() {
  const probe = (name: string, f: () => string) => { try { return f(); } catch (error) { return `${name} unavailable: ${(error as Error).message}`; } };
  return JSON.stringify({
    storage: probe('df', () => docker('read PostgreSQL storage', ['exec', pg, 'df', '-k', '/var/lib/postgresql'])),
    templateBackends: probe('pg_stat_activity', () => psql('postgres', `SELECT coalesce(json_agg(json_build_object('type', backend_type,
      'state', state, 'app', application_name)), '[]') FROM pg_stat_activity WHERE datname = 'seed_base';`, 'read template backends')),
    databases: probe('sizes', () => psql('postgres', `SELECT json_object_agg(datname, pg_database_size(datname)) FROM pg_database
      WHERE datname LIKE 'seed_%';`, 'read database sizes')),
  });
}
const port = (container: string, internal: string) => docker('port lookup', ['port', container, internal]).split(':').at(-1);
const cpu = () => {
  const usage = /^usage_usec (\d+)$/m.exec(docker('DB cgroup CPU sample', ['exec', pg, 'cat', '/sys/fs/cgroup/cpu.stat']));
  if (!usage) throw new Error('cgroup v2 usage_usec unavailable');
  return Number(usage[1]);
};

function overlays(text: string) {
  const out: Record<string, string> = {};
  for (const part of text.split(/^-- @arm /m).slice(1)) {
    const [name, ...body] = part.split('\n');
    out[name.trim()] = body.join('\n').trim();
  }
  return out;
}

async function waitFor(description: string, test: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 60; i++) {
    if (await test()) return;
    await sleep(250);
  }
  throw new Error(`${description} did not become ready`);
}

type App = { id: string; base: string };
async function startApp(arm: string, db: string): Promise<App> {
  const id = docker(`start ${arm} app`, ['run', '--pull=never', '-d', '--label', label, '--network', owner,
    '--network-alias', 'fk621-app', '-p', '127.0.0.1::8080', ...dbEnv('fukulow_app', db),
    '-e', 'FUKULOW_ADDR=0.0.0.0:8080', '-e', 'FUKULOW_COOKIE_SECURE=false',
    '-e', `FUKULOW_SETUP_TOKEN=${setupToken}`, '-e', 'FUKULOW_SEND_BURST=10',
    '-e', 'FUKULOW_SEND_REFILL_PER_SECOND=1', image.id]);
  const url = `http://127.0.0.1:${port(id, '8080')}`;
  await waitFor(`${arm} app`, async () => {
    const r = await fetch(url + '/api/v1/ready', { signal: AbortSignal.timeout(1000) }).catch(() => null);
    await r?.body?.cancel();
    return r?.ok ?? false;
  });
  return { id, base: url };
}
function stopApp(app: App) {
  docker('stop app', ['stop', '--time', '10', app.id]);
  docker('remove app', ['rm', '-v', app.id]);
}

const walSQL = `SELECT json_build_object('records',wal_records,'fpi',wal_fpi,'bytes',wal_bytes) FROM pg_stat_wal;`;
type Wal = { records: number; fpi: number; bytes: number };
type Load = { seconds: number; rate: number; elapsedMs: number; attempts: number; accepted: number; errors: number;
  iterations: number; dropped: number; metrics: unknown };
async function generate(dir: string, seconds: number, window: string): Promise<Load> {
  const start = performance.now();
  let stdout: string;
  try {
    ({ stdout } = await asyncRun('docker', ['run', '--pull=never', '--rm', '--label', label, '--user', '0:0', '--network', owner,
      '-v', `${fixturePath}:/fixture.json:ro`, '-v', `${driverPath}:/driver.ts:ro`,
      '-e', `RATE=${rate}`, '-e', `SECONDS=${seconds}`, k6Image, 'run', '--quiet', '--no-color', '/driver.ts'],
      { timeout: 90000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { signal?: string };
    throw new Error(`k6 ${window} failed (${e.code ?? e.signal ?? 'unknown'})`);
  }
  const result = /^DIAG_RESULT (.+)$/m.exec(stdout);
  if (!result) throw new Error(`k6 ${window} summary missing`);
  const metrics = JSON.parse(result[1]);
  const count = (name: string): number => metrics[name]?.values.count ?? 0;
  const attempts = count('send_status'), errors = count('send_failures');
  const sample = { seconds, rate, elapsedMs: performance.now() - start, attempts, accepted: attempts - errors, errors,
    iterations: count('iterations'), dropped: count('dropped_iterations'), metrics };
  dump(dir, `k6-${window}.json`, sample);
  return sample;
}

// JSON instead of the earlier CSV; the same columns.
const statementSQL = `SELECT coalesce(json_agg(s ORDER BY s.toplevel DESC, s.total_exec_time DESC, s.queryid), '[]') FROM (
  SELECT rolname, toplevel, queryid::text AS queryid, calls, plans, total_plan_time, total_exec_time, rows, wal_records, wal_bytes, wal_fpi, query
  FROM pg_stat_statements JOIN pg_roles ON userid=pg_roles.oid
  WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND rolname='fukulow_app') s;`;
const shapeSQL = `SELECT json_build_object(
  'constraints',(SELECT json_agg(json_build_object('type',contype,'refs',confrelid::regclass::text) ORDER BY contype, confrelid::regclass::text)
    FROM pg_constraint WHERE conrelid='public.channel_log'::regclass AND contype IN ('p','f')),
  'indexes',(SELECT count(*) FROM pg_index WHERE indrelid='public.channel_log'::regclass),
  'inline_digest',position('fukulow_send_digest' in (SELECT prosrc FROM pg_proc WHERE oid='public.fukulow_message_created()'::regprocedure))=0,
  'heap_bytes',pg_relation_size('public.channel_log'),
  'index_bytes',pg_indexes_size('public.channel_log'));`;

type Integrity = Record<'messages' | 'counter_total' | 'channel_sequence_mismatches' | 'non_plain_rows' | 'log' | 'duplicate_log_positions'
  | 'orphan_log_channels' | 'orphan_log_senders' | 'missing_creates' | 'invalid_digests' | 'legacy_digest_mismatches', number>;
const integrity = (db: string): Integrity => JSON.parse(psql(db, `SELECT json_build_object(
    'messages',(SELECT count(*) FROM messages),
    'counter_total',(SELECT sum(seq) FROM channel_message_sequences),
    'channel_sequence_mismatches',(SELECT count(*) FROM (
      SELECT organization_id,channel_id,count(*) AS n,min(seq) AS lo,max(seq) AS hi
      FROM messages GROUP BY organization_id,channel_id) m
      FULL JOIN channel_message_sequences s USING (organization_id,channel_id)
      WHERE s.seq IS DISTINCT FROM m.n OR m.lo IS DISTINCT FROM 1::bigint OR m.hi IS DISTINCT FROM m.n),
    'non_plain_rows',(SELECT count(*) FROM messages WHERE topic_id IS NOT NULL OR reply_to_id IS NOT NULL OR octet_length(body) <> 17),
    'log',(SELECT count(*) FROM channel_log),
    'duplicate_log_positions',(SELECT count(*) FROM (SELECT 1 FROM channel_log
      GROUP BY organization_id,channel_id,event_seq HAVING count(*)>1) d),
    'orphan_log_channels',(SELECT count(*) FROM channel_log l WHERE NOT EXISTS (SELECT 1 FROM channels c
      WHERE c.organization_id=l.organization_id AND c.id=l.channel_id)),
    'orphan_log_senders',(SELECT count(*) FROM channel_log l WHERE NOT EXISTS (SELECT 1 FROM users u
      WHERE u.organization_id=l.organization_id AND u.id=l.sender)),
    'missing_creates',(SELECT count(*) FROM messages m LEFT JOIN channel_log l
      ON l.organization_id=m.organization_id AND l.channel_id=m.channel_id AND l.event_seq=m.seq AND l.kind='create'
      AND l.message_id=m.id AND l.sender=m.sender AND l.client_message_id=m.client_message_id WHERE l.message_id IS NULL),
    'invalid_digests',(SELECT count(*) FROM messages m WHERE octet_length(m.send_digest) IS DISTINCT FROM 32
      OR m.send_digest IS DISTINCT FROM public.fukulow_send_digest(m.channel_id,m.body,NULL,m.reply_to_id)),
    'legacy_digest_mismatches',(SELECT count(*) FROM messages m WHERE m.send_digest IS DISTINCT FROM pg_catalog.sha256(
      pg_catalog.convert_to('fukulow.send.v1','UTF8') || pg_catalog.uuid_send(m.channel_id)
      || pg_catalog.decode('0000','hex')
      || pg_catalog.int4send(pg_catalog.octet_length(m.body)) || pg_catalog.convert_to(m.body,'UTF8')))
  );`, 'verify write totals, sequences, log and digests'));

// Unchanged checks from the 2026-11-23 harness.
function integrityPassed(i: Integrity, expected: number, shapeAfter: Shape, setupShape: Shape, arm: string) {
  return i.messages === expected && i.counter_total === expected
    && i.channel_sequence_mismatches === 0 && i.non_plain_rows === 0
    && i.log === expected && i.missing_creates === 0 && i.duplicate_log_positions === 0
    && i.orphan_log_channels === 0 && i.orphan_log_senders === 0
    && i.invalid_digests === 0 && i.legacy_digest_mismatches === 0
    && JSON.stringify(shapeAfter.constraints) === JSON.stringify(setupShape.constraints)
    && shapeAfter.inline_digest === (arm === 'inline');
}

// 2 GiB tmpfs holds the base seed plus about two ~280 MB copies, not five. An overlay arm's seed is
// built from seed_base just before it is needed, checked against the setup shape and checksum, and
// dropped once the sample clone exists.
function buildSeed(arm: string) {
  try { psql('postgres', `CREATE DATABASE seed_${arm} TEMPLATE seed_base STRATEGY FILE_COPY;`, `clone ${arm} seed`); }
  catch (error) { console.error('Clone diagnostics:', cloneDiagnostics()); throw error; }
  psql(`seed_${arm}`, blocks[arm], `apply ${arm} overlay`);
  psql(`seed_${arm}`, 'VACUUM (ANALYZE) channel_log;', `settle ${arm} seed`);
  return { shape: JSON.parse(psql(`seed_${arm}`, shapeSQL, `read ${arm} shape`)) as Shape,
    checksum: psql(`seed_${arm}`, checksumSQL + ';', `checksum ${arm} fixture`) };
}
const dropSeed = (arm: string) => psql('postgres', `DROP DATABASE seed_${arm};`, `drop ${arm} seed`);

type MeasuredWindow = { accepted: number; load: Load; controlBefore: Control; controlAfter: Control; cpuUsec: number; walBytes: number;
  statWal: Wal; statementInfo: { dealloc: number } };
type Verification = { integrity: Integrity; shapeAfter: Shape; seeded: number; expected: number };
const db = 'diag';
type Decided = WindowResult<MeasuredWindow, Verification> & { warmup: Load | null };
async function sample(w: Window): Promise<Decided> {
  const dir = resolve(output, w.id);
  mkdirSync(dir);
  console.log(`Window ${w.index}`, w.phase, w.round, w.shape, w.arm, `position ${w.position}/${w.order.length}`);
  let app: App | null = null, warmup: Load | null = null, statements: Statement[] = [], decided: Decided | null = null;
  await runWindow<MeasuredWindow, Verification>(w, {
    async prepare() {
      if (w.arm !== 'base') {
        const built = buildSeed(w.arm);
        if (built.checksum !== checksums.base || JSON.stringify(built.shape.constraints) !== JSON.stringify(fixtures[w.arm].shape.constraints)) {
          throw new Error(`Rebuilt ${w.arm} seed differs from setup`);
        }
      }
      psql('postgres', 'CHECKPOINT;', 'checkpoint before sample clone');
      try { psql('postgres', `CREATE DATABASE ${db} TEMPLATE seed_${w.arm};`, 'clone fixture database'); }
      catch (error) { console.error('Clone diagnostics:', cloneDiagnostics()); throw error; }
      if (w.arm !== 'base') dropSeed(w.arm);
      const { organization, channels, tokens } = base;
      writeFileSync(fixturePath, JSON.stringify({ organization, channels: w.shape === 'hot-17' ? channels.slice(0, 1) : channels, tokens }), { mode: 0o600 });
      app = await startApp(w.arm, db);
    },
    async warm() { warmup = await generate(dir, warmSeconds, 'warm'); },
    checkpoint: () => checkpoint((query, operation) => psql('postgres', query, operation)),
    async measure() {
      psql(db, 'SELECT pg_stat_statements_reset();', 'reset statement statistics');
      const controlBefore = JSON.parse(psql(db, controlSQL, 'read control before window')) as Control;
      const cpuBefore = cpu(), walBefore = JSON.parse(psql(db, walSQL, 'read pg_stat_wal before window')) as Wal;
      const load = await generate(dir, measuredSeconds, 'measure');
      const cpuUsec = cpu() - cpuBefore;
      // Cluster-wide insert position: no backend flush needed, includes background WAL.
      const controlAfter = JSON.parse(psql(db, controlSQL, 'read control after window')) as Control;
      const walBytes = Number(psql(db, `SELECT pg_wal_lsn_diff('${controlAfter.lsn}','${controlBefore.lsn}');`, 'read WAL LSN delta'));
      // Cluster pg_stat_wal; backends flush it about once a second, so its edges are approximate.
      const walAfter = JSON.parse(psql(db, walSQL, 'read pg_stat_wal after window')) as Wal;
      const statWal = { records: walAfter.records - walBefore.records, fpi: walAfter.fpi - walBefore.fpi, bytes: walAfter.bytes - walBefore.bytes };
      const snapshot = psql(db, statementSQL, 'snapshot statement statistics');
      writeFileSync(resolve(dir, 'pg_stat_statements.json'), snapshot + '\n');
      statements = JSON.parse(snapshot) as Statement[];
      const statementInfo = JSON.parse(psql(db, 'SELECT row_to_json(i) FROM pg_stat_statements_info i;', 'read statement eviction count'));
      return { accepted: load.accepted, load, controlBefore, controlAfter, cpuUsec, walBytes, statWal, statementInfo };
    },
    verify(_w, measured) {
      if (app) stopApp(app);
      app = null;
      const checks = integrity(db);
      const shapeAfter = JSON.parse(psql(db, shapeSQL, 'read channel_log shape and size')) as Shape;
      const expected = base.seeded + warmup!.accepted + measured.accepted;
      return { integrity: checks, shapeAfter, seeded: base.seeded, expected,
        verified: integrityPassed(checks, expected, shapeAfter, fixtures[w.arm].shape, w.arm) };
    },
    walCheckpoints: (_w, from, to) => walCheckpoints((query, operation) => psql('postgres', query, operation), from, to),
    cleanup() {
      if (app) stopApp(app);
      app = null;
      rmSync(fixturePath, { force: true });
      psql('postgres', `DROP DATABASE IF EXISTS ${db};`, 'drop fixture clone');
    },
    // result.json and the manifest carry the same decision the summary re-applies.
    record(_w, result) {
      decided = { ...result, warmup, ...decide({ ...result, warmup }, statements) };
      dump(dir, 'result.json', { ...decided, window: w, image });
    },
  });
  if (!decided) throw new Error(`window ${w.id} not recorded`);
  return decided;
}

async function main() {
  const started = performance.now();
  const revision = readFileSync(resolve(build, 'revision'), 'utf8').trim();
  const [id, actualRev] = docker('inspect app image', ['image', 'inspect', imageTag, '--format',
    '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}']).split(' ');
  if (revision !== actualRev || actualRev !== pinnedRevision) throw new Error('Image revision mismatch');
  if (id !== pinnedImageId) throw new Error('Image ID mismatch');
  image = { tag: imageTag, revision, id };
  blocks = overlays(readFileSync(new URL('./overlays.sql', import.meta.url), 'utf8'));
  if (JSON.stringify(Object.keys(blocks).sort()) !== JSON.stringify([...OVERLAY_ARMS].sort())) throw new Error('Overlay arms mismatch');
  const plan = windows(smoke);

  docker('create private run network', ['network', 'create', '--label', label, owner]);
  const deploy = resolve(build, 'deploy');
  const mounts = ['db-roles.sql', 'db-role-settings.sql', 'db-grants.sql'].flatMap(f => ['-v', `${deploy}/${f}:/opt/fukulow/${f}:ro`]);
  docker('start disposable PostgreSQL', ['run', '--pull=never', '-d', '--name', pg, '--label', label,
    '--network', owner, '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql:rw,size=2147483648',
    '-e', 'POSTGRES_USER=fukulow', '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_APP_PASSWORD=${password}`,
    '-v', `${deploy}/init-db-roles.sh:/docker-entrypoint-initdb.d/10-db-roles.sh:ro`, ...mounts, pgImage,
    'postgres', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'pg_stat_statements.track=all',
    '-c', 'max_wal_size=8GB', '-c', 'checkpoint_timeout=30min']);
  await waitFor('PostgreSQL', () => spawnSync('docker', ['exec', pg, 'pg_isready', '-h', '127.0.0.1',
    '-U', 'fukulow', '-d', 'postgres'], { stdio: 'ignore', timeout: 3000 }).status === 0);
  // Reads checkpoint records from WAL after each window (window.ts walCheckpoints); WAL is cluster-wide.
  psql('postgres', 'CREATE EXTENSION pg_walinspect;', 'install pg_walinspect');
  const settings = JSON.parse(psql('postgres', `SELECT json_object_agg(name,setting) FROM pg_settings
    WHERE name IN ('server_version','shared_buffers','fsync','synchronous_commit','max_wal_size','checkpoint_timeout',
    'jit','pg_stat_statements.track','pg_stat_statements.track_planning','compute_query_id','full_page_writes');`));
  const generatorId = docker('inspect k6 image', ['image', 'inspect', k6Image, '--format', '{{.Id}}']);
  const results: { id: string; valid: boolean; reasons: string[] }[] = [];
  const manifest: Record<string, unknown> = { smoke, rate, warmSeconds, measuredSeconds, image, k6Image, generatorId, pgImage,
    postgres: { port: port(pg, '5432'), storage: 'tmpfs 2 GiB', settings }, phases: PHASES, windows: plan, results };
  dump(output, 'manifest.json', manifest);

  console.log('Seeding shared fixture');
  psql('postgres', 'CREATE DATABASE seed_base;', 'create seed database');
  docker('migrate seed', ['run', '--pull=never', '--rm', '--label', label, '--network', owner,
    ...dbEnv('fukulow', 'seed_base'), '-e', `POSTGRES_APP_PASSWORD=${password}`, image.id, 'fukulow-server', 'migrate']);
  psql('seed_base', 'CREATE EXTENSION pg_stat_statements;', 'install pg_stat_statements');
  const app = await startApp('seed', 'seed_base');
  // seed() reads only base, env.LOAD_SETUP_TOKEN and sql from the stack.
  const seeder = { base: app.base, env: { LOAD_SETUP_TOKEN: setupToken },
    sql: (query: string) => psql('seed_base', query, 'seed Members, Sessions and second Organization') } as unknown as Stack;
  const { organization, channels, tokens } = await seed(seeder);
  stopApp(app);
  psql('seed_base', [autovacuumSQL, prefillSQL(organization, channels, channels.map(() => 100)),
    channelLogSQL('A', organization, channels), settleSQL].join('\n'), 'prefill and settle fixture');
  const seeded = Number(psql('seed_base', 'SELECT count(*) FROM messages;', 'count seed Messages'));
  if (seeded !== 20000) throw new Error('Unexpected fixture count');
  base = { organization, channels, tokens, seeded };
  fixtures.base = { shape: JSON.parse(psql('seed_base', shapeSQL, 'read base shape')) };
  checksums.base = psql('seed_base', checksumSQL + ';', 'checksum fixture');
  psql('seed_base', 'VACUUM (ANALYZE) channel_log;\nCHECKPOINT;', 'settle base seed');
  // Each overlay arm once, one copy at a time: records its shape and checksum, then drops it.
  for (const arm of OVERLAY_ARMS) {
    const built = buildSeed(arm);
    fixtures[arm] = { shape: built.shape };
    checksums[arm] = built.checksum;
    dropSeed(arm);
  }
  manifest.shapes = Object.fromEntries(Object.entries(fixtures).map(([arm, f]) => [arm, f.shape]));
  // Reaching here means the inline overlay's 1,400-case byte comparison found 0 mismatches.
  manifest.c2Compatibility = { cases: 1400, mismatches: 0 };
  dump(output, 'fixture-checksums.json', checksums);
  if (new Set(Object.values(checksums)).size !== 1) throw new Error('Logical seed checksums differ');

  psql('postgres', 'ALTER ROLE fukulow_app SET pg_stat_statements.track_planning=off;', 'set app planning tracking');
  manifest.planning = psql('seed_base', 'SHOW pg_stat_statements.track_planning;', 'verify app planning setting', 'fukulow_app');
  if (manifest.planning !== 'off') throw new Error('Planning tracking mismatch');
  for (const w of plan) {
    const r = await sample(w);
    results.push({ id: r.id, valid: r.valid, reasons: r.reasons });
    dump(output, 'manifest.json', manifest);
  }
  manifest.elapsedSeconds = (performance.now() - started) / 1000;
  dump(output, 'manifest.json', manifest);
}

function cleanup() {
  let ok = true;
  for (const kind of ['container', 'network'] as const) {
    try {
      const ids = docker(`list ${kind}s`, [kind === 'container' ? 'ps' : 'network', ...(kind === 'container' ? ['-aq'] : ['ls', '-q']),
        '--filter', `label=${label}`]).split('\n').filter(Boolean);
      if (ids.length) docker(`remove ${kind}s`, kind === 'container' ? ['rm', '-fv', ...ids] : ['network', 'rm', ...ids]);
    } catch { ok = false; }
  }
  rmSync(scratch, { recursive: true, force: true });
  return ok;
}
process.once('SIGINT', () => { cleanup(); process.exit(130); });
process.once('SIGTERM', () => { cleanup(); process.exit(143); });

let failed = false;
try {
  await main();
} catch (error) {
  // Child diagnostics may contain disposable credentials. Report only the controlled operation.
  console.error(error instanceof SyntaxError ? 'Invalid diagnostic output' : (error as Error).message);
  failed = true;
}
if (!cleanup()) failed = true;
if (!failed) failed = !summarize(output);
process.exitCode = failed ? 1 : 0;
