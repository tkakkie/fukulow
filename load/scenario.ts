import { check, fail } from 'k6';
import { randomBytes } from 'k6/crypto';
import http, { type Params, type Response } from 'k6/http';
import { Counter, Gauge, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import { setTimeout } from 'k6/timers';
import { WebSocket } from 'k6/websockets';
import type {
  Channel, ClientMessage, CreateChannelRequest, Message, ServerEvent,
  SendMessageRequest, SessionResponse, SetupRequest, SignInRequest,
} from '../web/src/api-schema.d.ts';
import { Deliveries, positiveInteger } from './delivery.ts';
import { schedule, sessionIndex } from './scheduler.ts';
import { revokeSessions } from './sessions.ts';
import { summaryForReport } from './summary.ts';
import { legacyOrganization, organizationPath } from './compat.ts';

const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const channels = positiveInteger(__ENV.CHANNELS, 1);
const subscribers = positiveInteger(__ENV.SUBSCRIBERS, 5);
// Sends per batch, formerly in-flight workers; offered sends/s = publishers * 1000 / interval.
const publishers = positiveInteger(__ENV.PUBLISHERS, 2);
const publishChannels = positiveInteger(__ENV.PUBLISH_CHANNELS, channels);
if (publishChannels > channels) fail('PUBLISH_CHANNELS exceeds CHANNELS');
const duration = positiveInteger(__ENV.DURATION_SECONDS, 10);
const interval = positiveInteger(__ENV.PUBLISH_INTERVAL_MS, 250);
const readyTimeout = positiveInteger(__ENV.READY_TIMEOUT_SECONDS, 5);
const drainTimeout = positiveInteger(__ENV.DRAIN_TIMEOUT_SECONDS, 5);
const socketsPerSession = positiveInteger(__ENV.SOCKETS_PER_SESSION, 1);
const legacy = __ENV.LOAD_LEGACY === '1';
const allowRejections = __ENV.LOAD_ALLOW_REJECTIONS === '1';
const reconnect = __ENV.LOAD_RECONNECT === '1';
const connectBatch = positiveInteger(__ENV.CONNECT_BATCH, channels * subscribers);
const connectInterval = positiveInteger(__ENV.CONNECT_INTERVAL_MS, 100);
const requestTimeout = positiveInteger(__ENV.REQUEST_TIMEOUT_SECONDS, 45);
const measurementPause = __ENV.LOAD_MEASURE === '1' ? 1000 : 0;
const visibility: Channel['visibility'] = channelVisibility();

function channelVisibility(): Channel['visibility'] {
  const value = __ENV.CHANNEL_VISIBILITY || 'public';
  if (value !== 'public' && value !== 'private') return fail('Invalid CHANNEL_VISIBILITY');
  return value;
}

const connections = new Gauge('concurrent_connections');
const subscriptions = new Gauge('subscribers_per_channel');
const publishes = new Gauge('concurrent_publishes');
const deliveryLatency = new Trend('delivery_latency', true);
const publishResponseTime = new Trend('publish_http_response_time', true);
const acceptedResponseTime = new Trend('accepted_http_response_time', true);
const rejectedResponseTime = new Trend('rejected_http_response_time', true);
const errors = new Counter('load_errors');
const missing = new Counter('missing_deliveries');
const published = new Counter('published_messages');
const delivered = new Counter('delivered_messages');
const attempted = new Counter('attempted_sends');
const rejected = new Counter('rejected_sends');
const retryAfter = new Trend('retry_after_seconds');
const invalidRetryAfter = new Counter('invalid_retry_after');
const closed = new Counter('socket_closes');
const reconnected = new Counter('socket_reconnects');

export const options: Options = {
  scenarios: {
    // One event loop owns every socket/request so gauges are actual totals, not per-VU samples.
    chat: { executor: 'shared-iterations', vus: 1, iterations: 1,
      maxDuration: `${readyTimeout + duration + drainTimeout + requestTimeout + Math.ceil(channels * subscribers / connectBatch) * connectInterval / 1000 + 10}s`, gracefulStop: '0s' },
  },
  // Reserve time for provisioning and revoking every session if setup fails.
  setupTimeout: `${Math.max(1, Math.ceil(channels * subscribers / socketsPerSession)) * 10 + channels * 5 + 25}s`,
  teardownTimeout: `${Math.max(1, Math.ceil(channels * subscribers / socketsPerSession)) * 5 + 10}s`,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  thresholds: {
    checks: ['rate==1'],
    ...(allowRejections ? {} : { http_req_failed: ['rate==0'] }),
    invalid_retry_after: ['count==0'],
    load_errors: ['count==0'],
    missing_deliveries: ['count==0'],
    published_messages: ['count>0'],
    delivered_messages: ['count>0'],
    iterations: ['count==1'],
    concurrent_connections: ['value==0'],
    concurrent_publishes: ['value==0'],
    ...Object.fromEntries([1000, 1001, 1005, 1006, 1011, 4001, 4003, 4008].map(code =>
      [`socket_closes{code:${code}}`, ['count>=0']])),
    ...Object.fromEntries(Array.from({ length: channels }, (_, channel) =>
      [`delivery_latency{channel:${channel}}`, ['max>=0']])),
    ...Object.fromEntries(Array.from({ length: channels }, (_, channel) =>
      [`subscribers_per_channel{channel:${channel}}`, ['value==0']])),
  },
};

type Setup = { token: string; tokens: string[]; channelIds: string[]; organizationId: string };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function params(operation: string, token?: string): Params {
  return { timeout: `${requestTimeout}s`, redirects: 0, tags: { name: operation, operation },
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
}

function requireStatus(response: Response, status: number, operation: string): void {
  if (!check(response, { [operation]: (r) => r.status === status })) {
    // Never print response bodies: sign-in returns the bearer credential.
    fail(`${operation} returned ${response.status}, expected ${status}`);
  }
}

export function setup(): Setup {
  requireStatus(http.get(`${baseUrl}/api/v1/health`, params('health')), 200, 'health');
  const email = __ENV.LOAD_EMAIL;
  const password = __ENV.LOAD_PASSWORD;
  if (!email || !password) fail('Set LOAD_EMAIL and LOAD_PASSWORD for a disposable test Organization');
  if (__ENV.LOAD_BOOTSTRAP === '1') {
    const body: SetupRequest = { email, password, name: 'Load Owner',
      organization_name: 'Load test', setup_token: __ENV.LOAD_SETUP_TOKEN };
    requireStatus(http.post(`${baseUrl}/api/v1/setup`, JSON.stringify(body), params('setup')), 201, 'setup');
  }
  const body: SignInRequest = { email, password };
  const response = http.post(`${baseUrl}/api/v1/session`, JSON.stringify(body), params('sign_in'));
  requireStatus(response, 200, 'sign_in');
  const { token, identity } = response.json() as SessionResponse;
  const organizationId = legacy ? legacyOrganization(identity) : (__ENV.LOAD_ORGANIZATION_ID || identity.organizations[0]?.organization_id);
  if (!organizationId || (!legacy && !identity.organizations.some((organization) => organization.organization_id === organizationId))) fail('LOAD_ORGANIZATION_ID must name an active Organization membership');
  const tokens = [token];
  try {
    for (let i = 1; i < Math.ceil(channels * subscribers / socketsPerSession); i++) {
      const session = http.post(`${baseUrl}/api/v1/session`, JSON.stringify(body), params('sign_in'));
      requireStatus(session, 200, 'sign_in');
      tokens.push((session.json() as SessionResponse).token);
    }
    const channelIds = Array.from({ length: channels }, (_, index) => {
      const body: CreateChannelRequest = { name: `load-${Date.now()}-${index}`, visibility };
      const response = http.post(`${baseUrl}${organizationPath(organizationId, legacy)}/channels`, JSON.stringify(body), params('create_channel', token));
      requireStatus(response, 201, 'create_channel');
      return (response.json() as Channel).id;
    });
    return { token, tokens, channelIds, organizationId };
  } catch (error) {
    // k6 skips teardown when setup fails; retain the provisioning error if sign-out also fails.
    try {
      teardown({ token, tokens, channelIds: [], organizationId });
    } catch {
      console.error('Failed to revoke session after setup failure');
    }
    throw error;
  }
}

function uuid(): string {
  const bytes = new Uint8Array(randomBytes(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default async function (data: Setup): Promise<void> {
  const sockets: WebSocket[] = [];
  const perChannel = data.channelIds.map(() => 0);
  const deliveries = new Deliveries();
  let activeConnections = 0;
  let activePublishes = 0;
  let peakPublishes = 0;
  let peakConnections = 0;
  let closing = false;
  let offered = 0;
  let accepted = 0;
  let refusals = 0;
  let firstOfferedAt = 0;
  let lastOfferedAt = 0;
  let sendStartedAt = 0;
  let sendCompletedAt = 0;
  let failed = false;
  attempted.add(0);
  rejected.add(0);
  invalidRetryAfter.add(0);
  closed.add(0);
  reconnected.add(0);
  errors.add(0);
  missing.add(0);
  published.add(0);
  delivered.add(0);
  connections.add(0);
  publishes.add(0);
  const recordError = (reason: string) => {
    if (!failed) console.error(reason);
    failed = true;
    errors.add(1);
  };

  function connect(channelId: string, channel: number, socketIndex: number, afterSeq = 0): void {
    const tags = { channel: String(channel) };
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}${organizationPath(data.organizationId, legacy)}/ws`, null,
      { headers: { Authorization: `Bearer ${data.tokens[sessionIndex(socketIndex, socketsPerSession)]}` }, tags: { name: 'subscribe' } });
    sockets[socketIndex] = socket;
    let opened = false;
    let subscribed = false;
    let lastSeq = afterSeq;
    socket.onopen = () => {
      opened = true;
      connections.add(++activeConnections);
      peakConnections = Math.max(peakConnections, activeConnections);
      const body: ClientMessage = { type: 'subscribe', channel_id: channelId, after_seq: afterSeq };
      socket.send(JSON.stringify(body));
    };
    socket.onmessage = (frame) => {
      try {
        const event = JSON.parse(String(frame?.data)) as ServerEvent;
        if (event.type === 'error') throw new Error('Subscription refused');
        if (event.type === 'subscribed') {
          if (subscribed || event.channel_id !== channelId || event.caught_up_seq < afterSeq) {
            throw new Error('Unexpected subscription acknowledgement');
          }
          subscribed = true;
          subscriptions.add(++perChannel[channel], tags);
        } else if (event.type === 'message') {
          const message = event.message;
          if (message.channel_id !== channelId) throw new Error('Unexpected Channel');
          if (message.seq <= lastSeq) return; // Contract permits duplicate events.
          if (message.seq !== lastSeq + 1) throw new Error('Sequence gap');
          lastSeq = message.seq;
          deliveryLatency.add(deliveries.receive(message.client_message_id, Date.now()), tags);
          delivered.add(1, tags);
        } else {
          throw new Error('Unexpected event');
        }
      } catch (error) {
        recordError(String(error));
      }
    };
    socket.onerror = () => {
      if (!closing && !reconnect) recordError('WebSocket error');
    };
    // k6 1.8.2 supplies CloseEvent.code; @types/k6 currently declares a zero-argument handler.
    socket.onclose = (event?: { code: number }) => {
      const code = event?.code ?? 1006;
      closed.add(1, { code: String(code), channel: String(channel) });
      if (opened) connections.add(--activeConnections);
      if (subscribed) subscriptions.add(--perChannel[channel], tags);
      if (!closing) {
        if (reconnect && [1001, 1006, 1011, 4008].includes(code)) {
          setTimeout(() => {
            if (!closing) { reconnected.add(1); connect(channelId, channel, socketIndex, lastSeq); }
          }, 1000 + socketIndex % 1000);
        } else recordError('WebSocket closed before delivery completed');
      }
    };
  }

  async function publish(index: number): Promise<void> {
    lastOfferedAt = Date.now();
    firstOfferedAt ||= lastOfferedAt;
    offered++;
    attempted.add(1);
    const channel = index % publishChannels;
    const channelId = data.channelIds[channel];
    const body: SendMessageRequest = { client_message_id: uuid(), body: 'Load test message' };
    deliveries.start(body.client_message_id, Date.now(), subscribers);
    publishes.add(++activePublishes);
    peakPublishes = Math.max(peakPublishes, activePublishes);
    const started = Date.now();
    try {
      const response = await http.asyncRequest('POST', `${baseUrl}${organizationPath(data.organizationId, legacy)}/channels/${channelId}/messages`,
        JSON.stringify(body), params('publish', data.token));
      publishResponseTime.add(Date.now() - started, { channel: String(channel) });
      if (response.status === 503 && allowRejections) {
        rejectedResponseTime.add(Date.now() - started);
        refusals++;
        rejected.add(1);
        const retry = response.headers['Retry-After'];
        if (!/^[1-9]\d*$/.test(retry || '')) invalidRetryAfter.add(1);
        else retryAfter.add(Number(retry));
        deliveries.cancel(body.client_message_id);
        return;
      }
      requireStatus(response, 201, 'send_message');
      const message = response.json() as Message;
      if (!check(message, { 'canonical send': (m) => m.channel_id === channelId &&
        m.client_message_id === body.client_message_id && m.body === body.body && m.seq > 0 })) {
        throw new Error('Unexpected send response');
      }
      acceptedResponseTime.add(Date.now() - started);
      accepted++;
      published.add(1, { channel: String(channel) });
    } catch (error) {
      recordError(String(error));
    } finally {
      sendCompletedAt = Date.now();
      publishes.add(--activePublishes);
    }
  }

  try {
    data.channelIds.forEach((_, channel) => subscriptions.add(0, { channel: String(channel) }));
    for (let index = 0; index < channels * subscribers; index++) {
      const channel = Math.floor(index / subscribers);
      connect(data.channelIds[channel], channel, index);
      if ((index + 1) % connectBatch === 0) await pause(connectInterval);
    }
    const readyDeadline = Date.now() + readyTimeout * 1000;
    while (!failed && perChannel.some((count) => count !== subscribers) && Date.now() < readyDeadline) {
      await pause(10);
    }
    if (failed || perChannel.some((count) => count !== subscribers)) {
      throw new Error('Not all WebSockets subscribed before the deadline');
    }
    console.log('LOAD_MEASUREMENT_START');
    await pause(measurementPause);
    sendStartedAt = Date.now();
    const result = await schedule(duration * 1000, interval, publishers, Date.now, pause, publish);
    console.log('LOAD_RATE ' + JSON.stringify({ ...result, offeredSendRate: result.offered / (result.elapsedMs / 1000),
      firstOfferedAt, lastOfferedAt, launchSpanMs: lastOfferedAt - firstOfferedAt,
      accepted, refusals, acceptedSendRate: accepted / (Math.max(result.elapsedMs, sendCompletedAt - result.startedAt) / 1000),
      legacy, allowRejections, reconnect, connectBatch, connectInterval, requestTimeout,
      configuredSendRate: publishers * 1000 / interval, peakConnections, peakPublishes,
      channels, publishChannels, subscribers, publishers, duration, interval, socketsPerSession, sessions: data.tokens.length, visibility,
      readyTimeout, drainTimeout }));
    const drainDeadline = Date.now() + drainTimeout * 1000;
    while (!failed && deliveries.missing > 0 && Date.now() < drainDeadline) await pause(10);
    missing.add(deliveries.missing);
    check(deliveries.missing, { 'every subscriber received every send': (count) => count === 0 });
    console.log('LOAD_MEASUREMENT_END');
    await pause(measurementPause);
  } catch (error) {
    recordError(String(error));
    throw error;
  } finally {
    console.log('LOAD_PROGRESS ' + JSON.stringify({ offered, accepted, refusals, activeConnections, peakConnections,
      peakPublishes, perChannel, firstOfferedAt, lastOfferedAt, sendStartedAt, sendCompletedAt, missing: deliveries.missing,
      channels, subscribers, publishers, duration, interval, socketsPerSession, connectBatch, connectInterval,
      readyTimeout, drainTimeout, legacy, allowRejections, reconnect, requestTimeout }));
    closing = true;
    for (const socket of sockets) socket.close();
  }
}

export function teardown(data: Setup): void {
  revokeSessions(data?.tokens ?? [], (token) => {
    requireStatus(http.del(`${baseUrl}/api/v1/session`, null, params('sign_out', token)), 204, 'sign_out');
  });
}

export function handleSummary(data: unknown): Record<string, string> {
  return { stdout: 'LOAD_SUMMARY ' + JSON.stringify(summaryForReport(data)) + '\n' };
}
