import execution from 'k6/execution';
import http, { type Response } from 'k6/http';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { WebSocket } from 'k6/websockets';
import type { ChannelList, MoveChainRequest, MoveChainResponse, ServerEvent, Subscribe, TopicPage } from '../../web/src/api-schema.d.ts';
import { consecutivePositions } from '../events.ts';
import { httpOutcome, params, publish, uuid } from '../seed.ts';
import type { Fixture } from './fixture.ts';
import type { LaneName } from './judge.ts';
import { outcomes, type Outcome } from './metrics.ts';
import { plan, rehearsalPlan, type Step } from './plan.ts';
import { moveAcknowledged } from './wire.ts';
import { counts, workloadOptions } from './workload-options.ts';

const data = JSON.parse(open('/fixture/data.json')) as Fixture;
const tokens = new SharedArray<string>('members', () => JSON.parse(open('/fixture/tokens.json')));
const step = JSON.parse(__ENV.MOVE_STEP) as Step;
const p = __ENV.MOVE_REHEARSAL === '1' ? rehearsalPlan() : plan(__ENV.MOVE_SMOKE === '1');
const base = __ENV.BASE_URL;
const org = `${base}/api/v1/orgs/${data.organization}`;
const channel = `${org}/channels/${data.chain.channel}`;
const otherChannels = data.channels.filter(id => id !== data.chain.channel);
const { lanes, topicScenarios, options: workload } = workloadOptions(p, step, __ENV.MOVE_READ_LANES);
const counter = Object.fromEntries(counts.map(name => [name, new Counter(`move_${name}`)])) as Record<typeof counts[number], Counter>;
const latency = new Trend('move_success_ms', true);
const start = new Counter('move_start_ms');
const topicItems = new Counter('move_topic_reads');
const diagnostic = __ENV.MOVE_DIAGNOSTIC === '1';
const scenarioStart = new Counter('move_scenario_start_ms');
export const options: Options = workload;

function observe(lane: LaneName, outcome: Outcome, ms: number) {
  const tags = { scenario: lane };
  counter.attempted.add(1, tags);
  for (const name of outcomes) counter[name].add(Number(outcome === name), tags);
  if (outcome === 'accepted') latency.add(ms, tags);
}

function json<T>(response: Response): T | undefined {
  try { return response.json() as T; } catch { return undefined; }
}

function recordScenarioStart() {
  if (diagnostic && execution.scenario.iterationInTest === 0) scenarioStart.add(execution.scenario.startTime);
}

export function reader() {
  recordScenarioStart();
  if (execution.scenario.iterationInTest === 0) start.add(execution.scenario.startTime);
  const r = http.get(`${base}/api/v1/orgs/${data.otherOrganization}/channels`, params('other_organization', data.reader));
  observe('reader', httpOutcome(r, 200), r.timings.duration);
}

export function send() {
  recordScenarioStart();
  const i = execution.scenario.iterationInTest;
  const member = i % tokens.length;
  const target = step.part === 'C' ? otherChannels[i % otherChannels.length] : data.chain.channel;
  const r = publish(base, data.organization, target, tokens[member], member, { client_message_id: uuid(), body: 'Load test message' }, 'send');
  observe('send', httpOutcome(r, 201), r.timings.duration);
}

let version = data.chain.version, destination = 1;
export function move() {
  recordScenarioStart();
  const topic = data.chain.topics[destination];
  const input: MoveChainRequest = { operation_id: uuid(), expected_version: version, history_generation: data.generation, topic_id: topic };
  const r = http.post(`${channel}/messages/${data.chain.root}/move`, JSON.stringify(input),
    { ...params('move', data.owner), responseType: 'text' });
  const ack = r.status === 200 ? json<MoveChainResponse>(r) : undefined;
  const valid = moveAcknowledged(ack, input.operation_id, data.chain.root, topic, version, data.generation);
  if (valid && ack) {
    version = ack.chain_version;
    destination = 1 - destination;
  }
  observe('move', r.status === 200 && !valid ? 'otherErrors' : httpOutcome(r, 200), r.timings.duration);
}

export function channels() {
  recordScenarioStart();
  const r = http.get(`${org}/channels`, { ...params('channel_list', data.reader), responseType: 'text' });
  const full = r.status === 200 && json<ChannelList>(r)?.channels?.length === data.channels.length;
  observe('channels', r.status === 200 && !full ? 'otherErrors' : httpOutcome(r, 200), r.timings.duration);
}

export function topics() {
  recordScenarioStart();
  const r = http.get(`${channel}/topics?limit=${p.topicLimit}`, { ...params('topic_list', data.reader), responseType: 'text' });
  const full = r.status === 200 && json<TopicPage>(r)?.topics?.length === p.topicLimit;
  topicItems.add(1);
  observe('topics', r.status === 200 && !full ? 'otherErrors' : httpOutcome(r, 200), r.timings.duration);
}

export function replay() {
  const range = data.replay!;
  const token = tokens[execution.scenario.iterationInTest % tokens.length];
  const seen: number[] = [], kinds: string[] = [];
  let sent = 0, done = false;
  const wsBase = base.replace(/^http/, 'ws');
  const socket = new WebSocket(`${wsBase}/api/v1/orgs/${data.organization}/ws`, null, { headers: { Authorization: `Bearer ${token}` } });
  const finish = (outcome: Outcome) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    observe('replay', outcome, sent ? Date.now() - sent : 0);
    socket.close();
  };
  const timer = setTimeout(() => finish('clientTimeouts'), 10_000);
  socket.addEventListener('open', () => {
    const input: Subscribe = { type: 'subscribe', channel_id: data.chain.channel, after_seq: range.after, history_generation: data.generation };
    sent = Date.now();
    socket.send(JSON.stringify(input));
  });
  socket.addEventListener('error', () => finish('transportErrors'));
  socket.addEventListener('close', () => finish('transportErrors'));
  socket.addEventListener('message', (event: object) => {
    if (done) return;
    let e: ServerEvent;
    try { e = JSON.parse(String((event as { data?: unknown }).data)) as ServerEvent; }
    catch { finish('otherErrors'); return; }
    if (e.type === 'error') { finish('otherErrors'); return; }
    if (e.type === 'message' && (e.kind === 'move' ? e.channel_id : e.message.channel_id) === data.chain.channel) {
      seen.push(e.seq);
      kinds.push(e.kind);
    }
    if (e.type === 'subscribed' && e.channel_id === data.chain.channel) {
      const valid = e.history_generation === data.generation && e.caught_up_seq === range.through && seen.length === p.replayPage &&
        consecutivePositions(seen, range.after, range.through) &&
        kinds.every((kind, i) => kind === (i === kinds.length - 1 ? range.lastKind : 'create'));
      finish(valid ? 'accepted' : 'otherErrors');
    }
  });
}

export function handleSummary(summary: { metrics: Record<string, { values: Record<string, number> }> }) {
  const value = (metric: string, stat = 'count') => summary.metrics[metric]?.values[stat];
  const drops = (scenario: string) => value(`dropped_iterations{scenario:${scenario}}`) ?? 0;
  const rows = Object.fromEntries([...lanes].map(lane => [lane, {
    ...Object.fromEntries(counts.map(name => [name, value(`move_${name}{scenario:${lane}}`) ?? -1])),
    droppedIterations: lane === 'topics' ? topicScenarios.reduce((sum, name) => sum + drops(name), 0) : drops(lane),
    p95: value(`move_success_ms{scenario:${lane}}`, 'p(95)') ?? null,
    p99: value(`move_success_ms{scenario:${lane}}`, 'p(99)') ?? null,
  }]));
  return { stdout: 'MOVE_RESULT ' + JSON.stringify({ lanes: rows, started: value('move_start_ms'),
    topicReaders: topicScenarios.map(name => value(`move_topic_reads{scenario:${name}}`) ?? (diagnostic ? -1 : 0)),
    ...(diagnostic && { scenarioDrops: Object.fromEntries(Object.keys(workload.scenarios ?? {}).map(name =>
      [name, value(`dropped_iterations{scenario:${name}}`) ?? null])) }) }) + '\n' };
}
