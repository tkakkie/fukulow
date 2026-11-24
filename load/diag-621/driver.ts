// k6 send generator for the #621 C1/C2 diagnostic; the 2026-11-23 driver.js with types.
import execution from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { randomBytes } from 'k6/crypto';
import type { Options } from 'k6/options';

const { organization, channels, tokens } = JSON.parse(open('/fixture.json')) as { organization: string; channels: string[]; tokens: string[] };
const duration = Number(__ENV.SECONDS);
const rate = Number(__ENV.RATE);
const prefix = Array.from(new Uint8Array(randomBytes(8)), n => n.toString(16).padStart(2, '0')).join('');
const success = new Trend('send_success_ms', true);
const outcomes = new Counter('send_status');
const sendFailures = new Counter('send_failures');

export const options: Options = {
  scenarios: { send: { executor: 'constant-arrival-rate', rate, timeUnit: '1s',
    duration: `${duration}s`, preAllocatedVUs: 100, maxVUs: 200, gracefulStop: '11s' } },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: { send_failures: ['count>=0'] },
};

export default function () {
  const i = execution.scenario.iterationInTest;
  if (i === 0) console.log(`DIAG_START ${execution.scenario.startTime}`);
  const channel = channels[i % channels.length];
  const clientId = `${prefix.slice(0, 8)}-${prefix.slice(8, 12)}-4${prefix.slice(12, 15)}-8${prefix.slice(15)}00-${i.toString(16).padStart(12, '0')}`;
  const r = http.post(`http://fk621-app:8080/api/v1/orgs/${organization}/channels/${channel}/messages`,
    JSON.stringify({ body: 'Load test message', client_message_id: clientId }),
    { headers: { Authorization: `Bearer ${tokens[i % tokens.length]}`, 'Content-Type': 'application/json' }, timeout: '10s', redirects: 0 });
  outcomes.add(1, { status: String(r.status) });
  sendFailures.add(Number(r.status !== 201));
  if (r.status === 201) success.add(r.timings.duration);
  else console.warn(`SEND_FAILURE ${r.status}`);
}

export function handleSummary(summary: { metrics: unknown }) {
  return { stdout: `DIAG_RESULT ${JSON.stringify(summary.metrics)}\n` };
}
