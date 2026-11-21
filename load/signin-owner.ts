// #359 Part B, alternative method (maintainer, 2026-11-21). One Account X (owner of Organization A),
// attacked with wrong passwords from ONE fixed client IP under the real per-IP and per-email limits,
// alongside X's own web sign-ins and password changes from a second fixed IP; Organization B reads
// throughout. Phases B0 30 s (owner only), B1 60 s (attack), B2 70 s (recovery). The pre-registered
// B1-B5 criteria are applied unchanged, but the original 50/s multi-IP attack is not reproduced, so
// the result is never a formal Part B PASS. Stack setup follows load/signin.ts, which stays unchanged
// so Part A remains reproducible from its recorded harness hashes.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { appEvidence } from './app-evidence.ts';
import { judge, type AttackOp, type LockSample, type OwnerOp, type Phase, type ReadOp } from './signin-owner-judgment.ts';
import type { ErrorBody, NativeSessionResponse, SetupRequest } from '../web/src/api-schema.d.ts';

function integer(key: string, fallback: number, max: number) {
  const value = process.env[key] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`Invalid ${key}`);
  return Number(value);
}
// Under 50/s by construction: this method does not reproduce the pre-registered 50/s attack.
const attackRate = integer('OWNER_ATTACK_RATE', 10, 49), attackInFlight = integer('OWNER_ATTACK_IN_FLIGHT', 16, 16);
const port = integer('LOAD_PORT', 18097, 65535);
if (port < 1024 || [8080, 55432].includes(port)) throw new Error('Use a non-default unprivileged LOAD_PORT');
const PHASES: [Phase, number][] = [['B0', 30_000], ['B1', 60_000], ['B2', 70_000]];
const ATTACKER_IP = '10.0.0.1', OWNER_IP = '10.0.0.2', POOL_MAX = 20, TIMEOUT_MS = 45_000;
const project = `fukulow-signin-owner-${Date.now()}-${randomUUID().slice(0, 8)}`;
const output = resolve(process.env.LOAD_RESULT_DIR || `${tmpdir()}/${project}`);
const rel = relative(resolve('.'), output);
if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('LOAD_RESULT_DIR must be outside the checkout');
if (process.env.SERVER_REF && process.env.LOAD_APP_IMAGE) throw new Error('Choose SERVER_REF or LOAD_APP_IMAGE');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(`${tmpdir()}/${project}-`);
const passwords = [randomUUID(), randomUUID()];
const wrong = `${passwords[0]}-wrong`;
const env = { ...process.env, LOAD_PROJECT: project, LOAD_PORT: String(port), LOAD_DB_PASSWORD: randomUUID(),
  LOAD_APP_PASSWORD: randomUUID(), LOAD_SETUP_TOKEN: randomUUID(), LOAD_APP_IMAGE: process.env.LOAD_APP_IMAGE || `${project}-app`,
  LOAD_SERVER_SOURCE: resolve('.') };
const override = `${scratch}/compose.json`;
// Only this disposable stack trusts the client-IP header, so the attacker and the owner each get
// one fixed address. The attacker's single address meets the real per-IP and per-email budgets.
writeFileSync(override, JSON.stringify({ services: { app: { environment: {
  FUKULOW_CLIENT_IP_HEADER: 'x-load-client-ip', FUKULOW_TRUSTED_PROXIES: '0.0.0.0/0,::/0' } } } }));
const compose = ['compose', '-p', project, '-f', resolve('load/compose.yml'), '-f', override];
const command = (file: string, args: string[], input?: string) => execFileSync(file, args,
  { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const docker = (...args: string[]) => command('docker', args);
const sql = (query: string) => command('docker', [...compose, 'exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow', '-At'], query);
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
// Waiters on X's Account row: every FOR UPDATE on accounts in this stack targets X once setup is done.
const lockQuery = `SELECT count(*) FILTER (WHERE wait_event_type='Lock' AND query ~ 'FROM accounts WHERE (email|id) = \\$1 FOR UPDATE'),
  coalesce(round(max(extract(epoch FROM clock_timestamp()-query_start)*1000) FILTER (WHERE wait_event_type='Lock'
    AND query ~ 'FROM accounts WHERE (email|id) = \\$1 FOR UPDATE')),0),
  count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename='fukulow_app' AND backend_type='client backend'`;

// observability::report logs cumulative admission rejections per kind every 60 s; keep the last report
// per kind as a server-side cross-check of the client's 503 codes (it can trail the run by up to 60 s).
function admissionRejected(log: string) {
  const last: Record<string, { count: number; at: string }> = {};
  for (const line of log.split('\n')) {
    if (!line.includes('"admission_rejected"')) continue;
    try {
      const row = JSON.parse(line), kind = row?.fields?.kind, count = row?.fields?.count;
      if (row?.fields?.event === 'admission_rejected' && typeof kind === 'string' && /^[a-z_]{1,32}$/.test(kind) && Number.isSafeInteger(count))
        last[kind] = { count, at: String(row.timestamp) };
    } catch { /* unparseable lines already make appEvidence incomplete */ }
  }
  return last;
}

const owner: OwnerOp[] = [], attack: AttackOp[] = [], reads: ReadOp[] = [], locks: LockSample[] = [];
const skipped = { owner: 0, attack: 0, reads: 0 };
let failed = false, phase = 'source', serverCommit: string | null = null, judgment: ReturnType<typeof judge> | undefined;
let sampler: ReturnType<typeof spawn> | undefined;
const cleanupErrors: string[] = [];
try {
  if (process.env.SERVER_REF) {
    serverCommit = command('git', ['rev-parse', '--verify', `${process.env.SERVER_REF}^{commit}`]);
    command('git', ['archive', '--format=tar', `--output=${scratch}/source.tar`, serverCommit]);
    mkdirSync(`${scratch}/source`);
    command('tar', ['-xf', `${scratch}/source.tar`, '-C', `${scratch}/source`]);
    env.LOAD_SERVER_SOURCE = `${scratch}/source`;
  }
  if (!process.env.SERVER_REF && !process.env.LOAD_APP_IMAGE) serverCommit = command('git', ['rev-parse', 'HEAD']);
  console.log(`Sign-in owner measurement: ${project}; artifacts: ${output}`);
  phase = 'build/start';
  docker(...compose, 'up', '-d', ...(process.env.LOAD_APP_IMAGE ? ['--no-build'] : ['--build']), '--wait');
  const app = docker(...compose, 'ps', '-q', 'app');
  const base = `http://127.0.0.1:${port}`;
  const request = async (path: string, init: RequestInit) => {
    const start = performance.now();
    let status = 0, body: unknown = null, error: string | undefined;
    try {
      const response = await fetch(base + path, { ...init, redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]) });
      status = response.status;
      const text = await response.text();
      if (status === 200 && text) body = JSON.parse(text);
      // Keep only the ErrorBody code (a server constant) to classify rejections, e.g. each 503's cause.
      if (status >= 400) {
        try { const code = (JSON.parse(text) as Partial<ErrorBody>).error; error = typeof code === 'string' && /^[a-z0-9_ ]{1,64}$/.test(code) ? code : 'unrecognised_error_body'; }
        catch { error = text ? 'unrecognised_error_body' : 'no_error_body'; }
      }
    } catch { status = 0; }
    return { status, body, error, ms: performance.now() - start, end: performance.now() };
  };
  const json = (ip: string | null, token?: string) => ({ 'Content-Type': 'application/json',
    ...(ip ? { 'X-Load-Client-IP': ip } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  phase = 'seed';
  const setup: SetupRequest = { email: 'owner@example.invalid', password: passwords[0], name: 'Owner X',
    organization_name: 'Organization A', setup_token: env.LOAD_SETUP_TOKEN };
  if ((await request('/api/v1/setup', { method: 'POST', headers: json(null), body: JSON.stringify(setup) })).status !== 201) throw new Error('setup');
  sql(`BEGIN;
    INSERT INTO organizations(organization_id,name) VALUES(gen_random_uuid(),'Organization B');
    INSERT INTO accounts(id,email,password_hash) SELECT gen_random_uuid(),'reader@example.invalid',password_hash FROM accounts WHERE email='owner@example.invalid';
    INSERT INTO users(organization_id,id,account_id,name,role)
      SELECT o.organization_id,gen_random_uuid(),a.id,'Load Reader','owner' FROM accounts a CROSS JOIN organizations o
      WHERE a.email='reader@example.invalid' AND o.name='Organization B'; COMMIT;`);
  const reader = await request('/api/v1/native/session', { method: 'POST', headers: json('10.0.0.3'),
    body: JSON.stringify({ email: 'reader@example.invalid', password: passwords[0] }) });
  const readerBody = reader.body as NativeSessionResponse | null;
  const organization = readerBody?.identity.organizations[0]?.organization_id;
  if (reader.status !== 200 || !readerBody || !organization) throw new Error('reader');
  const ownerSession = await request('/api/v1/native/session', { method: 'POST', headers: json(OWNER_IP),
    body: JSON.stringify({ email: setup.email, password: passwords[0] }) });
  const ownerToken = (ownerSession.body as NativeSessionResponse | null)?.token;
  if (ownerSession.status !== 200 || !ownerToken) throw new Error('owner session');
  writeFileSync(`${output}/metadata.json`, JSON.stringify({ project, method: 'alternative (single attacker IP, real limits)',
    formal: false, attackRate, attackInFlight, phases: PHASES, attackerIp: ATTACKER_IP, ownerIp: OWNER_IP, poolMax: POOL_MAX,
    port, node: process.version, serverRef: process.env.SERVER_REF ?? null, serverCommit,
    serverDirty: process.env.SERVER_REF || process.env.LOAD_APP_IMAGE ? null : command('git', ['status', '--porcelain']),
    imageTag: env.LOAD_APP_IMAGE, appImage: docker('inspect', '--format', '{{.Image}}', app),
    started: new Date().toISOString(), platform: platform(), arch: arch(), hostCpus: cpus().length, hostMemory: totalmem(),
    harness: Object.fromEntries(['load/signin-owner.ts', 'load/signin-owner-judgment.ts', 'load/app-evidence.ts', 'load/compose.yml']
      .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) }, null, 2));

  phase = 'workload';
  const t0 = performance.now(), wallStart = Date.now();
  const startAt: Record<Phase, number> = { B0: 0, B1: PHASES[0][1], B2: PHASES[0][1] + PHASES[1][1] };
  const total = PHASES.reduce((sum, [, ms]) => sum + ms, 0);
  const phaseOf = (ms: number): Phase => ms < startAt.B1 ? 'B0' : ms < startAt.B2 ? 'B1' : 'B2';
  sampler = spawn('docker', [...compose, 'exec', '-T', '-e', `Q=${lockQuery}`, 'db', 'sh', '-c',
    'while :; do psql -X -U fukulow -d fukulow -At -F "|" -c "$Q" || exit 1; sleep 0.2; done'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let samplerExited = false;
  sampler.on('exit', () => { samplerExited = true; });
  let partial = '';
  sampler.stdout?.on('data', chunk => {
    const lines = (partial + String(chunk)).split('\n'); partial = lines.pop() ?? '';
    for (const line of lines) {
      const m = /^(\d+)\|(\d+)\|(\d+)$/.exec(line.trim());
      if (m) locks.push({ atMs: performance.now() - t0, waiters: Number(m[1]), maxWaitMs: Number(m[2]), connections: Number(m[3]) });
    }
  });
  const pending = new Set<Promise<void>>();
  const track = (task: Promise<void>) => { pending.add(task); task.finally(() => pending.delete(task)); };
  let ownerBusy = false, attackActive = 0, readActive = 0, current = 0;
  let nextSignin = 0, nextPassword = 5_000, nextAttack = startAt.B1, nextRead = 0;
  while (!controller.signal.aborted) {
    const now = performance.now() - t0;
    if (now >= total) break;
    // At most one owner operation in flight; a due one is skipped (and counted) if the previous runs on.
    for (const due of ['signin', 'password'] as const) {
      const next = due === 'signin' ? nextSignin : nextPassword;
      if (now < next) continue;
      if (due === 'signin') nextSignin += 2_000; else nextPassword += 10_000;
      if (ownerBusy) { skipped.owner++; continue; }
      ownerBusy = true;
      const at = phaseOf(now);
      track((async () => {
        const target = 1 - current;
        const r = due === 'signin'
          ? await request('/api/v1/session', { method: 'POST', headers: json(OWNER_IP),
            body: JSON.stringify({ email: setup.email, password: passwords[current] }) })
          : await request('/api/v1/me/password', { method: 'PUT', headers: json(OWNER_IP, ownerToken),
            body: JSON.stringify({ current_password: passwords[current], new_password: passwords[target] }) });
        if (due === 'password' && r.status === 204) current = target;
        owner.push({ kind: due, phase: at, status: r.status, ms: r.ms, endMs: r.end - t0, error: r.error });
      })().finally(() => { ownerBusy = false; }));
    }
    while (now >= nextAttack && nextAttack < startAt.B2 && now < startAt.B2) {
      nextAttack += 1000 / attackRate;
      if (attackActive >= attackInFlight) { skipped.attack++; continue; }
      attackActive++;
      track((async () => {
        const r = await request('/api/v1/native/session', { method: 'POST', headers: json(ATTACKER_IP),
          body: JSON.stringify({ email: setup.email, password: wrong }) });
        attack.push({ phase: 'B1', status: r.status, ms: r.ms, endMs: r.end - t0, error: r.error });
      })().finally(() => { attackActive--; }));
    }
    while (now >= nextRead) {
      nextRead += 500;
      if (readActive >= 4) { skipped.reads++; continue; }
      readActive++;
      const at = phaseOf(now);
      track((async () => {
        const r = await request(`/api/v1/orgs/${organization}/channels`, { method: 'GET', headers: { Authorization: `Bearer ${readerBody.token}` } });
        reads.push({ phase: at, status: r.status, ms: r.ms, error: r.error });
      })().finally(() => { readActive--; }));
    }
    await pause(2);
  }
  await Promise.all(pending);
  const endMs = performance.now() - t0;
  // A sampler that stopped early would leave a phase with too few lock and connection samples.
  if (samplerExited) throw new Error('sampler exited');
  sampler.kill(); sampler = undefined;
  if (controller.signal.aborted) throw new Error('interrupted');
  await pause(2500);
  const logs = docker(...compose, 'logs', '--no-color', '--no-log-prefix', 'app');
  const evidence = appEvidence(logs, wallStart, wallStart + endMs);
  const poolTimeouts = (evidence.pool?.deltas.acquire_timeout ?? 0) + evidence.databaseFailures.pool_timeout;
  judgment = judge({ owner, attack, reads, locks, phaseStartMs: startAt, endMs, poolMax: POOL_MAX,
    server: { poolTimeouts, panics: evidence.panics, complete: evidence.complete } });
  writeFileSync(`${output}/server-evidence.json`, JSON.stringify({ pool: evidence.pool, databaseFailures: evidence.databaseFailures,
    http5xx: evidence.http5xx, panics: evidence.panics, otherWarnings: evidence.otherWarnings, complete: evidence.complete,
    reasons: evidence.reasons, admissionRejected: admissionRejected(logs) }, null, 2));
  console.log('SIGNIN_OWNER_JUDGMENT ' + JSON.stringify({ formal: false, allPass: judgment.allPass, incomplete: judgment.incomplete,
    checks: judgment.checks, causes: judgment.causes, skipped }));
} catch {
  // Child-process errors can include environment or SQL. Never serialize raw errors.
  failed = true;
  console.error(`Sign-in owner measurement failed during ${phase}; credentials/errors suppressed.`);
} finally {
  sampler?.kill();
  writeFileSync(`${output}/results.json`, JSON.stringify({ complete: !failed, phase, formal: false, skipped,
    owner, attack, reads, locks, judgment }, null, 2));
  try { docker(...compose, 'down', '--volumes'); } catch { cleanupErrors.push('Compose cleanup failed'); }
  if (!process.env.LOAD_APP_IMAGE) {
    try { if (docker('image', 'ls', '-q', env.LOAD_APP_IMAGE)) docker('image', 'rm', env.LOAD_APP_IMAGE); }
    catch { cleanupErrors.push('Image cleanup failed'); }
  }
  rmSync(scratch, { recursive: true, force: true });
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  console.log(`Results: ${output}`);
}
if (cleanupErrors.length) console.error(cleanupErrors.join('; '));
process.exitCode = failed || cleanupErrors.length ? 1 : 0;
