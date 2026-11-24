import execution from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { randomBytes } from 'k6/crypto';
import type { Options } from 'k6/options';

const { organization, channels, tokens } = JSON.parse(open('/fixture.json')) as { organization: string; channels: string[]; tokens: string[] };
const prefix = Array.from(new Uint8Array(randomBytes(8)), byte => byte.toString(16).padStart(2, '0')).join('');
const outcomes = new Counter('send_status');
const failures = new Counter('send_failures');

export const options: Options = { scenarios: { send: { executor: 'constant-arrival-rate', rate: 250, timeUnit: '1s',
  duration: `${Number(__ENV.SECONDS)}s`, preAllocatedVUs: 100, maxVUs: 200, gracefulStop: '11s' } },
thresholds: { send_failures: ['count>=0'] } };

export default function () {
  const start = Date.now();
  const id = execution.scenario.iterationInTest;
  if (id === 0) console.log(`C3_START ${execution.scenario.startTime}`);
  const channel = channels[id % channels.length];
  const clientId = `${prefix.slice(0, 8)}-${prefix.slice(8, 12)}-4${prefix.slice(12, 15)}-8${prefix.slice(15)}00-${id.toString(16).padStart(12, '0')}`;
  const response = http.post(`http://fk621-app:8080/api/v1/orgs/${organization}/channels/${channel}/messages`,
    JSON.stringify({ body: 'Load test message', client_message_id: clientId }),
    { headers: { Authorization: `Bearer ${tokens[id % tokens.length]}`, 'Content-Type': 'application/json' }, timeout: '10s', redirects: 0 });
  const end = Date.now();
  outcomes.add(1);
  failures.add(Number(response.status !== 201));
  console.log(`C3_REQUEST ${JSON.stringify({ id, vu: execution.vu.idInTest, start, end, latency: response.timings.duration, status: response.status })}`);
}

export function handleSummary(summary: { metrics: unknown }) {
  return { stdout: `C3_RESULT ${JSON.stringify(summary.metrics)}\n` };
}
