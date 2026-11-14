// Short preliminary probe, not the complete formal-acceptance runner.
import http from 'k6/http';
import execution from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Gauge, Trend } from 'k6/metrics';
import { setTimeout, clearTimeout } from 'k6/timers';
import { WebSocket } from 'k6/websockets';
import type { Options } from 'k6/options';
import type { DmChanges, DmList, Message, ServerEvent, SendMessageRequest } from '../web/src/api-schema.d.ts';
import { createActivity, createActivityTarget } from '../web/src/activity.ts';
import { dmListState, stepDmList } from '../web/src/dm-list.ts';
import { senderFor, senderIndex, socketStop } from './dms-workload.ts';

// k6 lacks browser clone/cancellation globals. State is JSON-only; HTTP uses
// k6's own 10-second timeout, so this signal only supports scheduler teardown.
class LoadAbortController {
  signal = { aborted: false };
  abort() { this.signal.aborted = true; }
}
Object.assign(globalThis, { setTimeout, clearTimeout, AbortController: LoadAbortController, structuredClone: <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T });
type Member = { id: string; token: string; channel: string; peer: string };
type Seed = { organization: string; channel: string; topic: string; members: Member[]; deep?: string; ids?: string[]; renewals?: { caller: number; peer: number; channel: string }[] };
const members = new SharedArray<Member>('dm-members', () => (JSON.parse(open(__ENV.DM_SEED || '/seed.json')) as Seed).members);
const renewals = new SharedArray<{ caller: number; peer: number; channel: string }>('dm-renewals', () => (JSON.parse(open(__ENV.DM_SEED || '/seed.json')) as Seed).renewals || []);
const seed = (() => { const value = JSON.parse(open(__ENV.DM_SEED || '/seed.json')) as Seed; return { organization: value.organization, channel: value.channel, topic: value.topic, deep: value.deep, ids: value.ids }; })();
const base = __ENV.BASE_URL || 'http://app:8080';
const org = `${base}/api/v1/orgs/${seed.organization}`;
const count = Number(__ENV.DM_SOCKETS || 2500), offset = Number(__ENV.DM_OFFSET || 0);
const seconds = Number(__ENV.DM_SECONDS || 95), ramp = Number(__ENV.DM_SEND_START || 40);
const connectInterval = Number(__ENV.DM_CONNECT_INTERVAL_MS || 500);
const rate = Number(__ENV.DM_RATE || 500), shard = Number(__ENV.DM_SHARD || 0);
const browserOnly = __ENV.DM_BROWSER_ONLY === '1';
const browseRate = Number(__ENV.DM_BROWSE_RATE || (browserOnly ? 100 : 25)), openRate = Number(__ENV.DM_OPEN_RATE || 5);
const errors = new Counter('dm_errors'), calls = new Counter('dm_calls'), accepted = new Counter('dm_accepted');
const connected = new Gauge('dm_connections'), readyMetric = new Counter('dm_ready');
const subscribed = new Counter('dm_subscribed'), expectedPeer = new Counter('dm_expected_peer'), receivedPeer = new Counter('dm_received_peer'), duplicates = new Counter('dm_duplicate_frames');
const latency = new Trend('dm_latency_ms', true), receipt = new Trend('dm_receipt_ms', true), round = new Trend('dm_round_ms', true);
const attempts = new Trend('dm_round_attempts'), pending = new Counter('dm_pending_rounds');
const shapes = ['first', 'deep', 'refresh', 'delta', 'coverage', 'resolve', 'renew', 'create', 'send', 'channels', 'me', 'members', 'channel-members', 'topics', 'topic'];
export const options: Options = {
  scenarios: {
    sockets: { executor: 'shared-iterations', exec: 'sockets', vus: 1, iterations: 1, maxDuration: `${seconds + ramp + 120}s` },
    ...(rate ? { sends: { executor: 'constant-arrival-rate' as const, exec: 'send', rate, timeUnit: '1s', duration: `${seconds-5}s`, startTime: `${ramp}s`, preAllocatedVUs: 50, maxVUs: 150, gracefulStop: '10s' },
      browsing: { executor: 'constant-arrival-rate' as const, exec: 'browse', rate: browseRate || 1, timeUnit: '1s', duration: `${seconds-5}s`, startTime: `${ramp}s`, preAllocatedVUs: 5, maxVUs: 20 },
      opens: { executor: 'constant-arrival-rate' as const, exec: 'openDm', rate: openRate || 1, timeUnit: '1s', duration: `${seconds-5}s`, startTime: `${ramp}s`, preAllocatedVUs: 5, maxVUs: 20 } } : {}),
  },
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max'],
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  thresholds: { dm_errors: ['count==0'], dropped_iterations: ['count==0'],
    ...Object.fromEntries(shapes.map(shape => [`dm_latency_ms{shape:${shape}}`, ['max>=0']])),
  },
};
if (!browseRate) delete options.scenarios!.browsing;
if (!openRate) delete options.scenarios!.opens;
if (browserOnly) options.scenarios = { browsing: { executor: 'constant-arrival-rate', exec: 'browse', rate: browseRate, timeUnit: '1s', duration: `${seconds-5}s`, preAllocatedVUs: 20, maxVUs: 100 } };
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function get(path: string, token: string, shape: string) {
  const start = Date.now();
  const response = await http.asyncRequest('GET', org + path, null, { headers: headers(token), timeout: '10s', responseType: ['channels','me','members','channel-members','topics','topic'].includes(shape) ? 'none' : 'text', tags: { name: shape } });
  calls.add(1, { shape }); latency.add(Date.now() - start, { shape });
  if (response.status !== 200) { errors.add(1, { shape, status: String(response.status) }); throw new Error(`GET ${shape}: ${response.status}`); }
  return response;
}
export async function sockets() {
  let live = 0, ready = 0, stopping = false;
  const clients: WebSocket[] = [], activities: ReturnType<typeof createActivity>[] = [];
  errors.add(0); accepted.add(0);
  for (let i = 0; i < count; i++) {
    const index = offset + i, member = members[index];
    const watched = index % 2 === 1;
    const socket = new WebSocket(`${org.replace(/^http/, 'ws')}/ws`, null, { headers: headers(member.token) });
    clients.push(socket);
    let opened = false, initialized = false, lastSeq = 0, ownActivity: ReturnType<typeof createActivity> | undefined;
    socket.addEventListener('open', () => { opened = true; connected.add(++live); if (watched) socket.send(JSON.stringify({ type: 'subscribe', channel_id: member.channel, after_seq: 0 })); });
    socket.addEventListener('error', () => errors.add(1, { shape: 'socket' }));
    socket.addEventListener('close', event => { if (opened) connected.add(--live); if (!stopping) errors.add(1, { shape: 'close', code: 'code' in event ? String(event.code) : 'unknown' }); });
    socket.addEventListener('message', event => {
      if (!('data' in event)) return;
      const notice = JSON.parse(String(event.data)) as ServerEvent;
      if (notice.type === 'message') {
        if (notice.message.seq <= lastSeq) { duplicates.add(1); return; }
        if (notice.message.seq !== lastSeq+1) errors.add(1, { shape: 'sequence_gap' });
        lastSeq = notice.message.seq;
        if (notice.message.sender !== member.id) {
          let data: { sent?: number; phase?: string };
          try { data = JSON.parse(notice.message.body) as typeof data; }
          catch { return; } // Seed/history bodies have no generator timestamp.
          if (data.sent && data.phase === 'mixed') { receipt.add(Date.now() - data.sent); receivedPeer.add(1); }
        }
        return;
      }
      if (notice.type === 'error') { errors.add(1, { shape: 'subscribe' }); return; }
      if (notice.type === 'subscribed') { subscribed.add(1); return; }
      if (notice.type === 'channel_access_lost') { errors.add(1, { shape: 'access_lost' }); return; }
      if (notice.type === 'activity_ready' && !initialized) {
        initialized = true; ready++; readyMetric.add(1);
        const activity = createActivity({ watched: id => watched && id === member.channel });
        ownActivity = activity;
        activities.push(activity);
        let state = dmListState();
        let epoch = 0;
        const target = createActivityTarget<null>({
          async load() {
            const start = Date.now(), ownEpoch = epoch; let used = 0;
            for (;;) {
              state = stepDmList(state, { type: 'wake', now: Date.now() }).state;
              const request = state.request;
              if (!request) break;
              used++;
              try {
                const discovery = request.lane === 'delta' || request.lane === 'coverage';
                const path = discovery ? `/dms/changes?lane=${request.lane}${request.cursor ? `&cursor=${encodeURIComponent(request.cursor)}` : ''}`
                  : `/dms${request.ids ? '?' + request.ids.map(id => `channel_id=${id}`).join('&') : request.cursor ? '?cursor=' + encodeURIComponent(request.cursor) : ''}`;
                const response = await get(path, member.token, discovery ? request.lane : 'refresh');
                state = stepDmList(state, { type: 'result', request, data: response.json() as unknown as DmChanges | DmList }).state;
              } catch {
                state = stepDmList(state, { type: 'failure', request, retryAt: Date.now()+1000, terminal: false }).state;
              }
              // A scheduled replenishment during a slow request starts another
              // run; do not merge its allowance or timing into this completion.
              if (epoch !== ownEpoch) break;
            }
            attempts.add(used);
            if (epoch !== ownEpoch || state.request || state.lanes.delta.pending || state.lanes.coverage.pending || state.lanes.held.pending) pending.add(1);
            else round.add(Date.now() - start);
            return { ok: true, data: null };
          }, accept() {},
        });
        activity.hold('dms', {
          invalidate(reason, delay) {
            if (reason === 'periodic') epoch++;
            state = stepDmList(state, { type: 'demand', boundary: reason !== 'notice', periodic: reason === 'periodic', replace: [] }).state;
            target.invalidate(reason, delay);
          }, close: target.close,
        });
        const mix: [string, string][] = [['channels', '/channels'], ['me', '/me']];
        if (index%4 === 0) mix.push(['members', '/members']);
        if (index%4 === 1) mix.push(['channel-members', `/channels/${seed.channel}/members`]);
        if (index%4 === 2) mix.push(['topics', `/channels/${seed.channel}/topics`]);
        if (index%4 === 3) mix.push(['topic', `/channels/${seed.channel}/topics/${seed.topic}`]);
        for (const [shape, path] of mix) {
          const ordinary = createActivityTarget<null>({ async load() { try { await get(path, member.token, shape); return { ok: true, data: null }; } catch { return { ok: false, kind: 'network' }; } }, accept() {} });
          activity.hold(shape === 'me' ? 'capabilities' : shape === 'channel-members' ? 'channel-members:c' : shape === 'topics' ? 'main:c' : shape === 'topic' ? 'topic:c:t' : shape, ordinary);
        }
      }
      if (initialized) {
        ownActivity?.notice(notice);
      }
    });
    if ((i+1)%100 === 0) await pause(connectInterval);
  }
  const deadline = Date.now()+60000;
  while (ready < count && Date.now() < deadline) await pause(100);
  console.log(JSON.stringify({ phase: 'ready', at: Date.now(), requested: count, live, ready, offset, seconds }));
  if (ready !== count) errors.add(count-ready, { shape: 'not_ready' });
  await pause(Math.max(0, socketStop(execution.scenario.startTime, Date.now(), ramp, seconds, rate)-Date.now()));
  console.log(JSON.stringify({ phase: 'end', at: Date.now(), live, ready, offset }));
  stopping = true; activities.forEach(a => a.close()); clients.forEach(s => s.close()); await pause(1000);
}
export function send() {
  if (execution.scenario.iterationInTest === 0) console.log(JSON.stringify({ phase: 'send_window', start: execution.scenario.startTime, seconds: seconds-5 }));
  const i = __ENV.DM_SENDERS ? senderFor(execution.scenario.iterationInTest, Number(__ENV.DM_SENDERS)) : senderIndex(execution.scenario.iterationInTest, shard, members.length), member = members[i];
  const started = Date.now();
  const body: SendMessageRequest = { client_message_id: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.floor(Math.random()*16); return (c === 'x' ? n : (n&3)|8).toString(16); }), body: JSON.stringify({ sent: started, phase: 'mixed', text: 'x'.repeat(976) }) };
  const response = http.post(`${org}/channels/${member.channel}/messages`, JSON.stringify(body), { headers: headers(member.token), timeout: '10s', tags: { name: 'send' } });
  calls.add(1, { shape: 'send' }); latency.add(Date.now()-started, { shape: 'send' });
  if (response.status === 201) { accepted.add(1); if (i%2 === 0) expectedPeer.add(1); } else errors.add(1, { shape: 'send', status: String(response.status) });
  if (__ENV.DM_LEDGER === '1') {
    const message = response.status === 201 ? response.json() as unknown as Message : undefined;
    if (message && (message.client_message_id !== body.client_message_id || message.channel_id !== member.channel)) errors.add(1, { shape: 'response_contract' });
    // Enough to check durable ids/seqs and reconstruct unknown-outcome retries;
    // never log credentials or Message bodies. Capture stdout outside Git.
    console.log('DM_SEND ' + JSON.stringify({ organization: seed.organization, member: member.id, channel: member.channel,
      client_message_id: body.client_message_id, started, completed: Date.now(), status: response.status,
      id: message?.id, seq: message?.seq, bodyBytes: body.body.length }));
  }
}
export async function browse() {
  const deep = execution.scenario.iterationInTest%2 === 1;
  if (deep && !seed.deep) throw new Error('Deep browsing requires a prepared 5,000-row continuation');
  await get('/dms' + (deep ? '?cursor='+encodeURIComponent(seed.deep!) : ''), members[members.length-1].token, deep ? 'deep' : 'first');
}
export function openDm() {
  const i = execution.scenario.iterationInTest;
  const renewal = i%4 === 3 && renewals.length ? renewals[Math.floor(i/4)] : undefined;
  if (i%4 === 3 && renewals.length && !renewal) throw new Error('Prepared renewal pool exhausted');
  const member = members[renewal ? renewal.caller : members.length >= 10000 ? 2000+shard*500+i%500 : 500+(i%4 === 2 ? Math.floor(i/4)%400 : i%400)];
  const renew = i%4 === 3, create = i%4 === 2;
  const peer = renewal ? members[renewal.peer].id : create ? members[members.length >= 10000 ? 4000+shard*1000+Math.floor(i/4)%1000 : Math.floor(i/1600)%400].id : member.peer;
  const shape = create ? 'create' : renew ? 'renew' : 'resolve', started = Date.now();
  const response = http.post(`${org}/dms`, JSON.stringify({ member_id: peer, renew }), { headers: headers(member.token), timeout: '10s', tags: { name: shape } });
  calls.add(1, { shape }); latency.add(Date.now()-started, { shape });
  if (response.status !== (create ? 201 : 200)) errors.add(1, { shape, status: String(response.status) });
}
export function handleSummary(data: unknown) { return { '/output/summary.json': JSON.stringify(data, null, 2) }; }
