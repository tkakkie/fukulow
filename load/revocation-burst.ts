// #592: revocation-hold retry bursts during a recheck-only failure and a whole-database outage.
// The release build enables measurement tracing; failures are simulated outside the server.
// Run: ulimit -n 65536; node load/revocation-burst.ts --out /absolute/new/dir [--smoke] [--sizes 256,1024] [--kinds recheck,outage] [--repeats 3]
// Recheck only: ulimit -n 65536; node load/revocation-burst.ts --out /absolute/new/dir --kinds recheck --sizes 4096 --repeats 3
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { outsideCheckout } from './proxy-target.ts';
import { Relay } from './revocation-burst-relay.ts';
import { startRssSampler } from './revocation-burst-rss.ts';
import { installGate, removeDatabase, seedMembers, Session, sql, startDatabase, waitReady, type Database } from './revocation-burst-db.ts';
import { judge, verdictBySize, KINDS, SIZES, THRESHOLDS, type Kind, type Member, type PoolSample, type Probe, type Revocation, type Run, type RunVerdict, type SendRecord, type SendTiming } from './revocation-burst-judgment.ts';
import type { Channel, CreateChannelRequest, NativeSessionResponse, ServerEvent, SetupRequest } from '../web/src/api-schema.d.ts';

const run = promisify(execFile);
const checkout = resolve(import.meta.dirname, '..');
const binary = resolve(checkout, 'target/release/fukulow-server');
// Holds start only when a recheck fails for a revocation that is in flight or queued, and the
// fallback pass (RECHECK_INTERVAL in server/src/auth/session.rs) is the one recheck that covers
// every registration. So the fault is aligned to an expected pass, with removals in flight.
const FALLBACK_INTERVAL_MS = 30_000;
const BURST_LEAD_MS = 1_000; // removals start this long before the expected pass
const FAULT_LEAD_MS = 300; // the fault engages this long before it
// Recover just before the fourth retry (+3.75 s) of holds started by the pass, before the
// five-retry limit (+7.75 s) retires them.
const RECOVERY_AFTER_PASS_MS = 3_500;
const REMOVALS = 128; // tracked Members, one private Channel each; even indexes are restored
const MUTATION_CONCURRENCY_DEFAULT = 64;
const PROBE_INTERVAL_MS = 50;

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--help')) { console.log('node load/revocation-burst.ts --out /absolute/new/dir [--smoke] [--sizes ...] [--kinds ...] [--repeats n]'); process.exit(0); }
const outArg = option('--out');
if (!outArg) throw new Error('Use --out /absolute/new/external/directory');
const output = outsideCheckout(outArg);
if (existsSync(output)) throw new Error('Output directory already exists');
if (process.version !== 'v26.13.1') throw new Error('Use Node 26.13.1');
if (!existsSync(binary)) throw new Error('Build the release server first: cargo build --release --locked -p fukulow-server');
const smoke = args.includes('--smoke');
const sizes = (option('--sizes')?.split(',').map(Number) ?? (smoke ? [256] : [...SIZES]));
// 'control' (no failure) is a harness check only and never enters the verdict.
const kinds = (option('--kinds')?.split(',') ?? [...KINDS]) as (Kind | 'control')[];
const MUTATION_CONCURRENCY = Number(option('--mutation-concurrency') ?? MUTATION_CONCURRENCY_DEFAULT);
const repeats = Number(option('--repeats') ?? (smoke ? 1 : THRESHOLDS.repeats));
mkdirSync(output, { recursive: true });
const now = () => performance.now();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let active: { server?: ChildProcess; relay?: Relay; db?: Database; sessions?: Session[]; sockets?: WebSocket[]; stopProbes?: () => void; stopSampling?: () => void } = {};
let interrupted = false;
const cleanup = async () => {
  active.stopSampling?.();
  active.sockets?.forEach(s => { try { s.close(); } catch { /* closing */ } });
  active.stopProbes?.();
  active.sessions?.forEach(s => s.close());
  if (active.server && active.server.exitCode === null) { active.server.kill('SIGINT'); await new Promise(r => { const t = setTimeout(r, 15_000); active.server!.once('exit', () => { clearTimeout(t); r(undefined); }); }); active.server.kill('SIGKILL'); }
  await active.relay?.close();
  if (active.db) removeDatabase(active.db.name);
  active = {};
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { interrupted = true; void cleanup().then(() => process.exit(130)); });

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await work(items[next++]); }));
}

async function calibrateClock(base: string, samples: number[]): Promise<[number, number]> {
  let low = -Infinity, high = Infinity;
  // The health handler stamps its monotonic clock inside each serial loopback round trip.
  // Subtract the stamp from both Node times and intersect the brackets. Network, scheduling
  // and handler delays are included without assuming symmetric latency. Log arrival is unused.
  for (let i = 0; i < 8; i++) {
    const index = samples.length;
    const before = now();
    const response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(5_000) });
    const after = now();
    if (!response.ok || await response.text() !== 'ok') throw new Error('clock calibration health request failed');
    for (let attempt = 0; samples.length === index && attempt < 100; attempt++) await sleep(20);
    if (samples.length !== index + 1) throw new Error('missing or ambiguous server clock sample');
    low = Math.max(low, before - samples[index]);
    high = Math.min(high, after - samples[index]);
  }
  if (low > high) throw new Error('inconsistent server clock calibration samples');
  return [low, high];
}

async function measure(kind: Kind | 'control', size: number, repeat: number): Promise<Run> {
  const id = `${kind}-${size}-r${repeat}`;
  const dir = resolve(output, id); mkdirSync(dir);
  const db = startDatabase(`fk592-db-${randomUUID().slice(0, 8)}`); active.db = db;
  await waitReady(db);
  const owner = (user: string, password: string, port: number) => `postgres://${user}:${password}@127.0.0.1:${port}/fukulow?sslmode=disable`;
  await run(binary, ['migrate'], { env: { PATH: process.env.PATH, DATABASE_URL: owner('fukulow', db.ownerPassword, db.port), POSTGRES_APP_PASSWORD: db.appPassword } })
    .catch(() => { throw new Error('migrate failed (diagnostics suppressed)'); });
  installGate(db);
  const relay = new Relay({ host: '127.0.0.1', port: db.port }); active.relay = relay;
  const relayPort = await relay.listen();
  const appPort = 20000 + Math.floor(Math.random() * 20000);
  const setupToken = randomBytes(16).toString('hex');
  const server = spawn(binary, [], { env: { PATH: process.env.PATH, FUKULOW_ADDR: `127.0.0.1:${appPort}`, FUKULOW_COOKIE_SECURE: 'false', FUKULOW_SETUP_TOKEN: setupToken,
    FUKULOW_REVOCATION_MEASUREMENT: '1', DATABASE_URL: owner('fukulow_app', db.appPassword, relayPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  active.server = server;
  const log = createWriteStream(resolve(dir, 'server.log'));
  const serverLogsClosed = new Promise<void>(resolve => server.once('close', () => log.end(resolve)));
  const poolSamples: PoolSample[] = [], metrics: { at: number; fields: Record<string, number> }[] = [];
  const clockSamples: number[] = [], sendRecords: SendRecord[] = [];
  for (const stream of [server.stdout!, server.stderr!]) createInterface({ input: stream }).on('line', line => {
    log.write(line + '\n');
    try {
      const event = JSON.parse(line) as { target?: string; fields?: Record<string, unknown> };
      const f = event.fields ?? {};
      if (event.target === 'fukulow_revocation_measurement') {
        if (f.event === 'revocation_clock_sample' && typeof f.server_ms === 'number' && Number.isFinite(f.server_ms)) clockSamples.push(f.server_ms);
        if (f.event === 'channel_access_revoked_sent' && typeof f.channel_id === 'string' &&
          typeof f.before_ms === 'number' && typeof f.after_ms === 'number' &&
          Number.isFinite(f.before_ms) && Number.isFinite(f.after_ms) && f.before_ms <= f.after_ms) {
          sendRecords.push({
            channelId: f.channel_id, beforeMs: f.before_ms, afterMs: f.after_ms,
            afterHold: typeof f.after_hold === 'boolean' ? f.after_hold : undefined,
          });
        }
        return;
      }
      const numeric = Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
      if (f.event === 'pool_stats') poolSamples.push({ at: now(), fields: numeric });
      if (f.event === 'metrics') metrics.push({ at: now(), fields: numeric });
    } catch { /* non-JSON line */ }
  });
  const rss: { at: number; kb: number }[] = [];
  const sampler = startRssSampler(server, async signal => {
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(server.pid)], { signal });
    return Number(stdout.trim());
  }, rss);
  active.stopSampling = sampler.stop;
  const base = `http://127.0.0.1:${appPort}`;
  for (let i = 0; ; i++) { try { if ((await fetch(`${base}/api/v1/setup`)).status === 200) break; } catch { /* starting */ } if (i > 100) throw new Error('server did not start'); await sleep(200); }
  const request = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    return { status: response.status, json: () => JSON.parse(text) as unknown };
  };
  const password = randomBytes(16).toString('hex');
  const setup: SetupRequest = { email: 'owner@example.invalid', password, name: 'Load Owner', organization_name: 'fk592', setup_token: setupToken };
  if ((await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(setup) })).status !== 201) throw new Error('setup failed');
  const signIn = await fetch(`${base}/api/v1/native/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: setup.email, password }) });
  if (signIn.status !== 200) throw new Error('sign-in failed');
  const ownerSession = await signIn.json() as NativeSessionResponse;
  const org = ownerSession.identity.organizations[0].organization_id;
  const seeded = seedMembers(db, org, size);
  const tracked = Math.min(REMOVALS, size);
  const channels: string[] = new Array(tracked);
  let seedFailures = 0;
  await pool([...Array(tracked).keys()], MUTATION_CONCURRENCY, async i => {
    const body: CreateChannelRequest = { name: `fk592-${i}`, visibility: 'private' };
    const created = await request('POST', `/api/v1/orgs/${org}/channels`, ownerSession.token, body);
    if (created.status !== 201) { seedFailures++; return; }
    channels[i] = (created.json() as Channel).id;
    if ((await request('POST', `/api/v1/orgs/${org}/channels/${channels[i]}/members`, ownerSession.token, { member_id: seeded.members[i].id })).status !== 204) seedFailures++;
  });
  if (seedFailures) throw new Error(`${seedFailures} seed requests failed`);
  // One registration per Member; only the first `tracked` Members lose access.
  const members: Member[] = channels.map(channelId => ({ channelId, resets: [] }));
  const revocations: Revocation[] = [];
  let ready = 0, stopping = false, serverCloses = 0;
  const sockets: WebSocket[] = []; active.sockets = sockets;
  for (let i = 0; i < size; i++) {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v1/orgs/${org}/ws`, { headers: { Authorization: `Bearer ${seeded.members[i].token}` } } as unknown as string[]);
    sockets.push(socket);
    socket.onmessage = event => {
      const notice = JSON.parse(String(event.data)) as ServerEvent;
      if (notice.type === 'activity_ready') ready++;
      else if (notice.type === 'channel_access_revoked') revocations.push({ socketIndex: i, channelId: notice.channel_id ?? null, at: now() });
      else if (notice.type === 'activity_reset' && i < tracked) members[i].resets.push(now());
    };
    socket.onclose = event => {
      if (stopping) return;
      serverCloses++;
      if (i < tracked) members[i].close = { at: now(), code: event.code };
    };
    if ((i + 1) % 100 === 0) await sleep(100);
  }
  for (let i = 0; ready < size; i++) { if (i > 1200) throw new Error(`only ${ready}/${size} sockets ready`); await sleep(100); }
  const clockStart = await calibrateClock(base, clockSamples);
  // Probes for the whole measured phase.
  const control = new Session(db), probeSession = new Session(db); active.sessions = [control, probeSession];
  const dbProbe: Probe[] = [], httpProbe: Probe[] = [];
  let probing = true;
  active.stopProbes = () => { probing = false; };
  const probes = [
    (async () => { while (probing) { const at = now(); const ok = await probeSession.run('SELECT 1;', 5_000); dbProbe.push({ at, ms: now() - at, ok }); await sleep(PROBE_INTERVAL_MS); } })(),
    (async () => { while (probing) { const at = now(); try { const r = await request('GET', `/api/v1/orgs/${org}/me`, ownerSession.token); httpProbe.push({ at, ms: now() - at, ok: r.status === 200, status: r.status }); } catch { httpProbe.push({ at, ms: now() - at, ok: false }); } await sleep(PROBE_INTERVAL_MS); } })(),
  ];
  // Find the fallback phase from the session pass that starts each fallback run.
  const quiet = now();
  let observed: number | undefined;
  for (let i = 0; observed === undefined; i++) {
    observed = relay.statements.find(st => st.fallback && st.at >= quiet)?.at;
    if (i > 400) throw new Error('no fallback pass observed');
    await sleep(100);
  }
  let pass = observed;
  while (pass - BURST_LEAD_MS < now() + 10_500) pass += FALLBACK_INTERVAL_MS; // keep a quiet 10 s baseline
  const burst = pass - BURST_LEAD_MS;
  await sleep(burst - now());
  let fault = NaN, recovery = NaN;
  const faultTimer = (async () => {
    await sleep(pass - FAULT_LEAD_MS - now());
    if (kind === 'recheck' && !await control.run('UPDATE public.fk592_control SET failing = true;')) throw new Error('gate did not engage');
    if (kind === 'outage') relay.setOutage(true);
    fault = now();
    await sleep(pass + RECOVERY_AFTER_PASS_MS - now());
    if (kind === 'recheck' && !await control.run('UPDATE public.fk592_control SET failing = false;')) throw new Error('gate did not release');
    relay.setOutage(false);
    recovery = now();
  })();
  faultTimer.catch(() => { /* rethrown by the await below */ });
  const removals: number[] = [];
  let mutationFailures = 0;
  await pool([...Array(tracked).keys()], MUTATION_CONCURRENCY, async i => {
    members[i].removeStartedAt = now();
    const r = await request('DELETE', `/api/v1/orgs/${org}/channels/${channels[i]}/members/${seeded.members[i].id}`, ownerSession.token).catch(() => ({ status: 0 }));
    if (r.status === 204) { members[i].removedAt = now(); removals.push(now()); } else mutationFailures++;
  });
  await pool([...Array(tracked).keys()].filter(i => i % 2 === 0 && members[i].removedAt !== undefined), MUTATION_CONCURRENCY, async i => {
    const r = await request('POST', `/api/v1/orgs/${org}/channels/${channels[i]}/members`, ownerSession.token, { member_id: seeded.members[i].id }).catch(() => ({ status: 0 }));
    if (r.status === 204) members[i].restoredAt = now(); else mutationFailures++;
  });
  const mutationsDone = now();
  await faultTimer;
  // Wait for a metrics event emitted after the drain limit (60 s cadence).
  for (let i = 0; !metrics.some(m => m.at >= recovery + THRESHOLDS.drainSeconds * 1000); i++) { if (i > 800 || interrupted) break; await sleep(100); }
  await sleep(1_500);
  const end = now();
  probing = false; await Promise.all(probes);
  stopping = true;
  sampler.stop();
  await sampler.done;
  const drainMetrics = metrics.find(m => m.at >= recovery + THRESHOLDS.drainSeconds * 1000)?.fields;
  const measuredPool = poolSamples.slice();
  const clockEnd = await calibrateClock(base, clockSamples);
  // Liveness check of the database after the run, outside the relay.
  sql(db, 'SELECT 1;');
  await cleanup();
  await serverLogsClosed;
  // Same-host monotonic clocks share the OS clock rate. Enclose both calibration brackets
  // to cover a changed offset (e.g. if only one clock counts suspend). Also enclose the
  // widest successful send from entry to flush, including any backpressure or descheduling.
  const offsetBoundsMs: SendTiming['offsetBoundsMs'] = [Math.min(clockStart[0], clockEnd[0]), Math.max(clockStart[1], clockEnd[1])];
  const sendTiming: SendTiming = {
    offsetBoundsMs,
    uncertaintyMs: (offsetBoundsMs[1] - offsetBoundsMs[0] + Math.max(0, ...sendRecords.map(record => record.afterMs - record.beforeMs))) / 2,
    records: sendRecords,
  };
  const result: Run = {
    kind, size, repeat, times: { pass, burst, fault, mutationsDone, recovery, end }, removals, mutationFailures,
    statements: relay.statements, connections: relay.connections, refused: relay.refused,
    dbProbe, httpProbe, pool: measuredPool, rss, metrics: drainMetrics, members, revocations, sendTiming, serverCloses,
  };
  writeFileSync(resolve(dir, 'run.json'), JSON.stringify(result));
  return result;
}

const results: { kind: Kind | 'control'; size: number; repeat: number; pass: boolean; verdict: RunVerdict; reasons: string[]; summary: unknown }[] = [];
const environment = { node: process.version, platform: platform(), arch: arch(), release: release(), cpus: cpus().length, memoryBytes: totalmem(), smoke, fallbackIntervalMs: FALLBACK_INTERVAL_MS, burstLeadMs: BURST_LEAD_MS, faultLeadMs: FAULT_LEAD_MS, recoveryAfterPassMs: RECOVERY_AFTER_PASS_MS, removals: REMOVALS, mutationConcurrency: MUTATION_CONCURRENCY, thresholds: THRESHOLDS,
  commit: (await run('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim() };
writeFileSync(resolve(output, 'environment.json'), JSON.stringify(environment, null, 2));
try {
  // Interleave kinds within each repeat so host drift affects both alike.
  for (const size of sizes) for (let repeat = 1; repeat <= repeats; repeat++) for (const kind of (repeat % 2 ? kinds : [...kinds].reverse())) {
    if (interrupted) break;
    console.log(`#592 ${kind} size=${size} repeat=${repeat}`);
    try {
      const measured = await measure(kind, size, repeat);
      const { pass, verdict, reasons, summary } = judge(measured);
      results.push({ kind, size, repeat, pass, verdict, reasons, summary });
      console.log(JSON.stringify({ kind, size, repeat, pass, verdict, reasons }));
    } catch (error) {
      results.push({ kind, size, repeat, pass: false, verdict: 'FAIL', reasons: [`invalid run: ${(error as Error).message}`], summary: undefined });
      console.log(`invalid run: ${(error as Error).message}`);
      await cleanup();
    }
    writeFileSync(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
  }
} finally {
  await cleanup();
}
const bySize = smoke ? 'smoke: never evidence' : verdictBySize(results.filter((r): r is typeof r & { kind: Kind } => r.kind !== 'control'));
writeFileSync(resolve(output, 'summary.json'), JSON.stringify({ environment, bySize, results }, null, 2));
console.log(JSON.stringify({ bySize }));
