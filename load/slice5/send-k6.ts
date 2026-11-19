// k6 send generator for #515 slice 5. One invocation is one Part A open-loop step
// (SLICE5_MODE=open) or one Part B closed-loop maximum (SLICE5_MODE=closed).
import execution from 'k6/execution';
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { httpOutcome, publish, uuid } from '../seed.ts';

const data = JSON.parse(open('/fixture/data.json')) as { organization: string; otherOrganization: string; reader: string; channels: string[]; body: string;
  retry: { member: number; channel: string; client_message_id: string; body: string }[] };
const tokens = new SharedArray<string>('members', () => JSON.parse(open('/fixture/tokens.json')));
const mode = __ENV.SLICE5_MODE, rate = Number(__ENV.SLICE5_RATE), seconds = Number(__ENV.SLICE5_SECONDS);
const warmup = Number(__ENV.SLICE5_WARMUP ?? '0'), channels = Number(__ENV.SLICE5_CHANNELS), vus = Number(__ENV.SLICE5_VUS ?? '0');
const drain = Number(__ENV.SLICE5_DRAIN ?? '11'), retryRate = Number(__ENV.SLICE5_RETRY_RATE ?? '0');
if (!['open', 'closed'].includes(mode) || !(seconds > 0) || ![1, data.channels.length].includes(channels)) throw new Error('bad slice 5 settings');

const names = ['attempted', 'accepted', 'rejected429', 'rejected503', 'otherErrors', 'clientTimeouts', 'transportErrors'] as const;
const counters = Object.fromEntries(names.map(n => [n, new Counter(`s5_${n}`)])) as Record<typeof names[number], Counter>;
const latency = new Trend('s5_success_ms', true);
const lanes = mode === 'open'
  ? { send: { executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: `${seconds}s`, preAllocatedVUs: 100, maxVUs: 2000, gracefulStop: `${drain}s`, exec: 'send' },
    ...(retryRate ? { retry: { executor: 'constant-arrival-rate', rate: retryRate, timeUnit: '1s', duration: `${seconds}s`, preAllocatedVUs: 10, maxVUs: 100, gracefulStop: `${drain}s`, exec: 'retry' } } : {}) }
  : { send: { executor: 'constant-vus', vus, duration: `${warmup + seconds}s`, gracefulStop: `${drain}s`, exec: 'send' } };
// #196 B shape: the second-Organization reader runs at 2/s through the whole invocation (warm-up, send and drain windows); its outcomes feed the Part A and B gates.
Object.assign(lanes, { reader: { executor: 'constant-arrival-rate', rate: 2, timeUnit: '1s', duration: `${warmup + seconds + drain}s`, preAllocatedVUs: 2, maxVUs: 20, gracefulStop: '11s', exec: 'reader' } });
const windows = mode === 'open' ? ['all'] : ['warmup', 'measured', 'after'];
export const options: Options = {
  scenarios: lanes as Options['scenarios'], summaryTrendStats: ['p(95)', 'p(99)', 'max'], systemTags: ['scenario', 'status', 'name'],
  thresholds: Object.fromEntries(Object.keys(lanes).flatMap(lane => [`dropped_iterations{scenario:${lane}}`,
    ...windows.flatMap(w => [...names.map(n => `s5_${n}{scenario:${lane},window:${w}}`), `s5_success_ms{scenario:${lane},window:${w}}`])]
    .map(m => [m, [m.startsWith('s5_success') ? 'max>=0' : 'count>=0']]))),
};

function initialize(lane: string) {
  if (execution.vu.iterationInScenario !== 0) return;
  // Explicit zeros distinguish an empty warmup/drain window from missing metrics.
  for (const window of windows) for (const n of names) counters[n].add(0, { scenario: lane, window });
}
function post(member: number, channel: string, body: { client_message_id: string; body: string }, lane: string) {
  initialize(lane);
  const at = Date.now() - execution.scenario.startTime;
  const window = mode === 'open' ? 'all' : at < warmup * 1000 ? 'warmup' : at < (warmup + seconds) * 1000 ? 'measured' : 'after';
  const r = publish(__ENV.BASE_URL, data.organization, channel, tokens[member], member, body, lane);
  const outcome = httpOutcome(r);
  const tags = { scenario: lane, window };
  counters.attempted.add(1, tags);
  for (const n of names.slice(1)) counters[n].add(Number(outcome === n), tags);
  if (outcome === 'accepted') latency.add(r.timings.duration, tags);
}
export function send() {
  const i = execution.scenario.iterationInTest;
  if (i === 0) console.log(`SLICE5_START ${execution.scenario.startTime}`);
  post(i % tokens.length, data.channels[i % channels], { client_message_id: uuid(), body: data.body }, 'send');
}
export function reader() {
  initialize('reader');
  const at = Date.now() - execution.scenario.startTime;
  const window = mode === 'open' ? 'all' : at < warmup * 1000 ? 'warmup' : at < (warmup + seconds) * 1000 ? 'measured' : 'after';
  const r = http.get(`${__ENV.BASE_URL}/api/v1/orgs/${data.otherOrganization}/channels`, { headers: { Authorization: `Bearer ${data.reader}` }, timeout: '10s', redirects: 0 });
  const tags = { scenario: 'reader', window };
  counters.attempted.add(1, tags);
  const outcome = r.error_code === 1050 ? 'clientTimeouts' : r.status === 200 ? 'accepted' : r.status === 0 ? 'transportErrors' : 'otherErrors';
  for (const n of names.slice(1)) counters[n].add(Number(outcome === n), tags);
  if (outcome === 'accepted') latency.add(r.timings.duration, tags);
}
// Report-only S5 lane: identical retries of sends made before the step.
export function retry() {
  const target = data.retry[execution.scenario.iterationInTest % data.retry.length];
  post(target.member, target.channel, { client_message_id: target.client_message_id, body: target.body }, 'retry');
}
export function handleSummary(summary: { metrics: Record<string, { values: Record<string, number> }> }) {
  const value = (metric: string, stat = 'count') => summary.metrics[metric]?.values[stat];
  const row = (lane: string, window: string) => ({
    ...Object.fromEntries(names.map(n => [n, value(`s5_${n}{scenario:${lane},window:${window}}`) ?? -1])),
    droppedIterations: value(`dropped_iterations{scenario:${lane}}`) ?? 0,
    p95: value(`s5_success_ms{scenario:${lane},window:${window}}`, 'p(95)') ?? null,
    p99: value(`s5_success_ms{scenario:${lane},window:${window}}`, 'p(99)') ?? null });
  const result = Object.fromEntries(Object.keys(lanes).map(lane => [lane, Object.fromEntries(windows.map(w => [w, row(lane, w)]))]));
  return { stdout: `SLICE5_RESULT ${JSON.stringify(result)}\n` };
}
