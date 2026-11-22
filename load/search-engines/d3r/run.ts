import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { arch, cpus, totalmem } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmark, command, CommandTimeoutError, docker, save, sql } from '../bench.ts';
import { probeSql } from '../definer.ts';
import { resolveImage, smokeLabel, verifySession } from '../manifest.ts';
import { ownedContainer, ownedVolume, ownershipLabel, refuseLeftovers, supervise } from '../runtime.ts';
import { copySql, finishSql, fixtureSql, generate, literal, member, org } from '../seed.ts';
import { accepts, completeness, denials, judge, type Evidence, type Round } from './acceptance.ts';
import { backfill, verifyTerms } from './backfill.ts';
import { allPages, explainPage, prepare } from './engine.ts';
import { argumentsForPostgres, loadManifest } from './manifest.ts';
import { benchmarkScript, productionPath, readSource, sources } from './path.ts';
import { withSession } from './session.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const note = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
type Mode = 'smoke' | 'backfill-only' | 'formal';

export function options(argv: string[]) {
  let mode: Mode = 'formal';
  let output: string | undefined;
  for (const arg of argv) {
    if ((arg === '--smoke' || arg === '--backfill-only') && mode === 'formal') mode = arg.slice(2) as Mode;
    else if (arg.startsWith('--out=') && !output && arg.length > 6) output = arg.slice(6);
    else throw new Error(`Unexpected or duplicate argument ${arg}. Use [--smoke | --backfill-only] [--out=PATH].`);
  }
  return {mode, output};
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

async function worker(mode: Mode, out: string, {frozen, sha256}: ReturnType<typeof loadManifest>) {
  mkdirSync(out, {mode: 0o700});
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
  docker('volume', 'create', '--label', ownershipLabel, volume);
  command('docker', ['run', '-d', '--label', ownershipLabel, '--name', container, '--network=none',
    `--shm-size=${frozen.shmBytes}`, '--mount', `type=volume,source=${volume},target=/var/lib/postgresql`,
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=postgres', id, ...argumentsForPostgres],
  undefined, {...process.env, POSTGRES_PASSWORD: randomUUID()});

  async function awaitReady() {
    for (let i = 0; i < frozen.timing.startupAttempts; i++) {
      try {
        docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'fukulow', '-d', 'postgres');
        return;
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
  const role = readSource('deploy/db-roles.sql');
  const roleSettings = readSource('deploy/db-role-settings.sql');
  const grants = readSource('deploy/db-grants.sql');
  owner('postgres', `BEGIN;\n${roleSettings}\nSET LOCAL fukulow.app_password = '${randomUUID()}';\n${role}\nCOMMIT;`);
  const engine = readSource(sources.engine);
  const openApp = <T>(db: string, body: Parameters<typeof withSession<T>>[3]) => withSession(container, db, true, body);
  const openOwner = <T>(db: string, body: Parameters<typeof withSession<T>>[3]) => withSession(container, db, false, body);

  function verifyRls(db: string) {
    const session = verifySession(text => app(db, text), 'app', frozen.sessionPolicy.appSettings);
    const facts = app(db, `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user;
      SELECT count(*) FROM pg_auth_members WHERE member=current_user::regrole;
      SELECT count(*) FROM pg_class c WHERE c.oid IN
        ('messages'::regclass, 'message_search_terms'::regclass, 'users'::regclass,
        'channels'::regclass, 'channel_members'::regclass) AND row_security_active(c.oid);
      SELECT relforcerowsecurity FROM pg_class WHERE oid = 'message_search_terms'::regclass;
      SELECT count(*) FROM pg_proc WHERE oid IN ('public.fukulow_search_terms(text)'::regprocedure,
        'public.fukulow_search_normalize(text)'::regprocedure) AND prosecdef;`);
    assert.equal(facts, 'fukulow_app|f|f\n0\n5\nt\n0', 'd3r app role or RLS settings differ');
    return {session, facts};
  }

  function create(db: string) {
    owner('postgres', `CREATE DATABASE ${db} TEMPLATE template0;`);
    for (const migration of frozen.migrations) owner(db, `BEGIN;\n${readSource(migration)}\nCOMMIT;`);
    owner(db, grants);
    const verification = verifyRls(db);
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
    assert.ok(record.verification.equal, 'INVALID: backfill verification mismatch');
    return record;
  }

  async function complete(db: string) {
    return openApp(db, async search => {
      await search(prepare(path.page));
      return completeness(search);
    });
  }

  async function restoreDrill() {
    phase('restore', 'started');
    create('small');
    seedDb('small', conditions.restoreRows);
    const indexed = await fill('small', conditions.restoreRows);
    owner('small', 'VACUUM ANALYZE public.message_search_terms;');
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
    const rls = {settings: verifyRls('restored'), cleanup: rlsCleanup('restored')};
    const after = checksum('restored');
    const restoredTermRows = Number(owner('restored', 'SELECT count(*) FROM public.message_search_terms;'));
    const terms = await openOwner('restored', own => verifyTerms(own, conditions.restoreRows, restoredTermRows));
    const evidence = {restoreMs, before, after, rls, terms, checksumEqual: before === after,
      termsEqual: terms.equal && restoredTermRows === indexed.termRows,
      complete: await complete('restored')};
    save(`${out}/restore.json`, evidence);
    owner('postgres', 'DROP DATABASE restored; DROP DATABASE small;');
    phase('restore', 'finished');
    return evidence;
  }

  function rlsCleanup(db: string) {
    const present = (where = '') => `SELECT EXISTS (SELECT 1 FROM messages ${where}),
      EXISTS (SELECT 1 FROM message_search_terms ${where});`;
    const facts = app(db, `BEGIN;
      SELECT set_config('fukulow.organization_id', '${org(1)}', true);
      ${present()}
      ${present(`WHERE organization_id = '${org(2)}'`)}
      COMMIT;
      ${present()}
      BEGIN;
      SELECT set_config('fukulow.account_id', '${member(1, 2)}', true);
      ${present()}
      COMMIT;
      ${present()}`);
    assert.equal(facts, [org(1), 't|t', 'f|f', 'f|f', member(1, 2), 'f|f', 'f|f'].join('\n'));
    return facts;
  }

  const rls = create('measured');
  seedDb('measured', conditions.rows);
  await fill('measured', conditions.rows);
  const completion = {manifestHash: sha256, runKind: mode, at: new Date().toISOString(),
    label: mode === 'smoke' ? smokeLabel : undefined};
  if (mode === 'backfill-only') {
    save(`${out}/completed.json`, completion);
    return;
  }

  owner('measured', 'VACUUM ANALYZE public.message_search_terms;');
  save(`${out}/rls.json`, rls);
  const restore = await restoreDrill();
  create('denial');
  owner('denial', probeSql);
  await fill('denial', 20_011);
  owner('denial', 'VACUUM ANALYZE public.message_search_terms;');
  const denialReport = await openApp('denial', async search => {
    await search(prepare(path.page));
    return denials(search);
  });
  save(`${out}/denials.json`, denialReport);
  owner('postgres', 'DROP DATABASE denial;');

  const {querySet} = conditions;
  const rounds: Round[] = [];
  const plans: Evidence['plans'] = [];
  let found: Evidence['complete'] = [];
  for (let round = 1; round <= conditions.rounds; round++) {
    const dest = `${out}/round-${round}`;
    mkdirSync(dest);
    docker('restart', container);
    await awaitReady();
    verifyRls('measured');
    phase(`round ${round}`, 'started');
    await openApp('measured', async search => {
      await search(prepare(path.page));
      for (let sweep = 0; sweep < conditions.warmupSweeps; sweep++) {
        for (const [, raw] of querySet) await allPages(search, [1, 2], raw, {}, true);
      }
    });
    const latencies = [];
    for (const [query, raw] of querySet) {
      const result = await benchmark(container, 'measured', benchmarkScript(path.page, raw, accepts(query)), `${dest}/${query}`,
        conditions.transactions, conditions.clients);
      latencies.push({query, ...result});
      phase(`round ${round}`, `${query} p95=${result.p95.toFixed(3)} ms`);
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
    phase(`round ${round}`, 'finished');
  }
  const evidence: Evidence = {valid: true, formal: mode === 'formal', backfill: true, rounds, plans, complete: found,
    denials: denialReport, restore};
  save(`${out}/evidence.json`, evidence);
  save(`${out}/completed.json`, completion);
  phase('run', 'completed');
}

async function main() {
  const isWorker = process.env.SEARCH_WORKER === '1';
  const args = isWorker ? { mode: process.env.SEARCH_D3R_MODE as Mode, output: process.env.SEARCH_D3R_OUT }
    : options(process.argv.slice(2));
  assert.ok(['smoke', 'backfill-only', 'formal'].includes(args.mode));
  const out = outputPath(args.output ?? `/private/tmp/fukulow-d3r-689-${Date.now()}`);
  process.chdir(root);
  const manifest = loadManifest();
  if (!isWorker) {
    if (args.mode === 'smoke') process.env.SEARCH_SMOKE = '1';
    else delete process.env.SEARCH_SMOKE;
    refuseLeftovers(docker);
  }
  process.env.SEARCH_D3R_MODE = args.mode;
  process.env.SEARCH_D3R_OUT = out;
  if (await supervise(import.meta.url, out, manifest.sha256, () => {
    const run = JSON.parse(readFileSync(`${out}/run-status.json`, 'utf8'));
    assert.ok(run.valid && run.cleanupVerified && run.manifestHash === manifest.sha256);
    const status = args.mode === 'formal'
      ? judge(JSON.parse(readFileSync(`${out}/evidence.json`, 'utf8'))) : 'NOT EVALUATED';
    save(`${out}/summary.json`, {status, mode: args.mode, manifestHash: manifest.sha256,
      label: args.mode === 'smoke' ? smokeLabel : undefined});
    note(`${status} (${out}/summary.json)`);
  })) await worker(args.mode, out, manifest);
  else if (process.exitCode) note('NOT EVALUATED (run or cleanup incomplete)');
}

if (import.meta.main) await main();
