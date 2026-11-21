// Disposable per-run stack for #515 slice 5: one arm's release image, that arm's
// own compose.yml and deploy/, a fresh database, the #196 B setup shape.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Channel, CreateChannelRequest, NativeSessionResponse, SetupRequest } from '../../web/src/api-schema.d.ts';
import { dbSettings, fixture, type Arm } from './config.ts';
import { parseWalDump, type WalDumpSummary } from '../log-compare/diagnostics.ts';

const exec = promisify(execFile);
export const command = (file: string, args: string[], input?: string, env = process.env) =>
  execFileSync(file, args, { input, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
export const docker = (...args: string[]) => command('docker', args);
export const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const port = '18515';

export type Seeded = { organization: string; otherOrganization: string; reader: string; channels: string[]; tokens: string[]; password: string };
export type Stack = Awaited<ReturnType<typeof startStack>>;

// The db command keeps load/compose.yml's arguments and adds the Q2 control settings.
export function dbCommand() {
  return ['postgres', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'pg_stat_statements.track=all',
    ...Object.entries(dbSettings).flatMap(([k, v]) => ['-c', `${k}=${v}`])];
}

export async function startStack(o: { arm?: Arm; id: string; project: string; source: string; image: string; privateDir: string;
  burst: number; refill: number; labels?: Record<string, string>; port?: string; diagnostic?: boolean; }) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    LOAD_PROJECT: `${o.project}-${o.id}`.toLowerCase(), LOAD_PORT: o.port ?? port, LOAD_DB_PASSWORD: randomUUID(), LOAD_APP_PASSWORD: randomUUID(),
    LOAD_SETUP_TOKEN: randomUUID(), LOAD_APP_IMAGE: o.image, LOAD_SERVER_SOURCE: o.source,
    LOAD_SEND_BURST: String(o.burst), LOAD_SEND_REFILL_PER_SECOND: String(o.refill) };
  const override = `${o.privateDir}/compose.json`;
  writeFileSync(override, JSON.stringify({ services: {
    app: { labels: o.labels, ...(o.diagnostic && { logging: { options: { 'max-size': '40m' } } }), environment: { FUKULOW_CLIENT_IP_HEADER: 'x-load-client-ip', FUKULOW_TRUSTED_PROXIES: '0.0.0.0/0,::/0' } },
    migrate: { labels: o.labels },
    db: { labels: o.labels, command: dbCommand(), ...(o.labels && { volumes: ['db-data:/var/lib/postgresql'] }) },
  }, ...(o.labels && { networks: { default: { labels: o.labels } }, volumes: { 'db-data': { labels: o.labels } } }) }), { mode: 0o600 });
  // The arm's own load/compose.yml, so ../deploy is that arm's deploy/.
  const compose = ['compose', '--env-file', '/dev/null', '-p', env.LOAD_PROJECT!, '-f', `${o.source}/load/compose.yml`, '-f', override];
  const dc = (...args: string[]) => command('docker', [...compose, ...args], undefined, env);
  const down = () => dc('down', '--volumes', '--remove-orphans');
  try {
    dc('up', '-d', '--no-build', '--wait', ...(o.labels ? ['--pull', 'never', '--wait-timeout', '90'] : []));
  } catch (error) {
    if (!o.labels) try { down(); } catch { /* reported by the caller's cleanup */ }
    throw error;
  }
  const app = dc('ps', '-q', 'app'), db = dc('ps', '-q', 'db');
  const sql = (query: string) => command('docker', [...compose, 'exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow', '-At'], query, env);
  const address = o.port === '0' ? dc('port', 'app', '8080') : `127.0.0.1:${env.LOAD_PORT}`;
  const base = `http://${address}`;
  return { env, compose, dc, down, app, db, sql, base, network: `${env.LOAD_PROJECT}_default` };
}

async function post(base: string, path: string, body: unknown, expected: number, token?: string) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (r.status !== expected) throw new Error(`Seed ${path} status ${r.status}`);
  return r.json();
}

// #196 B shape: 1 Organization, 4,000 Members with Sessions, 200 public Channels, a second-Organization reader.
export async function seed(stack: Stack, shape: { members: number; channels: number } = fixture): Promise<Seeded & { owner: string }> {
  const password = randomUUID();
  const setup: SetupRequest = { email: 'seed@example.invalid', password, name: 'Load Owner', organization_name: 'Organization A', setup_token: stack.env.LOAD_SETUP_TOKEN! };
  await post(stack.base, '/api/v1/setup', setup, 201);
  const owner = await post(stack.base, '/api/v1/native/session', { email: 'seed@example.invalid', password }, 200) as NativeSessionResponse;
  const organization = owner.identity.organizations[0].organization_id;
  const tokens = Array.from({ length: shape.members }, () => randomBytes(32).toString('hex'));
  // Disposable fixture only: one genuine Argon2 hash copied to distinct Members and Sessions.
  stack.sql(`BEGIN;
    INSERT INTO accounts(id,email,password_hash) SELECT gen_random_uuid(),'member-'||n||'@example.invalid',password_hash FROM accounts CROSS JOIN generate_series(0,${shape.members - 1}) n WHERE email='seed@example.invalid';
    INSERT INTO users(organization_id,id,account_id,name,role) SELECT '${organization}',gen_random_uuid(),id,'Load Member','member' FROM accounts WHERE email LIKE 'member-%';
    INSERT INTO account_sessions(token_hash,account_id) VALUES ${tokens.map((t, i) => `(sha256(convert_to('${t}','UTF8')),(SELECT id FROM accounts WHERE email='member-${i}@example.invalid'))`).join(',')};
    INSERT INTO organizations(organization_id,name) VALUES(gen_random_uuid(),'Organization B');
    INSERT INTO accounts(id,email,password_hash) SELECT gen_random_uuid(),'reader@example.invalid',password_hash FROM accounts WHERE email='seed@example.invalid';
    INSERT INTO users(organization_id,id,account_id,name,role) SELECT o.organization_id,gen_random_uuid(),a.id,'Reader','owner' FROM accounts a CROSS JOIN organizations o WHERE a.email='reader@example.invalid' AND o.name='Organization B'; COMMIT;`);
  const reader = await post(stack.base, '/api/v1/native/session', { email: 'reader@example.invalid', password }, 200) as NativeSessionResponse;
  const channels: string[] = [];
  for (let i = 0; i < shape.channels; i++) {
    const body: CreateChannelRequest = { name: `load-${i}`, visibility: 'public' };
    channels.push((await post(stack.base, `/api/v1/orgs/${organization}/channels`, body, 201, owner.token) as Channel).id);
  }
  return { organization, otherOrganization: reader.identity.organizations[0].organization_id, reader: reader.token, channels, tokens, password, owner: owner.token };
}

export async function send(stack: Stack, seeded: Seeded, member: number, channel: string, body: { client_message_id: string; body: string }) {
  return post(stack.base, `/api/v1/orgs/${seeded.organization}/channels/${channel}/messages`, body, 201, seeded.tokens[member]);
}

// Cluster-wide counters bracketing a window; watched relations are the Message tables and their TOAST.
export type Snapshot = { lsn: string; wal: { records: number; fpi: number; bytes: number }; relationBytes: number; allAutovacuum: number; checkpoints: number; buffersWritten: number; statsReset: string; walReset: string;
  relations: { relid: number; name: string; autovacuum: number; autoanalyze: number }[]; workers: number };
export function snapshot(stack: Stack, watched: number[]): Snapshot {
  return JSON.parse(stack.sql(`SELECT json_build_object('lsn',pg_current_wal_lsn(),
    'wal',(SELECT json_build_object('records',wal_records,'fpi',wal_fpi,'bytes',wal_bytes) FROM pg_stat_wal),
    'relationBytes',(SELECT COALESCE(sum(pg_total_relation_size(relid)),0)::bigint FROM pg_stat_user_tables),
    'allAutovacuum',(SELECT COALESCE(sum(autovacuum_count+autoanalyze_count),0)::bigint FROM pg_stat_all_tables),
    'checkpoints',(SELECT num_timed+num_requested FROM pg_stat_checkpointer),'buffersWritten',(SELECT buffers_written FROM pg_stat_checkpointer),
    'statsReset',(SELECT stats_reset FROM pg_stat_checkpointer)::text,'walReset',(SELECT stats_reset FROM pg_stat_wal)::text,
    'relations',(SELECT COALESCE(json_agg(json_build_object('relid',relid::bigint,'name',schemaname||'.'||relname,'autovacuum',autovacuum_count,'autoanalyze',autoanalyze_count)),'[]')
      FROM pg_stat_all_tables WHERE relid = ANY(ARRAY[${watched.join(',') || 'NULL'}]::oid[])),
    'workers',(SELECT count(*) FROM pg_stat_progress_vacuum WHERE relid = ANY(ARRAY[${watched.join(',') || 'NULL'}]::oid[]))
      + (SELECT count(*) FROM pg_stat_progress_analyze WHERE relid = ANY(ARRAY[${watched.join(',') || 'NULL'}]::oid[])))`));
}
export function walWindow(stack: Stack, before: Snapshot, after: Snapshot) {
  const lsnBytes = Number(stack.sql(`SELECT pg_wal_lsn_diff('${after.lsn}','${before.lsn}')`));
  const autovacuumInside = after.relations.filter(r => { const b = before.relations.find(x => x.relid === r.relid);
    return !b || r.autovacuum !== b.autovacuum || r.autoanalyze !== b.autoanalyze; }).map(r => r.name);
  if (before.workers || after.workers) autovacuumInside.push('vacuum in progress at a boundary');
  return { lsnBytes, checkpointsInside: after.checkpoints - before.checkpoints, autovacuumInside,
    // Report-only diagnostics (pre-registered per-step captures).
    pgStatWal: { records: after.wal.records - before.wal.records, fpi: after.wal.fpi - before.wal.fpi, bytes: after.wal.bytes - before.wal.bytes },
    relationBytesDelta: after.relationBytes - before.relationBytes, autovacuumAllTables: after.allAutovacuum - before.allAutovacuum,
    statsReset: before.statsReset !== after.statsReset || before.walReset !== after.walReset || after.relations.length !== before.relations.length };
}
// Timed explicit maintenance with its own WAL (Q2/Q3 hidden-cost evidence; never in the send gate).
export function timed(stack: Stack, statement: string) {
  const start = stack.sql('SELECT pg_current_wal_lsn()'), buffers = Number(stack.sql('SELECT buffers_written FROM pg_stat_checkpointer'));
  const t0 = performance.now(); stack.sql(statement); const ms = performance.now() - t0;
  return { walBytes: Number(stack.sql(`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),'${start}')`)), ms,
    buffersWritten: Number(stack.sql('SELECT buffers_written FROM pg_stat_checkpointer')) - buffers };
}
export function walDump(stack: Stack, start: string, end: string, file: string): { status: 'available'; summary: WalDumpSummary } | { status: 'unavailable'; reason: string } {
  try {
    const bin = docker('exec', stack.db, 'pg_config', '--bindir') + '/pg_waldump';
    const raw = docker('exec', '-e', 'LC_ALL=C', stack.db, bin, '--stats=record', '--path', stack.sql('SHOW data_directory') + '/pg_wal', '--start', start, '--end', end);
    writeFileSync(file, raw);
    return { status: 'available', summary: parseWalDump(raw) };
  } catch (error) { writeFileSync(file, `UNAVAILABLE: ${String(error).slice(0, 2000)}`); return { status: 'unavailable', reason: 'pg_waldump failed' }; }
}

// 1 s CPU evidence: app and db cgroups, the VM (/proc/stat is not namespaced) and the generator's cgroup.
export type Sample = { at: number; appUsec: number; dbUsec: number; vmBusy: number; vmTotal: number; generatorUsec: number | null };
export function sampler(stack: Stack, generator: () => string | undefined, requireGenerator = true) {
  const samples: Sample[] = [], errors: number[] = [];
  let pending: Promise<void> | undefined;
  const usec = (s: string) => Number(/^usage_usec (\d+)$/m.exec(s)?.[1]);
  const tick = () => {
    if (pending) return;
    const at = Date.now(), gen = generator();
    pending = Promise.all([exec('docker', ['exec', stack.app, 'cat', '/sys/fs/cgroup/cpu.stat']),
      exec('docker', ['exec', stack.db, 'cat', '/sys/fs/cgroup/cpu.stat', '/proc/stat']),
      gen ? exec('docker', ['exec', gen, 'cat', '/sys/fs/cgroup/cpu.stat']) : Promise.resolve(undefined)])
      .then(([app, db, g]) => {
        const cpu = /^cpu\s+(.+)$/m.exec(db.stdout)?.[1].trim().split(/\s+/).map(Number) ?? [];
        const s: Sample = { at, appUsec: usec(app.stdout), dbUsec: usec(db.stdout), vmBusy: cpu.reduce((a, b) => a + b, 0) - (cpu[3] ?? NaN) - (cpu[4] ?? NaN),
          vmTotal: cpu.reduce((a, b) => a + b, 0), generatorUsec: g ? usec(g.stdout) : null };
        if (![s.appUsec, s.dbUsec, s.vmBusy, s.vmTotal].every(Number.isFinite) || cpu.length < 8 || (g && !Number.isFinite(s.generatorUsec))) throw new Error('sample');
        samples.push(s);
      }).catch(() => { errors.push(at); }).finally(() => { pending = undefined; });
  };
  tick(); const timer = setInterval(tick, 1000);
  return {
    samples, async stop() { clearInterval(timer); await pending; },
    // Evidence and CPU (percent of one core; VM percent of all VM CPUs) for a window.
    window(from: number, to: number) {
      const inside = samples.filter(s => s.at >= from && s.at < to);
      const times = [from, ...inside.map(s => s.at), to];
      const pct = (k: 'appUsec' | 'dbUsec' | 'generatorUsec') => inside.slice(1).flatMap((s, i) => s[k] === null || inside[i][k] === null ? []
        : [(s[k]! - inside[i][k]!) / ((s.at - inside[i].at) * 10)]);
      const vm = inside.slice(1).map((s, i) => 100 * (s.vmBusy - inside[i].vmBusy) / (s.vmTotal - inside[i].vmTotal));
      const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
      const generator = pct('generatorUsec');
      return { evidence: { samples: inside.length, maxSampleGapMs: Math.max(...times.slice(1).map((t, i) => t - times[i])),
        samplingErrors: errors.filter(t => t >= from && t < to).length + (requireGenerator && inside.some(s => s.generatorUsec === null) ? 1 : 0) },
        cpu: { appMean: mean(pct('appUsec')), dbMean: mean(pct('dbUsec')), generatorMean: mean(generator), vmMean: mean(vm), vmPeak: vm.length ? Math.max(...vm) : NaN } };
    },
  };
}
