import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const exec = promisify(execFile);
const { values } = parseArgs({ options: { out: { type: 'string' }, smoke: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node load/search-m1.ts --out /absolute/new/external/directory [--smoke]');
  process.exit(0);
}
if (!values.out) throw new Error('Use --out /absolute/new/external/directory [--smoke]');
const output = outsideCheckout(values.out);
const smoke = values.smoke === true;
const { hash: manifestHash, frozen } = frozenManifest();
const dbHashes = dbImageHashes(frozen.sourceHashes);
assert.equal(process.version, `v${frozen.node}`, 'Use the frozen Node version');
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output);
const scratch = mkdtempSync(`${tmpdir()}/search-m1-`);
const root = `fukulow-load-m1-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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
const batch: Batch = { runs: [], imageCleanupVerified: false, errors: [] };
let metadata: Metadata | undefined;
let interrupted = false;
let child: ChildProcess | undefined;
const stop = () => { interrupted = true; child?.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const check = () => assert.ok(!interrupted, 'Measurement interrupted');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const sqlSettings = Object.keys(expectedDbSettings).map(name => `'${name}'`).join(',');
const pgroongaIndexDefinition = "CREATE INDEX search_body ON public.messages USING pgroonga (normalized_body) " +
  `WITH (normalizers='', tokenizer='TokenNgram("unify_alphabet", false, "unify_symbol", false, "unify_digit", false)')`;

async function runArm(scenario: Scenario, pair: number, arm: Arm, expected: Metadata['expected'],
  harnessHashes: Record<string, string>) {
  check();
  const id = `${scenario}-${pair}-${arm.toLowerCase()}`;
  const project = `${root}-${id}`;
  const dir = `${output}/${id}`;
  mkdirSync(dir);
  console.log(`Starting ${id}`);
  const conditions = workload(scenario, smoke);
  const { rates, seconds, channels, members, preAllocatedVUs, maxVUs, requestTimeoutSeconds } = conditions;
  const env = { ...hostEnv, LOAD_PROJECT: project, LOAD_PORT: '18057', LOAD_APP_IMAGE: appTag,
    LOAD_DB_PASSWORD: randomUUID(), LOAD_APP_PASSWORD: randomUUID(), LOAD_SETUP_TOKEN: randomUUID(), ...limiter,
    BASE_URL: 'http://host.docker.internal:18057', LOAD_BOOTSTRAP: '1',
    LOAD_EMAIL: 'baseline@example.invalid', LOAD_PASSWORD: randomUUID(), LOAD_MEASURE: '1',
    CHANNELS: String(channels), THROUGHPUT_MEMBERS: String(members), THROUGHPUT_SCENARIO: scenario,
    THROUGHPUT_RATES: rates.join(','), THROUGHPUT_STEP_SECONDS: String(seconds),
    THROUGHPUT_VUS: String(preAllocatedVUs), THROUGHPUT_MAX_VUS: String(maxVUs),
    REQUEST_TIMEOUT_SECONDS: String(requestTimeoutSeconds), THROUGHPUT_BODIES: '/m1-bodies.json' };
  const override = `${scratch}/compose.json`;
  save(override, { services: { db: {
    image: dbTag, command: ['postgres', ...Object.entries(dbSettings).filter(([name]) => name !== 'pgroonga.enable_wal')
      .flatMap(([name, value]) => ['-c', `${name}=${value}`])],
    volumes: ['data:/var/lib/postgresql',
      `${source}/deploy/init-db-roles.sh:/docker-entrypoint-initdb.d/10-db-roles.sh:ro`,
      ...['db-roles', 'db-role-settings', 'db-grants'].map(name =>
        `${source}/deploy/${name}.sql:/opt/fukulow/${name}.sql:ro`)],
  } }, volumes: { data: {} } });
  const dc = (...args: string[]) => call('docker', ['compose', '--env-file', '/dev/null', '-p', project,
    '-f', resolve('load/compose.yml'), '-f', override, ...args], env);
  const sql = (query: string) => dc('exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow', '-qAtc', query);
  const generator = `${project}-generator`;
  const ownership = `com.docker.compose.project=${project}`;
  const ownershipFilter = `label=${ownership}`;
  const run: Run = { scenario, pair, arm, sequence: batch.runs.length + 1, errors: [], cleanupVerified: false, steps: [] };
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
    const schema = readOverlay('schema.sql');
    // The common overlay is the stored column and its normalization dependencies.
    const column = schema.slice(schema.indexOf('CREATE COLLATION'), schema.indexOf('-- Identical'));
    assert.match(column, /GENERATED ALWAYS AS \(search_normalize\(body\)\) STORED;/);
    await sql(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements; CREATE EXTENSION pgroonga; ${column}
      ${arm === 'A' ? readOverlay('pgroonga.sql') : ''}
      DO $$ BEGIN PERFORM pgroonga_command('status'); END $$;`);
    const inspect = (id: string, field: string) => docker('inspect', '--format', field, id);
    const inspectStack = async (): Promise<StackIdentity> => {
      const [commit, appImage, dbImage, migrateImage, burst, refill, settings] = await Promise.all([
        inspect(app, '{{index .Config.Labels "org.opencontainers.image.revision"}}'),
        inspect(app, '{{.Image}}'), inspect(db, '{{.Image}}'), inspect(migrate, '{{.Image}}'),
        inspect(app, '{{range .Config.Env}}{{if eq (index (split . "=") 0) "FUKULOW_SEND_BURST"}}{{index (split . "=") 1}}{{end}}{{end}}'),
        inspect(app, '{{range .Config.Env}}{{if eq (index (split . "=") 0) "FUKULOW_SEND_REFILL_PER_SECOND"}}{{index (split . "=") 1}}{{end}}{{end}}'),
        sql(`DO $$ BEGIN PERFORM pgroonga_command('status'); END $$;
          SELECT json_build_object('dbSettings', (SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN (${sqlSettings})),
            'storedBody', EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'public.messages'::regclass AND attname = 'normalized_body' AND attgenerated = 's'),
            'pgroongaIndex', EXISTS (SELECT FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
              WHERE i.indrelid = 'public.messages'::regclass AND c.relname = 'search_body' AND am.amname = 'pgroonga' AND i.indisvalid),
            'indexDefinition', (SELECT pg_get_indexdef(indexrelid) FROM pg_index
              WHERE indrelid = 'public.messages'::regclass AND indexrelid = to_regclass('public.search_body')),
            'extension', (SELECT extversion FROM pg_extension WHERE extname = 'pgroonga'));`),
      ]);
      const actual = JSON.parse(settings);
      assert.equal(actual.extension, frozen.image.extensions.pgroonga);
      assert.equal(actual.indexDefinition, arm === 'A' ? pgroongaIndexDefinition : null, 'PGroonga index definition mismatch');
      return { commit, appImage, dbImage, migrateImage,
        limiter: { LOAD_SEND_BURST: burst, LOAD_SEND_REFILL_PER_SECOND: refill }, dbSettings: actual.dbSettings,
        overlay: { storedBody: actual.storedBody, pgroongaIndex: actual.pgroongaIndex } };
    };
    const stack = await inspectStack();
    const { k6Image, bodySha256, bodySeed, ...expectedStack } = expected;
    assert.deepEqual(stack, { ...expectedStack, overlay: { storedBody: true, pgroongaIndex: arm === 'A' } });
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
      'THROUGHPUT_VUS', 'THROUGHPUT_MAX_VUS', 'REQUEST_TIMEOUT_SECONDS', 'THROUGHPUT_BODIES'];
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
      const result = collect(readFileSync(`${dir}/k6-summary.log`, 'utf8'), conditions, startMs, boundaries, samples);
      run.steps = result.steps;
      run.totals = result.totals;
      run.identity = { ...stack, workload: result.workload, k6Image, bodySeed, bodySha256: result.bodySha256 };
      run.finalStack = await inspectStack();
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
  const bodies = await writeBodies(bodyPath);
  const commit = await call('git', ['rev-parse', 'main^{commit}']);
  const machine = { platform: platform(), arch: arch(), cpus: cpus().length, memory: totalmem(), cpu: cpus()[0]?.model,
    docker: JSON.parse(await docker('info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memory":{{.MemTotal}}}')) };
  mkdirSync(source);
  await call('git', ['archive', '--format=tar', `--output=${scratch}/main.tar`, commit]);
  await call('tar', ['-xf', `${scratch}/main.tar`, '-C', source]);
  await build(appTag, ['--label', `org.opencontainers.image.revision=${commit}`, source]);
  mkdirSync(recipe);
  for (const path of Object.keys(dbHashes)) copyFileSync(repoPath(path), join(recipe, basename(path)));
  verifyDbImageInputs(recipe, dbHashes);
  await build(dbTag, [recipe]);
  check();
  const k6 = await call('make', ['-s', 'load-image']);
  const k6Image = await imageId(k6).catch(async () => { await docker('pull', k6); return imageId(k6); });
  const appImage = await imageId(appTag);
  const dbImage = await imageId(dbTag);
  const harnessFiles = ['Makefile', 'load/compose.yml', 'load/throughput.ts', 'load/throughput-summary.ts', 'load/summary.ts',
    'load/seed.ts', 'load/session-layout.ts', 'load/compat.ts', 'load/delivery.ts', 'load/sessions.ts', 'load/scheduler.ts', 'load/proxy-target.ts',
    'load/search-m1.ts', 'load/search-m1-bodies.ts', 'load/search-m1-report.ts', 'load/search-m1-results.ts',
    'load/search-m1-report.test.ts', 'load/search-m1-runner.test.ts',
    'deploy/init-db-roles.sh', 'deploy/db-roles.sql', 'deploy/db-role-settings.sql', 'deploy/db-grants.sql',
    manifestPath];
  metadata = { smoke, expected: { commit, appImage, migrateImage: appImage, dbImage, k6Image, limiter, dbSettings: expectedDbSettings,
    overlay: { storedBody: true, pgroongaIndex: false }, bodySha256: bodies.sha256, bodySeed: bodies.seed } };
  const harnessHashes = { ...Object.fromEntries(harnessFiles.map(path => [path, fileSha256(path)])),
    ...overlayHashes(frozen.sourceHashes), ...dbHashes };
  save(`${output}/metadata.json`, { ...metadata, machine, node: process.version, manifestHash, bodies, k6, limiterNote, harnessHashes });
  if (smoke) await runArm('many', 1, 'B', metadata.expected, harnessHashes);
  else for (const scenario of scenarios) {
    for (const [index, order] of orders.entries()) {
      for (const arm of order) await runArm(scenario, index + 1, arm, metadata.expected, harnessHashes);
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
  if (metadata) {
    const report = writeReport(output);
    if (report.scenarios.some(scenario => scenario.runs.some(run => run.problems.length))) process.exitCode = 1;
  }
  if (batch.errors.length || interrupted) {
    console.error(batch.errors.join('\n'));
    process.exitCode = 1;
  }
  console.log(`Results: ${output}`);
}
