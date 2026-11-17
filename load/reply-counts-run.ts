/** #409 operator entry point (repository root, pinned Node, Docker running).
 * Pilot: node load/reply-counts-run.ts --pilot --out /private/tmp/fk409p-pilot
 * Formal: node load/reply-counts-run.ts --formal --out /private/tmp/fk409p-formal
 * Builds the current release Dockerfile before any samples; no .env/Compose.
 * Four readers use absolute 25 ms deadlines (nominal 160/s), with bounded catch-up
 * of at most two intervals after a slow response; at most one request in flight
 * per reader (at most 4 concurrent requests). Comparable to #137's 136-227 pages/s;
 * no concurrent writes/subscribers, plain
 * loopback HTTP (no TLS/proxy). Static exact-count acceptance, not server capacity.
 * 3 fresh DBs/scenario; 100 warm-ups then 4x2500 samples/run. Pilot: 1/run,
 * 10 warm-ups then 4x50. First request precedes warm-up/EXPLAIN; DB buffers
 * restarted after VACUUM; host/VM file caches are NOT flushed (not cold disk).
 * Each run retains raw latencies, RLS EXPLAIN custom/generic/auto (8 executions
 * for auto), settings, host/container snapshots, source/image identity and logs.
 * New output directory must be outside checkout. SIGINT/SIGTERM clean up owned
 * fk409p-* containers/network/volume at safe boundaries; SIGKILL needs operator
 * cleanup using names in resources.json. Never removes other stacks.
 * Fixed targets: normal p95<=50ms; both long shapes p95<=200ms; every run must
 * pass. Failures never relax targets. Pilot/missing evidence cannot pass formal.
 * Below 95% of nominal 160/s invalidates an otherwise passing formal cell.
 * Expected formal wall time: 11-15 min with cached release layers; an uncached
 * Docker build adds its build time. Pilot-derived estimate, not a time budget.
 * Idle-host assessment and maintainer start signal are operator prerequisites
 * for --formal. No command schedules or automatically starts a formal run.
 */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { batch, sizing, scenarios, stats, ranges, judgement, target, seed, readers, intervalMs, nominalRate, type Run, type Scenario } from './reply-counts-model.ts';
import { measure } from './reply-counts-measure.ts';
import type { SessionResponse, SetupRequest, SignInRequest, Channel, CreateChannelRequest } from '../web/src/api-schema.d.ts';
const args = process.argv.slice(2);
const pilot = args.includes('--pilot');
if (pilot === args.includes('--formal') || args.length !== 3 || args[1] !== '--out' || !['--pilot','--formal'].includes(args[0])) throw new Error('Use --pilot|--formal --out /absolute/new/external/directory');
if (process.version !== 'v26.13.1') throw new Error('Use pinned Node 26.13.1');
const root = realpathSync('.'), out = resolve(args[2]);
if (existsSync(out) || out === root || out.startsWith(root + sep)) throw new Error('Output must be a new external directory');
mkdirSync(out, { recursive: true });
if (realpathSync(out).startsWith(root + sep)) throw new Error('Output symlink resolves into repository');
const secrets = { ownerPassword: randomBytes(32).toString('hex'), appPassword: randomBytes(32).toString('hex'), setupPassword: randomBytes(32).toString('hex'), setupToken: randomBytes(32).toString('hex') };
// Redact every artifact, including command failures and container logs, before writing.
const writeArtifact = (file: string, text: string) => writeFileSync(resolve(out, file), Object.values(secrets).reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text));
const save = (file: string, data: unknown) => writeArtifact(file, JSON.stringify(data, null, 2) + '\n');
const command = (file: string, args: string[], input?: string) => execFileSync(file, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const docker = (...a: string[]) => command('docker', a);
const asyncExec = promisify(execFile);
const prefix = `fk409p-${process.pid}-${randomUUID().slice(0, 8)}`;
const appImage = `${prefix}-app`;
const pgImage = /image: (postgres:[^\s]+)/.exec(readFileSync('load/compose.yml', 'utf8'))?.[1];
if (!pgImage) throw new Error('Pinned PostgreSQL image missing');
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; }); process.on('SIGTERM', () => { interrupted = true; });
const check = () => { if (interrupted) throw new Error('Interrupted'); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const runs: Run[] = [], cleanupErrors: string[] = [];
let complete = false;
const started = Date.now();
const owned = { network: `${prefix}-net`, volume: `${prefix}-data`, db: `${prefix}-db`, app: `${prefix}-server`, migrate: `${prefix}-migrate` };
save('resources.json', owned);
function cleanup() {
  for (const name of [owned.app, owned.migrate, owned.db]) {
    // Inspect only our exact generated names; absent resources need no deletion.
    try { docker('inspect', name); } catch { continue; }
    try { docker('rm', '-fv', name); } catch (e) { cleanupErrors.push(String(e)); }
  }
  try { docker('volume', 'inspect', owned.volume); docker('volume', 'rm', owned.volume); } catch { /* checked below */ }
  try { docker('network', 'inspect', owned.network); docker('network', 'rm', owned.network); } catch { /* checked below */ }
  for (const [kind, name] of [['volume', owned.volume], ['network', owned.network]]) {
    try { docker(kind, 'inspect', name); cleanupErrors.push(`remaining ${kind}: ${name}`); } catch { /* absent */ }
  }
}
function sql(text: string, vars: Record<string, string | number> = {}) {
  return command('docker', ['exec', '-i', owned.db, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`])], text);
}
function snapshot() {
  return { time: new Date().toISOString(), uptime: command('uptime', []), processes: command('ps', ['-axo', 'pid,pcpu,comm']), containers: docker('stats', '--no-stream', '--format', '{{json .}}') };
}
function explain(scenario: Scenario, org: string, channel: string) {
  const rust = readFileSync('server/src/messages/replies/counts.rs', 'utf8');
  const match = /const COUNTS_SQL: &str = "([\s\S]*?)";/.exec(rust);
  if (!match) throw new Error('Production COUNTS_SQL extraction failed');
  const query = match[1].replace(/\\\r?\n\s*/g, '');
  if (query.includes('\\')) throw new Error('Unsupported Rust SQL escape');
  writeArtifact('counts.sql', query + '\n');
  const ids = batch(scenario, 0).map(a => `'${a.message_id}'::uuid`).join(',');
  const call = `reply409('${org}','${channel}',ARRAY[${ids}],${sizing(scenario).messages})`;
  return ['force_custom_plan', 'force_generic_plan', 'auto'].map(mode => {
    const plan = sql(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
      SET LOCAL ROLE fukulow_app; SET LOCAL fukulow.organization_id='${org}';
      DO $$ BEGIN
        IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user)
          OR NOT row_security_active('messages') THEN RAISE EXCEPTION 'RLS inactive'; END IF;
      END $$;
      SELECT json_build_object('role',current_user,'rls',row_security_active('messages'),'mode','${mode}');
      SET LOCAL plan_cache_mode='${mode}';
      PREPARE reply409(uuid,uuid,uuid[],bigint) AS ${query};
      ${mode === 'auto' ? Array(7).fill(`EXECUTE ${call};`).join('\n') : ''}
      EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) EXECUTE ${call};
      SELECT json_build_object('custom_plans',custom_plans,'generic_plans',generic_plans) FROM pg_prepared_statements WHERE name='reply409'; ROLLBACK;`);
    return { mode, output: plan };
  });
}
try {
  console.log(`${pilot ? 'PILOT ONLY' : 'FORMAL'}: ${out}; resources ${prefix}`);
  const files = ['Dockerfile', 'Cargo.lock', 'load/compose.yml', 'deploy/db-roles.sql', 'deploy/db-role-settings.sql', 'deploy/db-grants.sql', 'server/src/messages/replies/counts.rs', 'server/src/main.rs', 'server/src/lib.rs', 'server/src/database.rs', ...readdirSync('load').filter(n => n.startsWith('reply-counts-')).map(n => `load/${n}`), ...readdirSync('server/migrations').map(n => `server/migrations/${n}`)];
  save('metadata.json', { pilot, seed, started: new Date().toISOString(), commit: command('git', ['rev-parse', 'HEAD']), dirty: command('git', ['status', '--short']),
    host: { cpus: cpus(), memory: totalmem(), platform: platform(), release: release(), arch: arch() }, node: process.version,
    docker: JSON.parse(docker('info', '--format', '{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory":{{json .MemTotal}}}')),
    pgImage, scenarios: Object.fromEntries(scenarios.map(s => [s, { ...sizing(s), targetMs: target(s) }])), readers, intervalMs, nominalRate, samples: pilot ? 200 : 10000, repeats: pilot ? 1 : 3,
    method: 'Nearest-rank; full fetch wall time through body consumption, validation excluded. Static dataset; no writes/subscribers. No proxy/TLS. First after DB restart, OS caches retained. Four readers use absolute 25 ms deadlines, nominal 160/s; bounded catch-up of at most two intervals after a slow response; at most one request in flight per reader (at most 4 concurrent requests). Formal cells below 152 samples/s cannot pass. Exact results checked every request. Default production role/pool/settings.',
    sourceHashes: Object.fromEntries(files.map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])), snapshot: snapshot() });
  writeArtifact('source.patch', command('git', ['diff', 'HEAD']));
  console.log('Building release app before measurement');
  try {
    const result = await asyncExec('docker', ['build', '--label', `org.opencontainers.image.revision=${command('git', ['rev-parse', 'HEAD'])}`, '-t', appImage, '.'], { maxBuffer: 64 * 1024 * 1024 });
    writeArtifact('build.log', result.stdout + result.stderr);
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string };
    writeArtifact('build.log', (error.stdout ?? '') + (error.stderr ?? '')); throw new Error('Release build failed; see build.log');
  }
  save('images.json', { app: docker('image', 'inspect', appImage), pg: docker('image', 'inspect', pgImage) });
  // Interleave shape order across repeats to expose host drift.
  for (let repeat = 0; repeat < (pilot ? 1 : 3); repeat++) {
    const order = [...scenarios.slice(repeat), ...scenarios.slice(0, repeat)];
    for (const scenario of order) {
      check(); const name = `${scenario}-${repeat}`; console.log(`Starting ${name}`);
      try {
        docker('network', 'create', owned.network); docker('volume', 'create', owned.volume);
        docker('run', '-d', '--name', owned.db, '--network', owned.network, '--network-alias', 'db', '--mount', `type=volume,src=${owned.volume},dst=/var/lib/postgresql`, '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=fukulow', '-e', `POSTGRES_PASSWORD=${secrets.ownerPassword}`, pgImage);
        let ready = false;
        for (let i = 0; i < 120; i++) { check(); try { docker('exec', owned.db, 'pg_isready', '-U', 'fukulow'); ready = true; break; } catch { await sleep(250); } }
        if (!ready) throw new Error('DB readiness timeout');
        const ownerUrl = `postgres://fukulow:${secrets.ownerPassword}@db/fukulow`;
        for (const action of [['migrate', 'roles'], ['migrate']]) {
          const log = docker('run', '--rm', '--name', owned.migrate, '--network', owned.network, '-e', `DATABASE_URL=${ownerUrl}`, '-e', `POSTGRES_APP_PASSWORD=${secrets.appPassword}`, appImage, 'fukulow-server', ...action);
          writeArtifact(`${name}-${action.join('-')}.log`, log);
        }
        docker('run', '-d', '--name', owned.app, '--network', owned.network, '-p', '127.0.0.1::8080', '-e', 'FUKULOW_ADDR=0.0.0.0:8080', '-e', `DATABASE_URL=postgres://fukulow_app:${secrets.appPassword}@db/fukulow`, '-e', 'FUKULOW_COOKIE_SECURE=false', '-e', `FUKULOW_SETUP_TOKEN=${secrets.setupToken}`, appImage);
        const port = docker('port', owned.app, '8080/tcp').split(':').at(-1);
        let base = `http://127.0.0.1:${port}`;
        let appReady = false;
        for (let i = 0; i < 120; i++) { check(); try { if ((await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok) { appReady = true; break; } } catch {} await sleep(250); }
        if (!appReady) throw new Error('App readiness timeout');
        const post = async (path: string, body: unknown, cookie = '') => {
          const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
          if (!response.ok) throw new Error(`Provision HTTP ${response.status} at ${path}`);
          return response;
        };
        const setup: SetupRequest = { email: 'fk409p@example.invalid', password: secrets.setupPassword, name: 'Measurement Member', organization_name: 'Reply measurement', setup_token: secrets.setupToken };
        await post('/api/v1/setup', setup);
        const credentials: SignInRequest = { email: setup.email, password: setup.password };
        const session = await post('/api/v1/session', credentials);
        const cookie = session.headers.get('set-cookie')?.split(';')[0];
        if (!cookie) throw new Error('Missing session cookie');
        const identity = (await session.json() as SessionResponse).identity;
        const org = identity.organizations[0].organization_id;
        const member = sql(`SELECT id FROM users WHERE organization_id='${org}'`);
        for (const uuid of [org, member]) if (!/^[0-9a-f-]{36}$/.test(uuid)) throw new Error('Invalid fixture UUID');
        const channelInput: CreateChannelRequest = { name: 'Measurement Channel', visibility: 'public' };
        const channel = (await (await post(`/api/v1/orgs/${org}/channels`, channelInput, cookie)).json() as Channel).id;
        if (!/^[0-9a-f-]{36}$/.test(channel)) throw new Error('Invalid Channel UUID');
        const size = sizing(scenario);
        sql(readFileSync('load/reply-counts-seed.sql', 'utf8'), { org, member, channel, longroot: size.normalMessages + 1, longreplies: size.longReplies, total: size.messages });
        if (Number(sql('SELECT count(*) FROM messages')) !== size.messages) throw new Error('Fixture cardinality mismatch');
        save(`${name}-settings.json`, { settings: JSON.parse(sql(`SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN ('shared_buffers','work_mem','jit','plan_cache_mode','max_connections','fsync','synchronous_commit','full_page_writes','effective_cache_size')`)), migrations: JSON.parse(sql(`SELECT json_agg(t) FROM (SELECT version,encode(checksum,'hex') checksum FROM _sqlx_migrations ORDER BY version)t`)),
          appRole: sql(`SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='fukulow_app'`), snapshot: snapshot() });
        // Restart only the owned database, while app is stopped, to empty shared_buffers.
        docker('stop', owned.app); docker('restart', owned.db); docker('start', owned.app);
        // Docker may reassign an ephemeral published port after stop/start.
        base = `http://127.0.0.1:${docker('port', owned.app, '8080/tcp').split(':').at(-1)}`;
        // Readiness uses /api/v1/health (no reply-count query). Account session remains valid.
        for (let i = 0; i < 120; i++) { check(); try { if ((await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} await sleep(250); }
        const result = await measure(`${base}/api/v1/orgs/${org}/channels/${channel}/reply-counts`, cookie, scenario, repeat, pilot, check);
        runs.push(result); save(`${name}-samples.json`, result);
        console.log(JSON.stringify({ name, firstMs: result.firstMs, ...stats(result.latencies), errors: result.errors, seconds: result.seconds, requestsPerSecond: result.latencies.length / result.seconds }));
        save(`${name}-plans.json`, explain(scenario, org, channel));
        save(`${name}-end.json`, snapshot());
        writeArtifact(`${name}-app.log`, docker('logs', owned.app));
        writeArtifact(`${name}-db.log`, docker('logs', owned.db));
      } finally {
        for (const [kind, container] of [['app', owned.app], ['db', owned.db]]) { try { writeArtifact(name + '-' + kind + '.log', docker('logs', container)); } catch {} }
        cleanup();
      }
    }
  }
  check(); complete = cleanupErrors.length === 0;
} catch (error) { save('failure.json', { error: String(error), stack: error instanceof Error ? error.stack : undefined, cause: error instanceof Error ? String(error.cause) : undefined }); process.exitCode = 1; }
finally {
  cleanup();
  complete = complete && cleanupErrors.length === 0;
  save('results.json', { pilot, complete, elapsedSeconds: (Date.now() - started) / 1000, runs, cleanupErrors,
    scenarios: Object.fromEntries(scenarios.map(s => [s, { targetMs: target(s), verdict: judgement(s, runs, !pilot, complete), ranges: ranges(runs.filter(r => r.scenario === s)) }])) });
  console.log(`Finished ${pilot ? 'PILOT (not acceptance)' : 'FORMAL'}; ${(Date.now() - started) / 60000} minutes; ${out}`);
}
