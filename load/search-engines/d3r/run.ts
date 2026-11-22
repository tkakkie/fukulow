import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { arch, cpus, totalmem } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedCommand, command, CommandTimeoutError, docker, save, sql } from '../bench.ts';
import { probeSql } from '../definer.ts';
import { hash, resolveImage, smokeLabel } from '../manifest.ts';
import { ownedContainer, ownedVolume, ownershipLabel, refuseLeftovers, supervise, timeouts } from '../runtime.ts';
import { copySql, finishSql, fixtureSql, generate, literal } from '../seed.ts';
import { accepts, completeness, denials, judge, type Evidence, type Round } from './acceptance.ts';
import { backfill, verifiedBackfill, verifyTerms } from './backfill.ts';
import { allPages, explainPage, prepare, type Sql } from './engine.ts';
import { argumentsForPostgres, loadManifest } from './manifest.ts';
import { productionPath, readSource, sources } from './path.ts';
import { withSession } from './session.ts';
import { directRls, verifyRls } from './rls.ts';
import { loadBackfill, preserveSnapshot, receiptFile, removeSnapshot, snapshotLaunch, type BackfillReceipt } from './snapshot.ts';
import { timeQuery } from './timing.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const note = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
type Mode = 'smoke' | 'backfill-only' | 'formal' | 'cleanup';

export function options(argv: string[]) {
  let mode: Mode = 'formal';
  let output: string | undefined;
  let fromBackfill: string | undefined;
  const sourceOption = '--from-backfill=';
  for (const arg of argv) {
    if ((arg === '--smoke' || arg === '--backfill-only' || arg === '--cleanup') && mode === 'formal') mode = arg.slice(2) as Mode;
    else if (arg.startsWith('--out=') && !output && arg.length > 6) output = arg.slice(6);
    else if (arg.startsWith(sourceOption) && !fromBackfill && arg.length > sourceOption.length) fromBackfill = arg.slice(sourceOption.length);
    else throw new Error(`Unexpected or duplicate argument ${arg}`);
  }
  assert.ok(Boolean(fromBackfill) === (mode === 'formal' || mode === 'cleanup'),
    'Use --smoke, --backfill-only, --from-backfill=DIR, or --cleanup --from-backfill=DIR');
  assert.ok(mode !== 'cleanup' || !output, 'Cleanup takes --from-backfill=DIR only');
  return {mode, output, fromBackfill};
}

export function outputPath(path: string, repository = root) {
  const absolute = resolve(path);
  const out = resolve(realpathSync(dirname(absolute)), basename(absolute));
  const gitRoot = realpathSync(repository);
  assert.ok(out !== gitRoot && !out.startsWith(gitRoot + '/'), 'Artifacts must be outside Git');
  const existing = lstatSync(out, {throwIfNoEntry: false});
  assert.ok(!existing, 'Artifact destination already exists');
  return out;
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
  const conditions = mode === 'smoke' ? {...frozen.performance, ...frozen.smoke.performance} : frozen.performance;
  const phase = (name: string, event: string) => note(`${mode === 'smoke' ? smokeLabel + ' ' : ''}${name} ${event}`);
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
  const launch = source ? snapshotLaunch(source.snapshotDirectory) : {options: [], args: []};
  docker('volume', 'create', '--label', ownershipLabel, volume);
  command('docker', ['run', '-d', '--label', ownershipLabel, '--name', container, '--network=none',
    `--shm-size=${frozen.shmBytes}`, '--mount', `type=volume,source=${volume},target=/var/lib/postgresql`,
    ...launch.options, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=postgres',
    id, ...launch.args, ...argumentsForPostgres],
  undefined, {...process.env, POSTGRES_PASSWORD: randomUUID()});

  if (source) {
    boundedCommand('docker', ['exec', container, 'sh', '-ec',
      'until test -e /tmp/backfill-extracted; do sleep 1; done'], timeouts.psql);
  }

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
  await awaitReady();
  assert.equal(owner('postgres', 'SHOW server_version_num;'), '180006');
  assert.equal(owner('postgres', 'SHOW shared_preload_libraries;'), '');
  assert.equal(owner('postgres', "SELECT count(*) FROM pg_available_extensions WHERE name = 'pgroonga';"), '0');
  const settings = JSON.parse(owner('postgres', `SELECT json_object_agg(name,setting) FROM pg_settings
    WHERE name IN (${Object.keys(frozen.settings).map(literal).join(',')});`));
  assert.deepEqual(settings, frozen.settings);
  save(`${out}/metadata.json`, {manifestHash: sha256, mode, label: mode === 'smoke' ? smokeLabel : undefined,
    at: new Date().toISOString(), node: process.version, source: command('git', ['rev-parse', 'HEAD']),
    worktreeStatus: command('git', ['status', '--porcelain']),
    image, settings, sessionPolicy: frozen.sessionPolicy, serverSqlHashes: path.hashes, conditions,
    architecture: arch(), os: process.platform, cpu: cpus()[0]?.model, cpus: cpus().length, memory: totalmem(),
    docker: JSON.parse(docker('info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memory":{{.MemTotal}}}')),
    database: owner('postgres', 'SELECT version(); SHOW lc_collate; SHOW lc_ctype;'),
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

  const completion = {manifestHash: sha256, runKind: mode, at: new Date().toISOString(),
    label: mode === 'smoke' ? smokeLabel : undefined};
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
  save(`${out}/rls.json`, rls);
  if (mode === 'backfill-only') {
    const snapshot = await preserveSnapshot(container, out, currentSystemIdentifier());
    const receipt: BackfillReceipt = {manifestHash: sha256, snapshot, records, rls};
    save(`${out}/${receiptFile}`, receipt);
    save(`${out}/completed.json`, {...completion, backfillReceiptHash: hash(JSON.stringify(receipt))});
    return;
  }

  const restore = await restoreDrill(records.small.termRows);
  rlsFor('denial');
  const accessChecks = await openApp('denial', async search => {
    await search(prepare(path.page));
    return denials(search);
  });
  owner('postgres', 'DROP DATABASE denial;');

  const {querySet} = conditions;
  const rounds: Round[] = [];
  const plans: Evidence['plans'] = [];
  let found: Evidence['complete'] = [];
  let measuredRls = '';
  for (let round = 1; round <= conditions.rounds; round++) {
    const dest = `${out}/round-${round}`;
    mkdirSync(dest);
    await resetMeasured(text => owner('postgres', text), async () => {
      docker('restart', container);
      await awaitReady();
    });
    save(`${dest}/rls.json`, rlsFor('measured'));
    phase(`round ${round}`, 'started');
    if (round === 1) measuredRls = directRls(text => app('measured', text));
    await warmup(path.page, querySet, conditions.warmupSweeps, body => openApp('measured', body));
    const latencies = [];
    for (const [query, raw] of querySet) {
      const result = await timeQuery(container, 'measured', path.page, query, raw, !accepts(query), `${dest}/${query}`,
        conditions.transactions, conditions.clients);
      latencies.push(result);
      phase(`round ${round}`, 'p95' in result ? `${query} p95=${result.p95.toFixed(3)} ms` : `${query} ${result.sqlError}`);
    }
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
    owner('postgres', 'DROP DATABASE measured;');
    phase(`round ${round}`, 'finished');
  }
  const denialReport = {...accessChecks, measuredRls};
  save(`${out}/denials.json`, denialReport);
  const evidence: Evidence = {valid: true, formal: mode === 'formal', backfill: records.base, rounds, plans, complete: found,
    denials: denialReport, restore};
  save(`${out}/evidence.json`, evidence);
  save(`${out}/completed.json`, completion);
  phase('run', 'completed');
}

export async function resetMeasured(owner: (text: string) => string, restart: () => Promise<void>) {
  owner('CREATE DATABASE measured TEMPLATE base;');
  await restart();
}

export async function warmup(page: string, querySet: readonly (readonly [string, string])[], sweeps: number,
  open: (body: (sql: Sql) => Promise<void>) => Promise<void>) {
  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (const [, raw] of querySet) {
      await open(async search => {
        await search(prepare(page));
        await allPages(search, [1, 2], raw, {}, true);
      });
    }
  }
}

async function main() {
  const isWorker = process.env.SEARCH_WORKER === '1';
  const args = isWorker ? {mode: process.env.SEARCH_D3R_MODE as Mode, output: process.env.SEARCH_D3R_OUT,
    fromBackfill: process.env.SEARCH_D3R_FROM} : options(process.argv.slice(2));
  assert.ok(['smoke', 'backfill-only', 'formal', 'cleanup'].includes(args.mode));
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
  const restoreDirectory = `${out}/restore-snapshot`;
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
      save(`${out}/summary.json`, {status, mode: args.mode, manifestHash: manifest.sha256,
        label: args.mode === 'smoke' ? smokeLabel : undefined});
      note(`${status} (${out}/summary.json)`);
    });
  } finally {
    if (fromBackfill) rmSync(restoreDirectory, {recursive: true, force: true});
  }
  if (process.exitCode) note('NOT EVALUATED (run or cleanup incomplete)');
}

if (import.meta.main) await main();
