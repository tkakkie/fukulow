// k6 Part C, R2 (report-only, Q4): WebSocket subscribe replay of a 50-position gap
// behind the latest position. Runs after the judged R1 invocation, never alongside it.
import execution from 'k6/execution';
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { WebSocket } from 'k6/websockets';

const data = JSON.parse(open('/fixture/data.json')) as { organization: string; channel: string; generation: string | null };
const tokens = new SharedArray<string>('members', () => JSON.parse(open('/fixture/tokens.json')));
const arm = __ENV.SLICE5_ARM, gap = Number(__ENV.SLICE5_LIMIT), readers = Number(__ENV.SLICE5_READERS), iterations = Number(__ENV.SLICE5_WS_ITERATIONS);
if (!['A', 'B'].includes(arm) || (arm === 'A') !== (data.generation !== null)) throw new Error('bad R2 settings');
const replays = new Counter('s5_ws_replays'), invalid = new Counter('s5_ws_invalid'), errors = new Counter('s5_ws_errors');
const latency = new Trend('s5_ws_replay_ms', true);
export const options: Options = {
  scenarios: { r2: { executor: 'per-vu-iterations', vus: readers, iterations, maxDuration: '120s' } },
  summaryTrendStats: ['p(50)', 'p(95)', 'max'],
  thresholds: { s5_ws_replays: ['count>=0'], s5_ws_invalid: ['count>=0'], s5_ws_errors: ['count>=0'], s5_ws_replay_ms: ['max>=0'] },
};

export default function () {
  const token = tokens[execution.vu.idInTest % tokens.length], base = `${__ENV.BASE_URL}/api/v1/orgs/${data.organization}`;
  const latest = http.get(`${base}/channels/${data.channel}/messages?limit=1`, { headers: { Authorization: `Bearer ${token}` }, timeout: '10s' });
  const last = (latest.json() as { messages?: { seq?: number; created_seq?: number }[] }).messages?.at(-1);
  const head = last?.created_seq ?? last?.seq;
  if (latest.status !== 200 || typeof head !== 'number') { errors.add(1); return; }
  const after = head - gap, seen: number[] = [];
  let sent = 0, done = false;
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, null, { headers: { Authorization: `Bearer ${token}` } });
  const timer = setTimeout(() => { if (!done) { errors.add(1); done = true; socket.close(); } }, 20000);
  socket.addEventListener('open', () => {
    sent = Date.now();
    socket.send(JSON.stringify({ type: 'subscribe', channel_id: data.channel, after_seq: after, ...(data.generation ? { history_generation: data.generation } : {}) }));
  });
  socket.addEventListener('error', () => { if (!done) { errors.add(1); done = true; clearTimeout(timer); } });
  socket.addEventListener('message', (event: object) => {
    if (done) return;
    const e = JSON.parse(String((event as { data?: unknown }).data)) as { type: string; channel_id?: string; seq?: number; caught_up_seq?: number; message?: { channel_id?: string; seq?: number } };
    if (e.type === 'message' && (e.message?.channel_id ?? e.channel_id) === data.channel) seen.push(arm === 'A' ? e.seq! : e.message!.seq!);
    if (e.type === 'subscribed' && e.channel_id === data.channel) {
      latency.add(Date.now() - sent); replays.add(1); done = true; clearTimeout(timer);
      // Every position from the cursor through caught_up_seq, consecutive, at least the gap.
      const through = e.caught_up_seq ?? -1, expected = through - after;
      if (expected < gap || seen.length < expected || seen.slice(0, expected).some((s, i) => s !== after + 1 + i)) invalid.add(1);
      socket.close();
    }
  });
}
export function handleSummary(summary: { metrics: Record<string, { values: Record<string, number> }> }) {
  const v = (m: string, s = 'count') => summary.metrics[m]?.values[s];
  return { stdout: `SLICE5_RESULT ${JSON.stringify({ replays: v('s5_ws_replays') ?? -1, invalid: v('s5_ws_invalid') ?? -1, errors: v('s5_ws_errors') ?? -1,
    p50: v('s5_ws_replay_ms', 'p(50)') ?? null, p95: v('s5_ws_replay_ms', 'p(95)') ?? null, max: v('s5_ws_replay_ms', 'max') ?? null })}\n` };
}
