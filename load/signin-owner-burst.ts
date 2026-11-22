// #756 burst mode of the #359 owner harness (load/signin-owner.ts stays byte-identical, so the #359 runs
// stay reproducible from their recorded hashes). One attacker IP sends 16 wrong passwords for X at each
// email-window open while X's owner signs in and runs password change / revoke-others from Session S0;
// Organization B reads throughout. The PostgreSQL lock-wait log gives exact waits on X's Account row.
// Method and criteria: issue #756 comment 7075307714 (approved 2026-11-22). Run from the repository root:
//   node load/signin-owner-burst.ts --smoke|--rehearsal|--recorded --harness-commit SHA --out /abs/new/dir
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { appEvidence } from './app-evidence.ts';
import { assertDockerHeadroom, assertNewOutput, assertPinned } from './harness-core/host.ts';
import { stages } from './harness-core/stages.ts';
import { outsideCheckout } from './proxy-target.ts';
import { admissionRejected, errorCode, type Phase } from './signin-owner-judgment.ts';
import { ATTACKER_IP, BURST, LOCK_LOG_SETTINGS, LOGGING_NOTE, OWNER_EMAIL, OWNER_IP, POOL_MAX, READER_IP, SAMPLER, SCHEDULE,
  TIMEOUT_MS, disposableOverride, parseBurstArgs, parseBurstEnv } from './signin-owner-burst-config.ts';
import { attribute, clockOffset, mergeWaits, parseLockLog, parseSamplerLine, samplerIntervals, samplerQuery, xWaits,
  type SamplerRow } from './signin-owner-burst-locks.ts';
import { aggregate, judgeBurst, type Burst, type BurstAttackOp, type BurstOwnerOp, type BurstReadOp, type BurstRun,
  type OwnerKind, type XWait } from './signin-owner-burst-judgment.ts';
import { report } from './signin-owner-burst-report.ts';
import type { NativeSessionResponse, SetupRequest } from '../web/src/api-schema.d.ts';

// Harness-generated reasons only; child-process errors can carry environment or SQL and are never printed.
class Stop extends Error {}
process.chdir(realpathSync(fileURLToPath(new URL('../', import.meta.url))));
const { mode, out, harnessCommit, plan } = parseBurstArgs(process.argv.slice(2));
const { port, serverRef, appImage } = parseBurstEnv(process.env);
const output = outsideCheckout(out);
assertNewOutput(output);
mkdirSync(output, { recursive: true, mode: 0o700 });
const run = stages(output, mode);
const project = `fukulow-signin-burst-${Date.now()}-${randomUUID().slice(0, 8)}`;
const scratch = mkdtempSync(`${tmpdir()}/${project}-`);
const passwords = [randomUUID(), randomUUID()], wrong = `${passwords[0]}-wrong`;
const env = { ...process.env, LOAD_PROJECT: project, LOAD_PORT: String(port), LOAD_DB_PASSWORD: randomUUID(),
  LOAD_APP_PASSWORD: randomUUID(), LOAD_SETUP_TOKEN: randomUUID(), LOAD_APP_IMAGE: appImage || `${project}-app`,
  LOAD_SERVER_SOURCE: process.cwd() };
writeFileSync(`${scratch}/compose.json`, JSON.stringify(disposableOverride()));
const compose = ['compose', '-p', project, '-f', 'load/compose.yml', '-f', `${scratch}/compose.json`];
const command = (file: string, args: string[], input?: string) => execFileSync(file, args,
  { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
const docker = (...args: string[]) => command('docker', args);
const psql = ['exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow', '-At', '-F', '|'];
const sql = (query: string) => command('docker', [...compose, ...psql], query);
// PostgreSQL logs to stderr; take both streams so the lock-wait lines are never lost to stream routing.
const dbLog = () => {
  const r = spawnSync('docker', [...compose, 'logs', '--no-color', '--no-log-prefix', 'db'], { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Stop('db logs unavailable');
  return `${r.stdout}\n${r.stderr}`;
};
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);

const owner: BurstOwnerOp[] = [], attack: BurstAttackOp[] = [], reads: BurstReadOp[] = [], bursts: Burst[] = [], samples: SamplerRow[] = [];
const skipped: Record<string, number> = { web_signin: 0, native_signin: 0, password: 0, revoke: 0, reads: 0 };
const meta: Record<string, unknown> = { project, mode, evidenceEligible: mode === 'recorded', plan, burst: BURST, schedule: SCHEDULE,
  sampler: SAMPLER, attackerIp: ATTACKER_IP, ownerIp: OWNER_IP, poolMax: POOL_MAX, port, node: process.version, serverRef,
  harnessCommit, lockLogSettings: LOCK_LOG_SETTINGS, loggingNote: LOGGING_NOTE, platform: platform(), arch: arch(),
  hostCpus: cpus().length, hostMemory: totalmem() };
const saveMeta = () => writeFileSync(`${output}/metadata.json`, JSON.stringify(meta, null, 2) + '\n');
let results: Record<string, unknown> = {};
let failed = false, sampler: ReturnType<typeof spawn> | undefined, stoppedEarly: string | null = null;
const cleanupErrors: string[] = [];
try {
  run.enter('source');
  if (mode === 'recorded') assertPinned(args => command('git', args), harnessCommit!);
  meta.harness = Object.fromEntries(['load/signin-owner-burst.ts', 'load/signin-owner-burst-config.ts', 'load/signin-owner-burst-locks.ts',
    'load/signin-owner-burst-judgment.ts', 'load/signin-owner-burst-report.ts', 'load/signin-owner-judgment.ts', 'load/signin-summary.ts',
    'load/app-evidence.ts', 'load/compose.yml', 'load/harness-core/stages.ts', 'load/harness-core/host.ts']
    .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  if (serverRef) {
    meta.serverCommit = command('git', ['rev-parse', '--verify', `${serverRef}^{commit}`]);
    command('git', ['archive', '--format=tar', `--output=${scratch}/source.tar`, String(meta.serverCommit)]);
    mkdirSync(`${scratch}/source`);
    command('tar', ['-xf', `${scratch}/source.tar`, '-C', `${scratch}/source`]);
    env.LOAD_SERVER_SOURCE = `${scratch}/source`;
  } else if (!appImage) {
    meta.serverCommit = command('git', ['rev-parse', 'HEAD']);
    meta.serverDirty = command('git', ['status', '--porcelain']) !== '';
  }
  saveMeta();
  run.enter('build/start');
  docker(...compose, 'up', '-d', ...(appImage ? ['--no-build'] : ['--build']), '--wait');
  meta.imageTag = env.LOAD_APP_IMAGE;
  meta.appImage = docker('inspect', '--format', '{{.Image}}', docker(...compose, 'ps', '-q', 'app'));
  if (plan.headroom) {
    run.enter('headroom');
    const pg = /\n  db:\n    image: (\S+)/.exec(readFileSync('load/compose.yml', 'utf8'))?.[1];
    if (!pg) throw new Stop('db image not found in load/compose.yml');
    meta.headroom = assertDockerHeadroom(pg, 2 * 1024 ** 3);
  }
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
      if (status >= 400) error = errorCode(text);
    } catch { status = 0; }
    return { status, body, error, start, end: performance.now() };
  };
  const json = (ip: string | null, token?: string) => ({ 'Content-Type': 'application/json',
    ...(ip ? { 'X-Load-Client-IP': ip } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) });

  run.enter('seed');
  const setup: SetupRequest = { email: OWNER_EMAIL, password: passwords[0], name: 'Owner X', organization_name: 'Organization A',
    setup_token: env.LOAD_SETUP_TOKEN };
  if ((await request('/api/v1/setup', { method: 'POST', headers: json(null), body: JSON.stringify(setup) })).status !== 201) throw new Stop('setup');
  sql(`BEGIN;
    INSERT INTO organizations(organization_id,name) VALUES(gen_random_uuid(),'Organization B');
    INSERT INTO accounts(id,email,password_hash) SELECT gen_random_uuid(),'reader@example.invalid',password_hash FROM accounts WHERE email='${OWNER_EMAIL}';
    INSERT INTO users(organization_id,id,account_id,name,role)
      SELECT o.organization_id,gen_random_uuid(),a.id,'Load Reader','owner' FROM accounts a CROSS JOIN organizations o
      WHERE a.email='reader@example.invalid' AND o.name='Organization B'; COMMIT;`);
  const reader = await request('/api/v1/native/session', { method: 'POST', headers: json(READER_IP),
    body: JSON.stringify({ email: 'reader@example.invalid', password: passwords[0] }) });
  const readerBody = reader.body as NativeSessionResponse | null;
  const organization = readerBody?.identity.organizations[0]?.organization_id;
  if (reader.status !== 200 || !readerBody || !organization) throw new Stop('reader');
  // Session S0, created before B0; revoke-others keeps it, password change keeps the current Session.
  const s0 = await request('/api/v1/native/session', { method: 'POST', headers: json(OWNER_IP),
    body: JSON.stringify({ email: OWNER_EMAIL, password: passwords[0] }) });
  const s0Token = (s0.body as NativeSessionResponse | null)?.token;
  if (s0.status !== 200 || !s0Token) throw new Stop('owner session S0');

  // Fail fast after setup: the approved settings are live, and the parser finds a real wait on X's row.
  run.enter('lock-log check');
  const [lockWaits, deadlock, prefix, zone, preload] = sql(`SELECT current_setting('log_lock_waits'), current_setting('deadlock_timeout'),
    current_setting('log_line_prefix'), current_setting('log_timezone'), current_setting('shared_preload_libraries')`).split('|');
  meta.pgSettings = { log_lock_waits: lockWaits, deadlock_timeout: deadlock, log_line_prefix: prefix, log_timezone: zone, shared_preload_libraries: preload };
  if (lockWaits !== 'on' || deadlock !== '10ms' || prefix !== '%m [%p]' && prefix !== '%m [%p] ' || zone !== 'UTC' || !preload.includes('pg_stat_statements'))
    throw new Stop('lock-log settings not active');
  const [accountsOid, databaseOid] = sql(`SELECT 'accounts'::regclass::oid, (SELECT oid FROM pg_database WHERE datname = current_database())`).split('|').map(Number);
  const ctids = new Set([sql(`SELECT ctid FROM accounts WHERE email = '${OWNER_EMAIL}'`)]);
  const holder = spawn('docker', [...compose, ...psql], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  const holderDone = new Promise<number | null>(done => holder.on('exit', code => done(code)));
  holder.stdin?.end(`BEGIN; SELECT 1 FROM accounts WHERE email = '${OWNER_EMAIL}' FOR UPDATE; SELECT pg_sleep(2); COMMIT;\n`);
  for (let i = 0; ; i++) {
    if (sql(`SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE 'SELECT pg_sleep(2)%'`) === '1') break;
    if (i > 100) throw new Stop('lock probe holder did not start');
    await pause(100);
  }
  sql(`SELECT 1 FROM accounts WHERE email = '${OWNER_EMAIL}' FOR UPDATE;`);
  if (await holderDone !== 0) throw new Stop('lock probe holder failed');
  await pause(500);
  const probe = xWaits(parseLockLog(dbLog()).events, { accountsOid, databaseOid, ctids });
  meta.lockProbe = { waits: probe.waits.map(w => ({ lock: w.lock, waitedMs: w.waitedMs })), unmatched: probe.unmatched, foreign: probe.foreign };
  if (!probe.waits.some(w => w.lock === 'transaction' && w.waitedMs > 10) || probe.unmatched || probe.foreign) throw new Stop('lock probe wait not parsed');
  saveMeta();

  run.enter('sampler start');
  const clock = performance.now();
  sampler = spawn('docker', [...compose, 'exec', '-T', 'db', 'psql', '-XAt', '-P', 'pager=off', '-P', 'footer=off', '-F', '|',
    '-U', 'fukulow', '-d', 'fukulow'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let samplerExited = false, partial = '', t0 = clock;
  sampler.on('exit', () => { samplerExited = true; });
  sampler.stdout?.on('data', chunk => {
    const at = performance.now() - t0, lines = (partial + String(chunk)).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const row = parseSamplerLine(line, at);
      if (row) { samples.push(row); if (row.ctid) ctids.add(row.ctid); }
    }
  });
  sampler.stdin?.end(`${samplerQuery(OWNER_EMAIL)}\n\\watch ${SAMPLER.watchSeconds}\n`);
  for (let i = 0; samples.length < 10; i++) {
    if (samplerExited || i > 200) throw new Stop('sampler produced no rows');
    await pause(50);
  }

  run.enter('workload');
  meta.started = new Date().toISOString(); saveMeta();
  run.startSampling();
  samples.length = 0;
  t0 = performance.now();
  const wallStart = Date.now(), now = () => performance.now() - t0;
  const until = async (ms: number) => { while (now() < ms && !controller.signal.aborted) await pause(Math.min(2, Math.max(0, ms - now()))); };
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>) => { pending.add(task); task.finally(() => pending.delete(task)); return task; };
  let ownerBusy = false, current = 0, readActive = 0;
  const ownerOp = (kind: OwnerKind, burst?: number) => {
    ownerBusy = true;
    track((async () => {
      const target = 1 - current;
      const r = kind === 'web_signin' || kind === 'native_signin'
        ? await request(kind === 'web_signin' ? '/api/v1/session' : '/api/v1/native/session', { method: 'POST', headers: json(OWNER_IP),
          body: JSON.stringify({ email: OWNER_EMAIL, password: passwords[current] }) })
        : kind === 'password'
          ? await request('/api/v1/me/password', { method: 'PUT', headers: json(OWNER_IP, s0Token),
            body: JSON.stringify({ current_password: passwords[current], new_password: passwords[target] }) })
          : await request('/api/v1/me/sessions/revoke-others', { method: 'POST', headers: json(OWNER_IP, s0Token),
            body: JSON.stringify({ current_password: passwords[current] }) });
      if (kind === 'password' && r.status === 204) current = target;
      owner.push({ kind, sentMs: r.start - t0, endMs: r.end - t0, ms: r.end - r.start, status: r.status, error: r.error,
        ...(burst === undefined ? {} : { burst }) });
    })().finally(() => { ownerBusy = false; }));
  };
  const sendBurst = async (index: number) => {
    const burst: Burst = { index, sends: [], admittedSend: null, ownerOp: 'missing', ownerOpSend: null };
    bursts.push(burst);
    for (let send = 0; send <= BURST.maxResends && !controller.signal.aborted; send++) {
      if (send) await until(burst.sends[send - 1].sentMs + BURST.resendMs);
      const sentMs = now(), statuses: number[] = [];
      burst.sends.push({ sentMs, statuses });
      const responses = Array.from({ length: BURST.size }, () => request('/api/v1/native/session', { method: 'POST',
        headers: json(ATTACKER_IP), body: JSON.stringify({ email: OWNER_EMAIL, password: wrong }) }).then(r => {
        statuses.push(r.status);
        attack.push({ burst: index, send, sentMs: r.start - t0, endMs: r.end - t0, ms: r.end - r.start, status: r.status, error: r.error });
      }));
      if (burst.ownerOp === 'missing') {
        await until(sentMs + BURST.ownerOffsetMs);
        // A send whose 16 answers are all back as 429 by now admitted nothing; any other send is admitted.
        if (!(statuses.length === BURST.size && statuses.every(s => s === 429))) {
          burst.ownerOpSend = send;
          if (ownerBusy) burst.ownerOp = 'skipped';
          else { burst.ownerOp = 'sent'; ownerOp(index % 2 ? 'password' : 'revoke', index); }
        }
      }
      await Promise.all(responses);
      if (!statuses.every(s => s === 429)) { burst.admittedSend = send; return sentMs; }
    }
    return burst.sends.at(-1)?.sentMs ?? now();
  };
  const phaseStartMs: Record<Phase, number> = { B0: 0, B1: plan.b0Ms, B2: Infinity };
  let nextSignin: number = SCHEDULE.signinFirstMs, signins = 0, nextAuth: number = SCHEDULE.authFirstMs, auths = 0, nextRead = 0;
  let nextBurst: number | null = plan.b0Ms, burstsSent = 0, burstRunning = false, endAt = Infinity, b0Checked = !plan.failFast;
  while (!controller.signal.aborted && now() < endAt) {
    const t = now();
    // Fail fast after the first measured block (B0) on the pre-registered INVALID/INCONCLUSIVE conditions.
    if (!b0Checked && t >= plan.b0Ms) {
      b0Checked = true;
      const b0 = (k: OwnerKind) => owner.filter(o => o.kind === k && o.sentMs < plan.b0Ms && o.status === 204).length;
      const median = samplerIntervals(samples).medianMs;
      if (samplerExited || median === null || median > SAMPLER.medianMaxMs) stoppedEarly = `invalid: sampler median ${median} ms`;
      else if (b0('password') < 4 || b0('revoke') < 4) stoppedEarly = `inconclusive: B0 successes password ${b0('password')}, revoke ${b0('revoke')}`;
      else if (!owner.some(o => (o.kind === 'web_signin' || o.kind === 'native_signin') && o.sentMs < plan.b0Ms && o.status === 200))
        stoppedEarly = 'inconclusive: no B0 owner sign-in success (V undefined)';
      if (stoppedEarly) break;
    }
    if (nextBurst !== null && t >= nextBurst && !burstRunning) {
      const index = ++burstsSent;
      nextBurst = null; burstRunning = true;
      track(sendBurst(index).then(admittedAt => {
        burstRunning = false;
        if (index < plan.bursts) { nextBurst = admittedAt + BURST.gapMs; return; }
        const last = attack.filter(a => a.burst === index && a.status === 401).map(a => a.endMs);
        const all = attack.filter(a => a.burst === index).map(a => a.endMs);
        phaseStartMs.B2 = Math.max(...(last.length ? last : all.length ? all : [now()])) + plan.b1TailMs;
        endAt = phaseStartMs.B2 + plan.b2Ms;
      }));
    }
    for (const due of ['signin', 'auth'] as const) {
      if (t < (due === 'signin' ? nextSignin : nextAuth)) continue;
      const kind: OwnerKind = due === 'signin' ? (signins++ % 2 ? 'native_signin' : 'web_signin') : (auths++ % 2 ? 'revoke' : 'password');
      if (due === 'signin') nextSignin += SCHEDULE.signinEveryMs; else nextAuth += SCHEDULE.authEveryMs;
      if (ownerBusy) { skipped[kind]++; continue; }
      ownerOp(kind);
    }
    while (t >= nextRead) {
      nextRead += SCHEDULE.readEveryMs;
      if (readActive >= SCHEDULE.readInFlight) { skipped.reads++; continue; }
      readActive++;
      track(request(`/api/v1/orgs/${organization}/channels`, { method: 'GET', headers: { Authorization: `Bearer ${readerBody.token}` } })
        .then(r => { reads.push({ sentMs: r.start - t0, status: r.status, ms: r.end - r.start, error: r.error }); })
        .finally(() => { readActive--; }));
    }
    await pause(2);
  }
  while (pending.size) await Promise.all([...pending]);
  const endMs = now();
  if (samplerExited) throw new Stop('sampler exited');
  sampler.kill(); sampler = undefined;
  if (controller.signal.aborted) throw new Stop('interrupted');
  await pause(2500);
  run.enter('aggregation');
  const appLogs = docker(...compose, 'logs', '--no-color', '--no-log-prefix', 'app');
  const evidence = appEvidence(appLogs, wallStart, wallStart + endMs), admissions = admissionRejected(appLogs);
  const lockText = dbLog(), parsed = parseLockLog(lockText);
  const x = xWaits(parsed.events, { accountsOid, databaseOid, ctids });
  const offsetMs = clockOffset(samples);
  const waits: XWait[] = offsetMs === null ? [] : mergeWaits(x.waits).map(w => ({ ...w, startMs: w.startDbMs + offsetMs,
    endMs: w.endDbMs + offsetMs, who: attribute(w, samples).who }));
  const reasons = [parsed.unparsed && `${parsed.unparsed} unparsed lock lines`, x.unmatched && `${x.unmatched} unmatched waits`,
    x.foreign && `${x.foreign} accounts waits off X's known tuples`, offsetMs === null && 'no clock offset'].filter(Boolean) as string[];
  const burstRun: BurstRun = { owner, attack, reads, bursts, samples, offsetMs, waits: waits.filter(w => w.startMs >= 0),
    lockLog: { complete: !reasons.length, reasons }, phaseStartMs, endMs, poolMax: POOL_MAX,
    server: { poolTimeouts: (evidence.pool?.deltas.acquire_timeout ?? 0) + evidence.databaseFailures.pool_timeout, panics: evidence.panics,
      complete: evidence.complete && admissions.complete } };
  const lockEvents = parsed.events.filter(e => offsetMs !== null && e.atDbMs + offsetMs >= 0);
  const logging = { settings: meta.pgSettings, note: LOGGING_NOTE, dbLogLines: parsed.lines, dbLogBytes: Buffer.byteLength(lockText),
    deadlockChecks: lockEvents.filter(e => e.kind === 'waiting').length, acquiredMessages: lockEvents.filter(e => e.kind === 'acquired').length,
    failedMessages: lockEvents.filter(e => e.kind === 'failed').length, deadlockMessages: parsed.deadlockMessages, otherLockWaits: x.other };
  writeFileSync(`${output}/server-evidence.json`, JSON.stringify({ pool: evidence.pool, databaseFailures: evidence.databaseFailures,
    http5xx: evidence.http5xx, panics: evidence.panics, otherWarnings: evidence.otherWarnings, complete: evidence.complete,
    reasons: evidence.reasons, admissionRejected: admissions }, null, 2) + '\n');
  const judgment = judgeBurst(burstRun);
  results = { ...burstRun, waitsBeforeWorkload: waits.length - burstRun.waits.length, skipped, logging, judgment, report: report(burstRun),
    // Short cells are never evidence; this runs the 3-run aggregation path on this run alone.
    aggregatePreview: mode === 'recorded' ? null : aggregate([{ evidence: false, verdict: judgment.verdict },
      { evidence: false, verdict: null }, { evidence: false, verdict: null }]) };
  console.log('SIGNIN_BURST_JUDGMENT ' + JSON.stringify({ mode, evidence: mode === 'recorded', verdict: judgment.verdict,
    reasons: judgment.reasons, a0: judgment.a0.checks, checks: judgment.checks, skipped }));
  if (stoppedEarly) throw new Stop(`stopped after B0: ${stoppedEarly}`);
} catch (error) {
  failed = true;
  console.error(`Sign-in burst measurement failed during ${run.stage}: ${error instanceof Stop ? error.message : 'details suppressed'}`);
} finally {
  sampler?.kill();
  try { docker(...compose, 'down', '--volumes'); } catch { cleanupErrors.push('Compose cleanup failed'); }
  if (!appImage) {
    try { if (docker('image', 'ls', '-q', env.LOAD_APP_IMAGE)) docker('image', 'rm', env.LOAD_APP_IMAGE); }
    catch { cleanupErrors.push('Image cleanup failed'); }
  }
  rmSync(scratch, { recursive: true, force: true });
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  const status = run.finish(() => writeFileSync(`${output}/results.json`, JSON.stringify({ mode, evidence: mode === 'recorded',
    complete: !failed, stoppedEarly, ...results }, null, 2) + '\n'),
  { failed: failed || cleanupErrors.length > 0, interrupted: controller.signal.aborted, invalidEvidence: Boolean(stoppedEarly) || failed });
  if (cleanupErrors.length) console.error(cleanupErrors.join('; '));
  console.log(`Sign-in burst ${status.outcome} (${mode}, evidence ${status.evidence}): ${output}`);
  process.exitCode = failed || cleanupErrors.length || status.summaryFailed ? 1 : 0;
}
