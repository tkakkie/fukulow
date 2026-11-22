import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { parseArgs, promisify } from 'node:util';
import { outsideCheckout } from './proxy-target.ts';
import {
  dbImageHashes, fileSha256, frozenManifest, manifestPath, overlayHashes, repoPath, sha256, verifyDbImageInputs, writeBodies,
} from './search-m1-bodies.ts';
import { collect, type Boundary, type CpuSample } from './search-m1-results.ts';
import {
  dbSettings, expectedDbSettings, limiter, limiterNote, orders, scenarios, workload, writeReport,
  type Arm, type Batch, type Metadata, type Run, type Scenario, type StackIdentity,
} from './search-m1-report.ts';
import { frozenPool } from './search-s1-bodies.ts';
import {
  acceptedMessages, originalTermsSha256, overlayPath, overlaySource, preflightS1, s1ArmDirectory, termCheck, termCountsSql,
  termsFunctionHash,
} from './search-s1-evidence.ts';
import {
  expectedS1DbSettings, productCommit, s1DbSettings, s1Node, s1Orders, s1Scenarios, s1Workload, writeS1Report,
  type S1Metadata, type S1Mode, type S1Overlay, type S1Run,
} from './search-s1-report.ts';

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  out: { type: 'string' }, smoke: { type: 'boolean' }, help: { type: 'boolean' },
  s1: { type: 'boolean' }, rehearsal: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: node load/search-m1.ts --out /absolute/new/external/directory [--smoke]');
  console.log('   or: node load/search-m1.ts --s1 --out /absolute/new/external/directory [--smoke | --rehearsal]');
  process.exit(0);
}
if (!values.out) throw new Error('Use --out /absolute/new/external/directory [--smoke]');
if (values.rehearsal && (!values.s1 || values.smoke)) throw new Error('--rehearsal requires --s1 and excludes --smoke');
const output = outsideCheckout(values.out);
const smoke = values.smoke === true;
const mode: S1Mode | undefined = values.s1 ? values.rehearsal ? 'rehearsal' : smoke ? 'smoke' : 'formal' : undefined;
if (mode && existsSync(output)) throw new Error(`S1 output already exists: ${output}`);
const manifest = mode ? undefined : frozenManifest();
const { hash: manifestHash, frozen } = manifest ?? {};
assert.equal(process.version, frozen ? `v${frozen.node}` : s1Node, 'Use the frozen Node version');
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output);
const scratch = mkdtempSync(`${tmpdir()}/search-${mode ? 's1' : 'm1'}-`);
const root = `fukulow-load-${mode ? 's1' : 'm1'}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const source = `${scratch}/main`;
const recipe = `${scratch}/pgroonga`;
const appTag = `${root}-app`;
const dbTag = `${root}-db`;
const bodyPath = `${output}/bodies.json`;
const engines = 'load/search-engines';
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COMPOSE_|LOAD_|THROUGHPUT_|K6_|PG)/.test(key)));
const call = async (file: string, args: string[], env = hostEnv, timeout = 120_000) =>
  (await exec(file, args, { env, timeout, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
const docker = (...args: string[]) => call('docker', args);
const imageId = (ref: string) => docker('image', 'inspect', '--format', '{{.Id}}', ref);
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
type ArmRun = Run<StackIdentity['overlay'] | S1Overlay> & Pick<S1Run, 'termCheck' | 'normalizedBodies' | 'termEvidence'>;
const batch: Batch<ArmRun> = { runs: [], imageCleanupVerified: false, errors: [] };
let metadata: Metadata | undefined;
let s1Metadata: S1Metadata | undefined;
let s1Pool: ReturnType<typeof frozenPool> | undefined;
let dbRef = dbTag;
let interrupted = false;
let child: ChildProcess | undefined;
const stop = () => { interrupted = true; child?.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const check = () => assert.ok(!interrupted, 'Measurement interrupted');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const sqlSettings = Object.keys(mode ? expectedS1DbSettings : expectedDbSettings).map(name => `'${name}'`).join(',');
const readDbSettings = `SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN (${sqlSettings})`;
const pgroongaIndexDefinition = "CREATE INDEX search_body ON public.messages USING pgroonga (normalized_body) " +
  `WITH (normalizers='', tokenizer='TokenNgram("unify_alphabet", false, "unify_symbol", false, "unify_digit", false)')`;

async function runArm(scenario: Scenario, pair: number, arm: Arm, expected: Metadata['expected'] | S1Metadata['expected'],
  harnessHashes: Record<string, string>, dbHashes: Record<string, string> = {}) {
  check();
  const id = s1ArmDirectory(scenario, pair, arm);
  const project = `${root}-${id}`;
  const dir = `${output}/${id}`;
  mkdirSync(dir);
  console.log(`Starting ${id}`);
  const conditions = mode ? s1Workload(scenario, mode) : workload(scenario, smoke);
  const { rates, seconds, channels, members, preAllocatedVUs, maxVUs, requestTimeoutSeconds } = conditions;
  const env = { ...hostEnv, LOAD_PROJECT: project, LOAD_PORT: '18057', LOAD_APP_IMAGE: appTag,
    LOAD_DB_PASSWORD: randomUUID(), LOAD_APP_PASSWORD: randomUUID(), LOAD_SETUP_TOKEN: randomUUID(), ...limiter,
    BASE_URL: 'http://host.docker.internal:18057', LOAD_BOOTSTRAP: '1',
    LOAD_EMAIL: 'baseline@example.invalid', LOAD_PASSWORD: randomUUID(), LOAD_MEASURE: '1',
    CHANNELS: String(channels), THROUGHPUT_MEMBERS: String(members), THROUGHPUT_SCENARIO: scenario,
    THROUGHPUT_RATES: rates.join(','), THROUGHPUT_STEP_SECONDS: String(seconds),
    THROUGHPUT_VUS: String(preAllocatedVUs), THROUGHPUT_MAX_VUS: String(maxVUs),
    REQUEST_TIMEOUT_SECONDS: String(requestTimeoutSeconds), THROUGHPUT_BODIES: '/m1-bodies.json',
    ...(mode && { THROUGHPUT_RECORD_ACCEPTED_IDS: '1' }) };
  const override = `${scratch}/compose.json`;
  save(override, { services: { ...(mode && { app: { environment: { FUKULOW_SEARCH_ENGINE: 'disabled' } } }), db: {
    image: dbRef, command: ['postgres', ...Object.entries(mode ? s1DbSettings : dbSettings).filter(([name]) => name !== 'pgroonga.enable_wal')
      .flatMap(([name, value]) => ['-c', `${name}=${value}`])],
    ...(mode && { healthcheck: { test: ['CMD', 'pg_isready', '-h', '127.0.0.1', '-U', 'fukulow', '-d', 'fukulow'] } }),
    volumes: ['data:/var/lib/postgresql',
      `${source}/deploy/init-db-roles.sh:/docker-entrypoint-initdb.d/10-db-roles.sh:ro`,
      ...['db-roles', 'db-role-settings', 'db-grants'].map(name =>
        `${source}/deploy/${name}.sql:/opt/fukulow/${name}.sql:ro`)],
  } }, volumes: { data: {} } });
  const compose = ['compose', '--env-file', '/dev/null', '-p', project,
    '-f', mode ? join(source, 'load/compose.yml') : resolve('load/compose.yml'), '-f', override];
  const dc = (...args: string[]) => call('docker', [...compose, ...args], env);
  const psql = ['exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow'];
  const sql = (query: string) => dc(...psql, '-qAtc', query);
  const sqlInput = async (input: string) => {
    const task = exec('docker', [...compose, ...psql, '-qAt'], { env, timeout: 1_800_000, maxBuffer: 8 * 1024 * 1024 });
    child = task.child;
    child.stdin?.on('error', () => { /* The subprocess result supplies the error. */ });
    child.stdin?.end(input);
    try { return (await task).stdout.trimEnd(); }
    finally { child = undefined; }
  };
  const generator = `${project}-generator`;
  const ownership = `com.docker.compose.project=${project}`;
  const ownershipFilter = `label=${ownership}`;
  const run: ArmRun = { scenario, pair, arm, sequence: batch.runs.length + 1, errors: [], cleanupVerified: false, steps: [] };
  const verifyHarness = () => {
    verifyDbImageInputs(recipe, dbHashes);
    for (const [path, hash] of Object.entries(harnessHashes)) assert.equal(fileSha256(path), hash, `Harness changed: ${path}`);
  };
  const readOverlay = (name: string) => {
    const path = `${engines}/${name}`;
    const bytes = readFileSync(repoPath(path));
    assert.equal(sha256(bytes), harnessHashes[path], `Harness changed: ${path}`);
    return bytes.toString('utf8');
  };
  const boundaries: Boundary[] = [];
  const samples: CpuSample[] = [];
  let startMs: number | undefined;
  const snapshots: Promise<void>[] = [];
  const timers: NodeJS.Timeout[] = [];
  let sampler: NodeJS.Timeout | undefined;
  let sampling: Promise<void> | undefined;
  const capture = (index: number) => {
    const startedMs = Date.now();
    snapshots.push(sql("SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '0/0'), pg_database_size(current_database())")
      .then(row => {
        assert.match(row, /^\d+\|\d+$/, 'Expected WAL bytes and DB size');
        const [walBytes, dbBytes] = row.split('|').map(Number);
        boundaries[index] = { startedMs, completedMs: Date.now(), walBytes, dbBytes };
      }).catch(error => { boundaries[index] = { missing: `snapshot ${index} failed: ${message(error)}` }; }));
  };
  try {
    verifyHarness();
    await dc('up', '-d', '--no-build', '--pull', 'never', '--wait');
    check();
    const [app, db, migrate] = await Promise.all([dc('ps', '-q', 'app'), dc('ps', '-q', 'db'), dc('ps', '-aq', 'migrate')]);
    if (s1Metadata && s1Pool) {
      run.normalizedBodies = await preflightS1(arm, s1Metadata, s1Pool, sql, sqlInput);
    } else {
      const schema = readOverlay('schema.sql');
      // The common overlay is the stored column and its normalization dependencies.
      const column = schema.slice(schema.indexOf('CREATE COLLATION'), schema.indexOf('-- Identical'));
      assert.match(column, /GENERATED ALWAYS AS \(search_normalize\(body\)\) STORED;/);
      await sql(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements; CREATE EXTENSION pgroonga; ${column}
        ${arm === 'A' ? readOverlay('pgroonga.sql') : ''}
        DO $$ BEGIN PERFORM pgroonga_command('status'); END $$;`);
    }
    const inspect = (id: string, field: string) => docker('inspect', '--format', field, id);
    const inspectStack = async (): Promise<StackIdentity<StackIdentity['overlay'] | S1Overlay>> => {
      const [commit, appImage, dbImage, migrateImage, burst, refill] = await Promise.all([
        inspect(app, '{{index .Config.Labels "org.opencontainers.image.revision"}}'),
        inspect(app, '{{.Image}}'), inspect(db, '{{.Image}}'), inspect(migrate, '{{.Image}}'),
        inspect(app, '{{range .Config.Env}}{{if eq (index (split . "=") 0) "FUKULOW_SEND_BURST"}}{{index (split . "=") 1}}{{end}}{{end}}'),
        inspect(app, '{{range .Config.Env}}{{if eq (index (split . "=") 0) "FUKULOW_SEND_REFILL_PER_SECOND"}}{{index (split . "=") 1}}{{end}}{{end}}'),
      ]);
      const base = { commit, appImage, dbImage, migrateImage,
        limiter: { LOAD_SEND_BURST: burst, LOAD_SEND_REFILL_PER_SECOND: refill } };
      if (s1Metadata) {
        const [definitionSha256, settings, searchEngine] = await Promise.all([termsFunctionHash(sql), sql(readDbSettings),
          inspect(app, '{{range .Config.Env}}{{if eq (index (split . "=") 0) "FUKULOW_SEARCH_ENGINE"}}{{index (split . "=") 1}}{{end}}{{end}}')]);
        return { ...base, dbSettings: JSON.parse(settings), overlay: { arm, searchEngine,
          originalSha256: originalTermsSha256, definitionSha256,
          overlaySha256: s1Metadata.overlay.sha256 } };
      }
      const settings = await sql(`DO $$ BEGIN PERFORM pgroonga_command('status'); END $$;
          SELECT json_build_object('dbSettings', (${readDbSettings}),
            'storedBody', EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'public.messages'::regclass AND attname = 'normalized_body' AND attgenerated = 's'),
            'pgroongaIndex', EXISTS (SELECT FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
              WHERE i.indrelid = 'public.messages'::regclass AND c.relname = 'search_body' AND am.amname = 'pgroonga' AND i.indisvalid),
            'indexDefinition', (SELECT pg_get_indexdef(indexrelid) FROM pg_index
              WHERE indrelid = 'public.messages'::regclass AND indexrelid = to_regclass('public.search_body')),
            'extension', (SELECT extversion FROM pg_extension WHERE extname = 'pgroonga'));`);
      const actual = JSON.parse(settings);
      assert.equal(actual.extension, frozen!.image.extensions.pgroonga);
      assert.equal(actual.indexDefinition, arm === 'A' ? pgroongaIndexDefinition : null, 'PGroonga index definition mismatch');
      return { ...base, dbSettings: actual.dbSettings,
        overlay: { storedBody: actual.storedBody, pgroongaIndex: actual.pgroongaIndex } };
    };
    const stack = await inspectStack();
    const { k6Image, bodySha256, bodySeed, ...expectedStack } = expected;
    const expectedOverlay = s1Metadata ? { arm, searchEngine: 'disabled', overlaySha256: s1Metadata.overlay.sha256,
      originalSha256: originalTermsSha256,
      definitionSha256: arm === 'A' ? originalTermsSha256 : s1Metadata.overlaidTermsSha256 }
      : { storedBody: true, pgroongaIndex: arm === 'A' };
    assert.deepEqual(stack, { ...expectedStack, overlay: expectedOverlay });
    assert.equal(fileSha256(bodyPath), bodySha256);
    check();

    const sample = () => {
      if (sampling) return;
      sampling = docker('stats', '--no-stream', '--format', '{{.ID}}|{{.CPUPerc}}', app, db).then(raw => {
        const rows = raw.split('\n').map(row => row.split('|'));
        const cpu = (id: string) => Number.parseFloat(rows.find(([prefix]) => prefix && id.startsWith(prefix))?.[1] ?? '');
        const appCpu = cpu(app);
        const dbCpu = cpu(db);
        if (Number.isFinite(appCpu) && Number.isFinite(dbCpu)) samples.push({ at: Date.now(), appCpu, dbCpu });
      }).catch(() => { /* Missing CPU evidence is recorded by the collector. */ })
        .finally(() => { sampling = undefined; });
    };
    sampler = setInterval(sample, 1000);
    const out = createWriteStream(`${dir}/k6-summary.log`);
    const err = createWriteStream(`${dir}/k6.log`);
    const keys = ['BASE_URL', 'LOAD_BOOTSTRAP', 'LOAD_SETUP_TOKEN', 'LOAD_EMAIL', 'LOAD_PASSWORD', 'LOAD_MEASURE',
      'CHANNELS', 'THROUGHPUT_MEMBERS', 'THROUGHPUT_SCENARIO', 'THROUGHPUT_RATES', 'THROUGHPUT_STEP_SECONDS',
      'THROUGHPUT_VUS', 'THROUGHPUT_MAX_VUS', 'REQUEST_TIMEOUT_SECONDS', 'THROUGHPUT_BODIES',
      ...(mode ? ['THROUGHPUT_RECORD_ACCEPTED_IDS'] : [])];
    const generatorProcess = spawn('docker', ['run', '--rm', '--name', generator, '--label', ownership,
      '--network', 'bridge', '--ulimit', 'nofile=65536:65536', '-v', `${resolve('.')}:/work:ro`,
      '-v', `${bodyPath}:/m1-bodies.json:ro`, '-w', '/work',
      ...keys.flatMap(key => ['-e', key]), k6Image, 'run', '--quiet', '--log-format', 'raw', 'load/throughput.ts'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = generatorProcess;
    generatorProcess.stdout.pipe(out);
    generatorProcess.stderr.pipe(err);
    const logs = Promise.all([finished(out), finished(err)]);
    void logs.catch(() => generatorProcess.kill('SIGTERM'));
    const lines = createInterface({ input: generatorProcess.stderr });
    lines.on('line', line => {
      if (line === 'LOAD_MEASUREMENT_START') capture(0);
      if (line === 'LOAD_MEASUREMENT_END') {
        for (const timer of timers) clearTimeout(timer);
        capture(rates.length);
      }
      if (line !== 'LOAD_THROUGHPUT_START' || startMs !== undefined) return;
      // Use the host clock for both timers and snapshot acceptance.
      startMs = Date.now();
      // Sample after the 3 s request timeout and before the next scenario starts.
      for (let index = 1; index < rates.length; index++) {
        const at = startMs + (index * (seconds + requestTimeoutSeconds + 1) - .5) * 1000;
        timers.push(setTimeout(() => capture(index), Math.max(0, at - Date.now())));
      }
    });
    const timeout = setTimeout(() => generatorProcess.kill('SIGKILL'),
      (channels * 5 + members * 25 + rates.length * (seconds + requestTimeoutSeconds + 1) + 105) * 1000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        generatorProcess.once('error', reject);
        generatorProcess.once('close', done);
      });
      await logs;
      check();
      assert.ok(code === 0 || code === 99, `k6 exited ${code}`);
      await Promise.all(snapshots);
      // Keep the raw snapshots and CPU samples alongside the k6 summary.
      const result = collect(readFileSync(`${dir}/k6-summary.log`, 'utf8'), conditions, startMs, boundaries, samples, s1Metadata !== undefined);
      run.steps = result.steps;
      run.totals = result.totals;
      run.identity = { ...stack, workload: result.workload, k6Image, bodySeed, bodySha256: result.bodySha256 };
      if (mode) {
        const log = readFileSync(`${dir}/k6.log`);
        const accepted = acceptedMessages(log.toString('utf8'), result.totals.accepted);
        const raw = await sqlInput(termCountsSql(accepted));
        const counts = raw ? raw + '\n' : '';
        writeFileSync(`${dir}/term-counts.tsv`, counts);
        run.termCheck = termCheck(accepted.ids, raw, arm);
        run.termEvidence = { acceptedLogSha256: sha256(log), termCountsSha256: sha256(counts) };
      }
      run.finalStack = await inspectStack();
      if (s1Metadata) assert.deepEqual(run.finalStack.overlay, expectedOverlay, 'S1 overlay changed during the run');
      assert.equal(fileSha256(bodyPath), bodySha256, 'Body file changed during the run');
    } finally {
      clearTimeout(timeout);
      child = undefined;
    }
  } catch (error) {
    run.errors.push(message(error));
  } finally {
    try { verifyHarness(); } catch (error) { run.errors.push(message(error)); }
    for (const timer of timers) clearTimeout(timer);
    clearInterval(sampler);
    await Promise.all(snapshots);
    await sampling;
    const cleanupErrors: string[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try { await action(); } catch (error) { cleanupErrors.push(`Cleanup: ${message(error)}`); }
    };
    await cleanup(async () => {
      const owned = await docker('container', 'ls', '-aq', '--filter', ownershipFilter, '--filter', `name=^/${generator}$`);
      if (owned) await docker('rm', '-f', owned);
    });
    await cleanup(() => dc('down', '--volumes'));
    for (const kind of ['container', 'network', 'volume']) {
      await cleanup(async () => {
        assert.equal(await docker(kind, 'ls', kind === 'container' ? '-aq' : '-q', '--filter', ownershipFilter),
          '', `Owned ${kind} remains for ${project}`);
      });
    }
    run.cleanupVerified = cleanupErrors.length === 0;
    run.errors.push(...cleanupErrors);
    save(`${dir}/evidence.json`, { project, startMs, boundaries, samples, ...run });
    batch.runs.push(run);
    save(`${output}/runs.json`, batch);
  }
  if (!run.cleanupVerified) throw new Error(`Cleanup unverified for ${project}`);
}

const builtTags: string[] = [];
async function build(tag: string, args: string[]) {
  check();
  builtTags.push(tag);
  const build = exec('docker', ['build', '-t', tag, ...args], { env: hostEnv, timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  child = build.child;
  try {
    const { stdout, stderr } = await build;
    writeFileSync(`${output}/build-${tag.endsWith('-app') ? 'app' : 'db'}.log`, stdout + stderr);
  } finally {
    child = undefined;
  }
}

try {
  s1Pool = mode ? frozenPool() : undefined;
  if (s1Pool) writeFileSync(bodyPath, s1Pool.json, { flag: 'wx' });
  const bodies = s1Pool ? { seed: s1Pool.seed, count: s1Pool.count, sha256: s1Pool.sha256 } : await writeBodies(bodyPath);
  const commit = await call('git', ['rev-parse', `${mode ? productCommit : 'main'}^{commit}`]);
  const machine = { platform: platform(), arch: arch(), cpus: cpus().length, memory: totalmem(), cpu: cpus()[0]?.model,
    docker: JSON.parse(await docker('info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memory":{{.MemTotal}}}')) };
  mkdirSync(source);
  await call('git', ['archive', '--format=tar', `--output=${scratch}/main.tar`, commit]);
  await call('tar', ['-xf', `${scratch}/main.tar`, '-C', source]);
  await build(appTag, ['--label', `org.opencontainers.image.revision=${commit}`, source]);
  const useImage = (ref: string) => imageId(ref).catch(async () => { await docker('pull', ref); return imageId(ref); });
  let m1Hashes: Record<string, string> = {};
  let m1DbHashes: Record<string, string> = {};
  if (frozen) {
    const dbHashes = dbImageHashes(frozen.sourceHashes);
    mkdirSync(recipe);
    for (const path of Object.keys(dbHashes)) copyFileSync(repoPath(path), join(recipe, basename(path)));
    verifyDbImageInputs(recipe, dbHashes);
    await build(dbTag, [recipe]);
    m1Hashes = { ...overlayHashes(frozen.sourceHashes), ...dbHashes };
    m1DbHashes = dbHashes;
  } else {
    const pinnedDb = readFileSync(join(source, 'load/compose.yml'), 'utf8')
      .match(/^    image: (postgres:18\.\d+@sha256:[0-9a-f]{64})$/m)?.[1];
    assert.ok(pinnedDb, 'Expected a pinned PostgreSQL image in the baseline Compose file');
    dbRef = pinnedDb;
    await useImage(dbRef);
  }
  check();
  const k6 = await call('make', ['-s', 'load-image']);
  const k6Image = await useImage(k6);
  const appImage = await imageId(appTag);
  const dbImage = await imageId(dbRef);
  const harnessFiles = ['Makefile', 'load/compose.yml', 'load/throughput.ts', 'load/throughput-summary.ts', 'load/summary.ts',
    'load/seed.ts', 'load/session-layout.ts', 'load/compat.ts', 'load/delivery.ts', 'load/sessions.ts', 'load/scheduler.ts', 'load/proxy-target.ts',
    'load/search-m1.ts', 'load/search-m1-bodies.ts', 'load/search-m1-report.ts', 'load/search-m1-results.ts',
    'load/search-m1-report.test.ts', 'load/search-m1-runner.test.ts',
    'deploy/init-db-roles.sh', 'deploy/db-roles.sql', 'deploy/db-role-settings.sql', 'deploy/db-grants.sql',
    ...(mode ? ['load/search-s1-bodies.ts', 'load/search-s1-evidence.ts', 'load/search-s1-report.ts', overlayPath] : [manifestPath])];
  const harnessHashes = { ...Object.fromEntries(harnessFiles.map(path => [path, fileSha256(path)])), ...m1Hashes };
  const references = { machine, node: process.version, manifestHash, bodies, k6, limiterNote, harnessHashes };
  const images = { commit, appImage, migrateImage: appImage, dbImage, k6Image, limiter, bodySha256: bodies.sha256, bodySeed: bodies.seed };
  if (mode) {
    const k6Version = await docker('run', '--rm', k6Image, 'version');
    s1Metadata = { mode, node: process.version, k6Version, bodySize: bodies.count, overlay: overlaySource(),
      originalTermsSha256, expected: { ...images, dbSettings: expectedS1DbSettings } };
    const saveS1Metadata = () => save(`${output}/metadata.json`, { ...references, dbRef, ...s1Metadata });
    saveS1Metadata();
    try {
      for (const scenario of s1Scenarios(mode)) {
        for (const [index, order] of s1Orders(mode).entries()) {
          for (const arm of order) await runArm(scenario, index + 1, arm, s1Metadata.expected, harnessHashes);
        }
      }
    } finally {
      saveS1Metadata();
    }
  } else {
    metadata = { smoke, expected: { ...images, dbSettings: expectedDbSettings,
      overlay: { storedBody: true, pgroongaIndex: false } } };
    save(`${output}/metadata.json`, { ...metadata, ...references });
    if (smoke) await runArm('many', 1, 'B', metadata.expected, harnessHashes, m1DbHashes);
    else for (const scenario of scenarios) {
      for (const [index, order] of orders.entries()) {
        for (const arm of order) await runArm(scenario, index + 1, arm, metadata.expected, harnessHashes, m1DbHashes);
      }
    }
  }
} catch (error) {
  batch.errors.push(message(error));
} finally {
  batch.imageCleanupVerified = true;
  for (const tag of builtTags) {
    try {
      if (await docker('image', 'ls', '-q', tag)) await docker('image', 'rm', tag);
      assert.equal(await docker('image', 'ls', '-q', tag), '', `Owned image remains: ${tag}`);
    } catch (error) {
      batch.imageCleanupVerified = false;
      batch.errors.push(`Image cleanup: ${message(error)}`);
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  save(`${output}/runs.json`, batch);
  if (s1Metadata) {
    const report = writeS1Report(output);
    console.log(`S1 ${report.judgement} (evidence: ${report.evidence})`);
    if (report.problems.length || report.scenarios.some(scenario => scenario.runs.some(run => run.problems.length))) process.exitCode = 1;
  } else if (mode) {
    save(`${output}/report.json`, { mode, evidence: false, judgement: 'NOT EVALUATED', problems: batch.errors });
  } else if (metadata) {
    const report = writeReport(output);
    if (report.scenarios.some(scenario => scenario.runs.some(run => run.problems.length))) process.exitCode = 1;
  }
  if (batch.errors.length || interrupted) {
    console.error(batch.errors.join('\n'));
    process.exitCode = 1;
  }
  console.log(`Results: ${output}`);
}
