// k6 Part C: four response-paced R1 gap-fill readers on one settled Channel while a
// concurrent sender adds 20/s to it. B reads messages?after_seq, A reads events?after_seq.
import execution from 'k6/execution';
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { replayPosition } from './config.ts';
import { uuid } from '../seed.ts';

const data = JSON.parse(open('/fixture/data.json')) as { organization: string; otherOrganization: string; channel: string; size: number; reader: string; generation: string | null };
const tokens = new SharedArray<string>('members', () => JSON.parse(open('/fixture/tokens.json')));
const arm = __ENV.SLICE5_ARM, depth = __ENV.SLICE5_DEPTH;
const readers = Number(__ENV.SLICE5_READERS), warmups = Number(__ENV.SLICE5_WARMUPS), requests = Number(__ENV.SLICE5_REQUESTS);
const limit = Number(__ENV.SLICE5_LIMIT), recentWindow = Number(__ENV.SLICE5_RECENT_WINDOW);
const senderRate = Number(__ENV.SLICE5_SENDER_RATE), senderSeconds = Number(__ENV.SLICE5_SENDER_SECONDS);
if (!['A', 'B'].includes(arm) || !['recent', 'deep'].includes(depth) || (arm === 'A') !== (data.generation !== null)) throw new Error('bad replay settings');

const pages = new Counter('s5_pages'), invalid = new Counter('s5_invalid_pages'), errors = new Counter('s5_reader_errors');
const otherErrors = new Counter('s5_other_errors'), otherAttempted = new Counter('s5_other_attempted');
const latency = new Trend('s5_replay_ms', true), late = new Counter('s5_reader_outside_sender');
const sendNames = ['attempted', 'accepted', 'rejected429', 'rejected503', 'otherErrors', 'clientTimeouts', 'transportErrors'] as const;
const sends = Object.fromEntries(sendNames.map(n => [n, new Counter(`s5_send_${n}`)])) as Record<typeof sendNames[number], Counter>;
export const options: Options = {
  scenarios: {
    sender: { executor: 'constant-arrival-rate', rate: senderRate, timeUnit: '1s', duration: `${senderSeconds}s`, preAllocatedVUs: 10, maxVUs: 100, gracefulStop: '11s', exec: 'sender' },
    other: { executor: 'constant-arrival-rate', rate: 2, timeUnit: '1s', duration: `${senderSeconds}s`, preAllocatedVUs: 2, maxVUs: 20, gracefulStop: '11s', exec: 'other' },
    ...Object.fromEntries(Array.from({ length: readers }, (_, i) => [`reader-${i}`, { executor: 'per-vu-iterations', vus: 1, iterations: warmups + requests, startTime: '5s', maxDuration: `${senderSeconds - 10}s`, exec: 'reader' }])),
  },
  summaryTrendStats: ['p(50)', 'p(95)', 'max'],
  thresholds: Object.fromEntries([...['s5_other_errors', 's5_other_attempted', 's5_pages', 's5_invalid_pages', 's5_reader_errors', 's5_reader_outside_sender', ...sendNames.map(n => `s5_send_${n}`)].map(m => [m, ['count>=0']]),
    ['s5_replay_ms', ['max>=0']], ['dropped_iterations{scenario:sender}', ['count>=0']]]),
};

export function sender() {
  const i = execution.scenario.iterationInTest;
  if (i === 0) console.log(`SLICE5_START ${execution.scenario.startTime}`);
  const r = http.post(`${__ENV.BASE_URL}/api/v1/orgs/${data.organization}/channels/${data.channel}/messages`,
    JSON.stringify({ client_message_id: uuid(), body: 'Load test message' }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[i % tokens.length]}`, 'X-Load-Client-IP': `10.0.${(i >>> 8) & 255}.${i & 255}` }, timeout: '10s', redirects: 0 });
  const outcome = r.error_code === 1050 ? 'clientTimeouts' : r.status >= 200 && r.status < 300 ? 'accepted' : r.status === 429 ? 'rejected429'
    : r.status === 503 ? 'rejected503' : r.status === 0 ? 'transportErrors' : 'otherErrors';
  sends.attempted.add(1);
  for (const n of sendNames.slice(1)) sends[n].add(Number(outcome === n));
}

// #196 B shape: the second-Organization reader at 2/s (report-only).
export function other() {
  const r = http.get(`${__ENV.BASE_URL}/api/v1/orgs/${data.otherOrganization}/channels`, { headers: { Authorization: `Bearer ${data.reader}` }, timeout: '10s', redirects: 0 });
  otherAttempted.add(1); otherErrors.add(Number(r.status !== 200));
}
// Deterministic positions: recent = the last `recentWindow` positions of the settled fixture, deep = its older half.
export function reader() {
  const k = execution.vu.iterationInScenario, after = replayPosition(data.size, recentWindow, limit, depth, Number(execution.scenario.name.slice(7)), k);
  const path = arm === 'A' ? `events?after_seq=${after}&limit=${limit}&history_generation=${data.generation}` : `messages?after_seq=${after}&limit=${limit}`;
  const r = http.get(`${__ENV.BASE_URL}/api/v1/orgs/${data.organization}/channels/${data.channel}/${path}`,
    { headers: { Authorization: `Bearer ${tokens[execution.vu.idInTest % tokens.length]}` }, timeout: '10s', redirects: 0 });
  if (k < warmups) return;
  pages.add(1);
  if (Date.now() - execution.scenario.startTime > (senderSeconds - 10) * 1000) late.add(1);
  if (r.status !== 200) { errors.add(1); return; }
  latency.add(r.timings.duration);
  // Exactly `limit` consecutive positions after the cursor, in either wire shape.
  const body = r.json() as { events?: { type: string; seq: number }[]; messages?: { seq: number }[] };
  const seqs = arm === 'A' ? (body.events ?? []).filter(e => e.type === 'message').map(e => e.seq) : (body.messages ?? []).map(m => m.seq);
  const count = arm === 'A' ? body.events?.length : body.messages?.length;
  if (count !== limit || seqs.length !== limit || seqs.some((s, i) => s !== after + 1 + i)) invalid.add(1);
}
export function handleSummary(summary: { metrics: Record<string, { values: Record<string, number> }> }) {
  const v = (m: string, s = 'count') => summary.metrics[m]?.values[s];
  return { stdout: `SLICE5_RESULT ${JSON.stringify({ pages: v('s5_pages') ?? -1, invalidPages: v('s5_invalid_pages') ?? -1,
    readerErrors: v('s5_reader_errors') ?? -1, other: { attempted: v('s5_other_attempted') ?? -1, errors: v('s5_other_errors') ?? -1 }, outsideSender: v('s5_reader_outside_sender') ?? -1,
    p50: v('s5_replay_ms', 'p(50)') ?? null, p95: v('s5_replay_ms', 'p(95)') ?? null, max: v('s5_replay_ms', 'max') ?? null,
    sender: { ...Object.fromEntries(sendNames.map(n => [n, v(`s5_send_${n}`) ?? -1])), droppedIterations: v('dropped_iterations{scenario:sender}') ?? 0, p95: null } })}\n` };
}
