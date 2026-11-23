// #668: one run on a fresh PostgreSQL and a fresh release server (measurement tracing on).
// Timeline (path A), aligned to the expected fallback pass P as the #592 runner does:
// stall at P - 4 s, Role change to Guest at P - 3 s, gate on at P - 0.3 s, resume at P + 0.1 s,
// Hfence restore at P + 2 s, gate off at P + 3.5 s or P + 15 s. Controls skip only the gate.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { encloseClockBrackets, intersectClockBrackets, runUncertaintyMs, THRESHOLDS, type ClockSample, type Probe } from './revocation-burst-judgment.ts';
import { installGate, removeDatabase, seedMembers, Session, startDatabase, waitReady, type Database } from './revocation-burst-db.ts';
import { Relay } from './revocation-burst-relay.ts';
import { startRssSampler } from './revocation-burst-rss.ts';
import { emptyLog, readLogLine } from './revocation-holds-log.ts';
import { BYSTANDERS, CELLS, DURATIONS, restoreAccount, runId, socketAccount, stallBody, targetSockets, TIMELINE, type PlannedRun, type Stall } from './revocation-holds-plan.ts';
import { StallProxy } from './revocation-holds-stall.ts';
import type { AccountMutations, HoldsRun, Notice, TargetSocket } from './revocation-holds-judgment.ts';
import type { Channel, ChangeRoleRequest, ClientMessage, CreateChannelRequest, NativeSessionResponse, SendMessageRequest, ServerEvent, SetupRequest } from '../web/src/api-schema.d.ts';

const exec = promisify(execFile);
const FALLBACK_INTERVAL_MS = 30_000; // RECHECK_INTERVAL in server/src/auth/session.rs
const PROBE_INTERVAL_MS = 50;
const MUTATION_CONCURRENCY = 64;
const now = () => performance.now();
const sleep = (ms: number) => new Promise(r => setTimeout(r, Math.max(0, ms)));
const at = async <T>(time: number, work: () => Promise<T> | T) => { await sleep(time - now()); return work(); };

export type Active = { server?: ChildProcess; relay?: Relay; db?: Database; sessions?: Session[]; sockets?: WebSocket[]; proxies?: StallProxy[]; stopProbes?: () => void; stopSampling?: () => void };
export async function cleanup(active: Active) {
  active.stopSampling?.();
  active.sockets?.forEach(s => { try { s.close(); } catch { /* closing */ } });
  active.stopProbes?.();
  active.sessions?.forEach(s => s.close());
  await Promise.all(active.proxies?.map(p => p.close()) ?? []);
  const server = active.server;
  if (server && server.exitCode === null) { server.kill('SIGINT'); await new Promise(r => { const t = setTimeout(r, 15_000); server.once('exit', () => { clearTimeout(t); r(undefined); }); }); server.kill('SIGKILL'); }
  await active.relay?.close();
  if (active.db) removeDatabase(active.db.name);
  for (const key of Object.keys(active) as (keyof Active)[]) delete active[key];
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await work(items[next++]); }));
}

type Calibration = { server: [number, number]; wall: [number, number] };
async function calibrateClock(base: string, samples: number[], walls: (number | undefined)[]): Promise<Calibration> {
  // Same serial health-request brackets as load/revocation-burst.ts. The same log line's tracing
  // timestamp calibrates the server wall clock for events without server_ms.
  const brackets: ClockSample[] = [], wallBrackets: ClockSample[] = [];
  for (let i = 0; i < 8; i++) {
    const index = samples.length, before = now();
    const response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(5_000) });
    const after = now();
    if (!response.ok || await response.text() !== 'ok') throw new Error('clock calibration health request failed');
    for (let attempt = 0; samples.length === index && attempt < 100; attempt++) await sleep(20);
    if (samples.length !== index + 1) throw new Error('missing or ambiguous server clock sample');
    brackets.push({ beforeMs: before, afterMs: after, serverMs: samples[index] });
    wallBrackets.push({ beforeMs: before, afterMs: after, serverMs: walls[index] ?? NaN });
  }
  return { server: intersectClockBrackets(brackets), wall: intersectClockBrackets(wallBrackets) };
}

type Context = { binary: string; output: string; stall: Stall; active: Active; interrupted: () => boolean };

async function startServer(ctx: Context, dir: string) {
  const db = startDatabase(`fk592-h668-${randomUUID().slice(0, 8)}`); ctx.active.db = db;
  await waitReady(db);
  const url = (user: string, password: string, port: number) => `postgres://${user}:${password}@127.0.0.1:${port}/fukulow?sslmode=disable`;
  await exec(ctx.binary, ['migrate'], { env: { PATH: process.env.PATH, DATABASE_URL: url('fukulow', db.ownerPassword, db.port), POSTGRES_APP_PASSWORD: db.appPassword } })
    .catch(() => { throw new Error('migrate failed (diagnostics suppressed)'); });
  installGate(db);
  const relay = new Relay({ host: '127.0.0.1', port: db.port }); ctx.active.relay = relay;
  const relayPort = await relay.listen();
  const appPort = 20000 + Math.floor(Math.random() * 20000);
  const setupToken = randomBytes(16).toString('hex');
  const server = spawn(ctx.binary, [], { env: { PATH: process.env.PATH, FUKULOW_ADDR: `127.0.0.1:${appPort}`, FUKULOW_COOKIE_SECURE: 'false', FUKULOW_SETUP_TOKEN: setupToken,
    FUKULOW_REVOCATION_MEASUREMENT: '1', DATABASE_URL: url('fukulow_app', db.appPassword, relayPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.active.server = server;
  const file = createWriteStream(resolve(dir, 'server.log'));
  const logsClosed = new Promise<void>(done => server.once('close', () => file.end(done)));
  const log = emptyLog();
  for (const stream of [server.stdout!, server.stderr!]) createInterface({ input: stream }).on('line', line => { file.write(line + '\n'); readLogLine(log, line, now()); });
  const rss: { at: number; kb: number }[] = [];
  const sampler = startRssSampler(server, async signal => Number((await exec('ps', ['-o', 'rss=', '-p', String(server.pid)], { signal })).stdout.trim()), rss);
  ctx.active.stopSampling = sampler.stop;
  const base = `http://127.0.0.1:${appPort}`;
  for (let i = 0; ; i++) { try { if ((await fetch(`${base}/api/v1/setup`)).status === 200) break; } catch { /* starting */ } if (i > 100) throw new Error('server did not start'); await sleep(200); }
  return { db, relay, appPort, setupToken, log, rss, sampler, logsClosed, base };
}

type Request = (method: string, path: string, token: string, body?: unknown) => Promise<{ status: number; json: () => unknown }>;
const requester = (base: string): Request => async (method, path, token, body) => {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  return { status: response.status, json: () => JSON.parse(text) as unknown };
};

/** Owner, target, sender and bystander Members; C public Channels; private Channel K for the stall. */
async function seedFixture(db: Database, base: string, setupToken: string, run: PlannedRun, stall: Stall) {
  const request = requester(base);
  const password = randomBytes(16).toString('hex');
  const setup: SetupRequest = { email: 'owner@example.invalid', password, name: 'Load Owner', organization_name: 'fk668', setup_token: setupToken };
  if ((await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(setup) })).status !== 201) throw new Error('setup failed');
  const signIn = await fetch(`${base}/api/v1/native/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: setup.email, password }) });
  if (signIn.status !== 200) throw new Error('sign-in failed');
  const owner = await signIn.json() as NativeSessionResponse;
  const org = owner.identity.organizations[0].organization_id;
  const { accounts, channels } = CELLS[run.cell];
  const seeded = seedMembers(db, org, accounts + stall.senders + BYSTANDERS).members;
  const targets = seeded.slice(0, accounts), senders = seeded.slice(accounts, accounts + stall.senders), bystanders = seeded.slice(accounts + stall.senders);
  const create = async (body: CreateChannelRequest) => {
    const created = await request('POST', `/api/v1/orgs/${org}/channels`, owner.token, body);
    if (created.status !== 201) throw new Error('Channel creation failed');
    return (created.json() as Channel).id;
  };
  // Members reach public Channels without a grant; as Guests they lose them (docs/spec/accounts.md).
  const revoked: string[] = new Array(channels);
  await pool([...Array(channels).keys()], MUTATION_CONCURRENCY, async i => { revoked[i] = await create({ name: `fk668-public-${i}`, visibility: 'public' }); });
  const stallChannel = await create({ name: 'fk668-stall', visibility: 'private' });
  let failures = 0;
  await pool([...targets, ...senders], MUTATION_CONCURRENCY, async member => {
    if ((await request('POST', `/api/v1/orgs/${org}/channels/${stallChannel}/members`, owner.token, { member_id: member.id })).status !== 204) failures++;
  });
  if (failures) throw new Error(`${failures} stall Channel grants failed`);
  return { request, org, owner, targets, senders, bystanders, revoked, stallChannel };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;
async function openSockets(ctx: Context, fixture: Fixture, run: PlannedRun, appPort: number, proxies: StallProxy[], proxyPorts: number[]) {
  const targets: TargetSocket[] = [], notices: Notice[] = [], sockets: WebSocket[] = [];
  const state = { bystandersReady: 0, bystanderNotices: 0, bystanderCloses: 0, stopping: false };
  const open = async (port: number, token: string, onMessage: (socket: WebSocket, message: ServerEvent) => void, onClose: (code: number) => void) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/orgs/${fixture.org}/ws`, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]);
    socket.onmessage = event => onMessage(socket, JSON.parse(String(event.data)) as ServerEvent);
    socket.onclose = event => { if (!state.stopping) onClose(event.code); };
    sockets.push(socket);
    if (sockets.length % 100 === 0) await sleep(100); // pace the upgrades as the #592 runner does
  };
  ctx.active.sockets = sockets;
  for (let i = 0; i < targetSockets(run.cell); i++) {
    const target: TargetSocket = { account: socketAccount(i), ready: false, subscribed: false, stall: proxies[i].record, stallMessagesAt: [] };
    targets.push(target);
    await open(proxyPorts[i], fixture.targets[target.account].token, (socket, message) => {
      if (message.type === 'activity_ready' && !target.ready) {
        target.ready = true;
        const subscribe: ClientMessage = { type: 'subscribe', channel_id: fixture.stallChannel, after_seq: 0 };
        socket.send(JSON.stringify(subscribe));
      } else if (message.type === 'subscribed' && message.channel_id === fixture.stallChannel) target.subscribed = true;
      // Only K is subscribed, so every Message event is a stall Message.
      else if (message.type === 'message') target.stallMessagesAt.push(now());
      else if (message.type === 'channel_access_revoked') notices.push({ socket: i, channelId: message.channel_id ?? null, at: now() });
    }, code => { target.close = { at: now(), code }; });
  }
  for (const member of fixture.bystanders) {
    await open(appPort, member.token, (_, message) => {
      if (message.type === 'activity_ready') state.bystandersReady++;
      else if (message.type === 'channel_access_revoked') state.bystanderNotices++;
    }, () => { state.bystanderCloses++; });
  }
  return { targets, notices, state };
}

function startProbes(db: Database, request: Request, org: string, token: string) {
  const session = new Session(db);
  const dbProbe: Probe[] = [], httpProbe: Probe[] = [];
  let probing = true;
  const done = Promise.all([
    (async () => { while (probing) { const start = now(); const ok = await session.run('SELECT 1;', 5_000); dbProbe.push({ at: start, ms: now() - start, ok }); await sleep(PROBE_INTERVAL_MS); } })(),
    (async () => { while (probing) { const start = now(); try { const r = await request('GET', `/api/v1/orgs/${org}/me`, token); httpProbe.push({ at: start, ms: now() - start, ok: r.status === 200, status: r.status }); } catch { httpProbe.push({ at: start, ms: now() - start, ok: false }); } await sleep(PROBE_INTERVAL_MS); } })(),
  ]);
  return { session, dbProbe, httpProbe, stop: () => { probing = false; return done; } };
}

async function changeRole(fixture: Fixture, member: { id: string }, role: ChangeRoleRequest['role']) {
  const startedAt = now();
  const r = await fixture.request('PATCH', `/api/v1/orgs/${fixture.org}/members/${member.id}/role`, fixture.owner.token, { role } satisfies ChangeRoleRequest).catch(() => ({ status: 0 }));
  return { startedAt, status: r.status, doneAt: r.status === 200 ? now() : undefined };
}

async function postStall(fixture: Fixture, stall: Stall) {
  const body = stallBody(stall.chars);
  let failures = 0;
  await Promise.all(fixture.senders.flatMap(sender => Array.from({ length: stall.messages }, async () => {
    const message: SendMessageRequest = { body, client_message_id: randomUUID() };
    const r = await fixture.request('POST', `/api/v1/orgs/${fixture.org}/channels/${fixture.stallChannel}/messages`, sender.token, message).catch(() => ({ status: 0 }));
    if (r.status !== 201) failures++;
  })));
  return failures;
}

/** Finds P: the next expected fallback pass that leaves a quiet baseline before the stall. */
async function findPass(relay: Relay) {
  const quiet = now();
  let observed: number | undefined;
  for (let i = 0; observed === undefined; i++) {
    observed = relay.statements.find(st => st.fallback && st.at >= quiet)?.at;
    if (i > 400) throw new Error('no fallback pass observed');
    await sleep(100);
  }
  let pass = observed;
  while (pass + TIMELINE.stall < now() + TIMELINE.baselineMs + 500) pass += FALLBACK_INTERVAL_MS;
  return pass;
}

export async function measure(ctx: Context, run: PlannedRun): Promise<HoldsRun> {
  const dir = resolve(ctx.output, runId(run)); mkdirSync(dir);
  const started = await startServer(ctx, dir);
  const { db, relay, log, base } = started;
  const fixture = await seedFixture(db, base, started.setupToken, run, ctx.stall);
  const proxies = Array.from({ length: targetSockets(run.cell) }, () => new StallProxy({ host: '127.0.0.1', port: started.appPort }));
  ctx.active.proxies = proxies;
  const proxyPorts = await Promise.all(proxies.map(p => p.listen()));
  const sockets = await openSockets(ctx, fixture, run, started.appPort, proxies, proxyPorts);
  for (let i = 0; !(sockets.targets.every(t => t.subscribed) && sockets.state.bystandersReady >= BYSTANDERS); i++) {
    if (i > 1200 || ctx.interrupted()) break; // floor 1 reports sockets that never became ready
    await sleep(100);
  }
  const calibrationErrors: string[] = [];
  const calibrate = () => calibrateClock(base, log.clock, log.clockWall).catch(error => { calibrationErrors.push((error as Error).message); return undefined; });
  const clockStart = await calibrate();
  const probes = startProbes(db, fixture.request, fixture.org, fixture.owner.token);
  const control = new Session(db);
  ctx.active.sessions = [probes.session, control];
  ctx.active.stopProbes = () => { void probes.stop(); };
  const pass = await findPass(relay);
  const restoreIndex = restoreAccount(run.cell);
  const accounts: AccountMutations[] = fixture.targets.map(() => ({}));
  // [statement sent, ack]; a control has no gate, so both bounds are the nominal time.
  const gate = async (failing: boolean): Promise<[number, number]> => {
    const before = now();
    if (run.kind === 'fault' && !await control.run(`UPDATE public.fk592_control SET failing = ${failing};`)) throw new Error(`gate did not ${failing ? 'engage' : 'release'}`);
    return [before, run.kind === 'fault' ? now() : before];
  };
  const recoveryAt = pass + (run.kind === 'fault' ? DURATIONS[run.duration] : DURATIONS.long);
  const steps = await Promise.all([
    at(pass + TIMELINE.stall, async () => {
      const time = now();
      const targetsReady = sockets.targets.filter(t => t.subscribed).length, bystandersReady = sockets.state.bystandersReady;
      proxies.forEach(p => p.pause());
      return { time, targetsReady, bystandersReady, failures: await postStall(fixture, ctx.stall) };
    }),
    at(pass + TIMELINE.revoke, async () => { const time = now(); await pool([...fixture.targets.keys()], MUTATION_CONCURRENCY, async a => {
      const r = await changeRole(fixture, fixture.targets[a], 'guest'); Object.assign(accounts[a], { revokeStartedAt: r.startedAt, revokeStatus: r.status, revokedAt: r.doneAt });
    }); return time; }),
    (async () => { const gateOn = await at(pass + TIMELINE.fault, () => gate(true)); const gateOff = await at(recoveryAt, () => gate(false)); return { gateOn, gateOff }; })(),
    at(pass + TIMELINE.resume, () => { const time = now(); proxies.forEach(p => p.resume()); return time; }),
    restoreIndex === undefined ? undefined : at(pass + TIMELINE.restore, async () => {
      const r = await changeRole(fixture, fixture.targets[restoreIndex], 'member'); Object.assign(accounts[restoreIndex], { restoreStartedAt: r.startedAt, restoreStatus: r.status, restoredAt: r.doneAt }); return r.startedAt;
    }),
  ]);
  const [stalled, revokeTime, { gateOn, gateOff }, resume, restore] = steps;
  const recovery = gateOff[1];
  // Wait for a metrics event emitted after the drain limit (60 s cadence).
  for (let i = 0; !log.metrics.some(m => m.at >= recovery + THRESHOLDS.drainSeconds * 1000); i++) { if (i > 800 || ctx.interrupted()) break; await sleep(100); }
  await sleep(1_500);
  const end = now();
  await probes.stop();
  sockets.state.stopping = true;
  started.sampler.stop(); await started.sampler.done;
  const clockEnd = await calibrate();
  await cleanup(ctx.active);
  await started.logsClosed;
  const offsetBoundsMs = clockStart && clockEnd ? encloseClockBrackets(clockStart.server, clockEnd.server) : undefined;
  const wallOffsetBoundsMs = clockStart && clockEnd ? encloseClockBrackets(clockStart.wall, clockEnd.wall) : undefined;
  const nominalRecovery = run.kind === 'fault' ? { [run.duration]: gateOff[1] } : { short: pass + DURATIONS.short, long: gateOff[1] };
  const result: HoldsRun = {
    kind: run.kind, cell: run.cell, duration: run.kind === 'fault' ? run.duration : undefined, repeat: run.repeat,
    times: { pass, stall: stalled.time, revoke: revokeTime, gateOn, gateOff, resume, restore, end, nominalRecovery },
    setup: { bystanders: BYSTANDERS, bystandersReadyAtStall: stalled.bystandersReady, targetsReadyAtStall: stalled.targetsReady, calibrationErrors, stallPostFailures: stalled.failures },
    serverCloses: log.closes, wallOffsetBoundsMs,
    revokedChannels: fixture.revoked, accounts, targets: sockets.targets, notices: sockets.notices,
    bystanderNotices: sockets.state.bystanderNotices, bystanderCloses: sockets.state.bystanderCloses,
    sendTiming: offsetBoundsMs && { offsetBoundsMs, uncertaintyMs: runUncertaintyMs(offsetBoundsMs, log.sends), records: log.sends },
    samples: log.holds, statements: relay.statements, refused: relay.refused,
    dbProbe: probes.dbProbe, httpProbe: probes.httpProbe, pool: log.pool, rss: started.rss,
    metrics: log.metrics.find(m => m.at >= recovery + THRESHOLDS.drainSeconds * 1000)?.fields,
  };
  writeFileSync(resolve(dir, 'run.json'), JSON.stringify(result));
  return result;
}
