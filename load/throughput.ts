import { sleep } from 'k6';
import execution from 'k6/execution';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import type { AcceptInviteRequest, CreateInviteRequest, InviteResponse, NativeSessionResponse, SendMessageRequest, SignInRequest } from '../web/src/api-schema.d.ts';
import { positiveInteger } from './delivery.ts';
import { organizationPath, signInPath } from './compat.ts';
import { baseUrl, params, requireStatus, revoke, seed, uuid, type Setup } from './seed.ts';
import { summaryForReport } from './summary.ts';
import { classifySend, selectSender, throughputPlan, throughputReport } from './throughput-summary.ts';

const mode = __ENV.THROUGHPUT_SCENARIO || 'many';
if (!['many', 'hot'].includes(mode)) throw new Error('THROUGHPUT_SCENARIO must be many or hot');
const channels = mode === 'hot' ? 1 : positiveInteger(__ENV.CHANNELS, 200);
if (mode === 'many' && channels < 200) throw new Error('many requires at least 200 Channels');
const members = positiveInteger(__ENV.THROUGHPUT_MEMBERS, 4);
if (members < 2) throw new Error('THROUGHPUT_MEMBERS must be at least 2');
const timeout = positiveInteger(__ENV.REQUEST_TIMEOUT_SECONDS, 10);
const steps = throughputPlan(__ENV.THROUGHPUT_RATES, __ENV.THROUGHPUT_STEP_SECONDS, timeout);
const preAllocatedVUs = positiveInteger(__ENV.THROUGHPUT_VUS, 100);
const maxVUs = positiveInteger(__ENV.THROUGHPUT_MAX_VUS, 2000);
if (maxVUs < preAllocatedVUs) throw new Error('THROUGHPUT_MAX_VUS must be at least THROUGHPUT_VUS');

const attempted = new Counter('throughput_attempted');
const accepted = new Counter('throughput_accepted');
const inWindow = new Counter('throughput_accepted_in_window');
const rejected429 = new Counter('throughput_429');
const rejected = new Counter('throughput_503');
const other = new Counter('throughput_other');
const invalidRetry = new Counter('throughput_invalid_retry_after');
const retry = new Trend('throughput_retry_after');
const latency = new Trend('throughput_accepted_ms', true);
// Offset from scenario start for drain attribution, not HTTP latency.
const completionOffset = new Trend('throughput_completion_offset_ms', true);
const counters = ['throughput_attempted', 'throughput_accepted', 'throughput_accepted_in_window',
  'throughput_429', 'throughput_503', 'throughput_other', 'throughput_invalid_retry_after', 'dropped_iterations'];
export const options: Options = {
  scenarios: Object.fromEntries(steps.map(step => [step.name, { executor: 'constant-arrival-rate',
    rate: step.rate, timeUnit: '1s', duration: `${step.seconds}s`, startTime: `${step.startSeconds}s`,
    preAllocatedVUs, maxVUs, gracefulStop: `${timeout + 1}s` }])),
  setupTimeout: `${channels * 5 + members * 20 + 30}s`, teardownTimeout: `${members * 5 + 15}s`,
  summaryTrendStats: ['min', 'med', 'max', 'p(95)', 'p(99)'],
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  thresholds: {
    checks: ['rate==1'], throughput_other: ['count==0'],
    throughput_invalid_retry_after: ['count==0'],
    ...Object.fromEntries(steps.flatMap(step => [
      ...counters.map(metric => [`${metric}{scenario:${step.name}}`, ['count>=0']]),
      ...['throughput_accepted_ms', 'throughput_completion_offset_ms', 'throughput_retry_after']
        .map(metric => [`${metric}{scenario:${step.name}}`, ['max>=0']]),
    ])),
  },
};

export function setup(): Setup {
  const data = seed({ channels, subscribers: 1, socketsPerSession: channels, visibility: 'public', legacy: false });
  try {
    for (let i = 1; i < members; i++) {
      const email = `throughput-${i}@example.invalid`;
      const password = uuid();
      const invite: CreateInviteRequest = { email, role: 'member' };
      const response = http.post(`${baseUrl}${organizationPath(data.organizationId, false)}/invites`, JSON.stringify(invite), params('invite', data.token));
      requireStatus(response, 201, 'invite');
      const accept: AcceptInviteRequest = { email, password, name: `Load Member ${i}`, token: (response.json() as InviteResponse).token };
      requireStatus(http.post(`${baseUrl}${organizationPath(data.organizationId, false)}/invites/accept`, JSON.stringify(accept), params('accept_invite')), 200, 'accept_invite');
      const signIn: SignInRequest = { email, password };
      const session = http.post(`${baseUrl}${signInPath(false)}`, JSON.stringify(signIn), params('sign_in'));
      requireStatus(session, 200, 'sign_in');
      data.tokens.push((session.json() as NativeSessionResponse).token);
    }
    console.log('LOAD_MEASUREMENT_START');
    sleep(1); // Same recorder SQL boundary as the delivery scenario; setup is excluded.
    return data;
  } catch (error) {
    revoke(data);
    throw error;
  }
}

export default function(data: Setup): void {
  const step = steps.find(step => step.name === execution.scenario.name)!;
  const index = execution.scenario.iterationInTest;
  const selection = selectSender(index, data.tokens.length, data.channelIds.length);
  const token = data.tokens[selection.member];
  const channel = data.channelIds[selection.channel];
  const body: SendMessageRequest = { client_message_id: uuid(), body: 'Load test message' };
  attempted.add(1);
  const started = Date.now();
  const response = http.post(`${baseUrl}${organizationPath(data.organizationId, false)}/channels/${channel}/messages`,
    JSON.stringify(body), { ...params('throughput_send', token), timeout: `${timeout}s` });
  const elapsed = Date.now() - execution.scenario.startTime;
  const outcome = classifySend(response.status, response.headers['Retry-After']);
  accepted.add(Number(outcome.outcome === 'accepted'));
  inWindow.add(Number(outcome.outcome === 'accepted' && elapsed <= step.seconds * 1000));
  rejected429.add(Number(outcome.outcome === 'rejected429'));
  rejected.add(Number(outcome.outcome === 'rejected503'));
  other.add(Number(outcome.outcome === 'other'));
  invalidRetry.add(Number(outcome.invalidRetryAfter));
  if (outcome.outcome === 'accepted') latency.add(Date.now() - started);
  if ((outcome.outcome === 'rejected429' || outcome.outcome === 'rejected503') && !outcome.invalidRetryAfter) retry.add(Number(response.headers['Retry-After']));
  completionOffset.add(elapsed);
}

export function teardown(data: Setup): void {
  console.log('LOAD_MEASUREMENT_END');
  sleep(1);
  revoke(data);
}

export function handleSummary(data: unknown): Record<string, string> {
  const report = { mode, channels, members, preAllocatedVUs, maxVUs, requestTimeoutSeconds: timeout,
    subscribers: 0, ...throughputReport(data, steps) };
  return { stdout: 'LOAD_THROUGHPUT ' + JSON.stringify(report) + '\nLOAD_SUMMARY ' + JSON.stringify(summaryForReport(data)) + '\n' };
}
