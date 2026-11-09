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

const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const channels = positiveInteger(__ENV.CHANNELS, 1);
const subscribers = positiveInteger(__ENV.SUBSCRIBERS, 5);
const publishers = positiveInteger(__ENV.PUBLISHERS, 2);
const duration = positiveInteger(__ENV.DURATION_SECONDS, 10);
const interval = positiveInteger(__ENV.PUBLISH_INTERVAL_MS, 250);
const readyTimeout = positiveInteger(__ENV.READY_TIMEOUT_SECONDS, 5);
const drainTimeout = positiveInteger(__ENV.DRAIN_TIMEOUT_SECONDS, 5);
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
const errors = new Counter('load_errors');
const missing = new Counter('missing_deliveries');
const published = new Counter('published_messages');
const delivered = new Counter('delivered_messages');

export const options: Options = {
  scenarios: {
    // One event loop owns every socket/request so gauges are actual totals, not per-VU samples.
    chat: { executor: 'shared-iterations', vus: 1, iterations: 1,
      maxDuration: `${readyTimeout + duration + drainTimeout + 10}s`, gracefulStop: '0s' },
  },
  setupTimeout: '10s',
  teardownTimeout: '5s',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    load_errors: ['count==0'],
    missing_deliveries: ['count==0'],
    published_messages: ['count>0'],
    delivered_messages: ['count>0'],
    iterations: ['count==1'],
    concurrent_connections: ['value==0'],
    concurrent_publishes: ['value==0'],
    ...Object.fromEntries(Array.from({ length: channels }, (_, channel) =>
      [`subscribers_per_channel{channel:${channel}}`, ['value==0']])),
  },
};

type Setup = { token: string; channelIds: string[] };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function params(operation: string, token?: string): Params {
  return { timeout: '5s', redirects: 0, tags: { name: operation, operation },
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
  const body: SignInRequest = { email, password, organization_id: __ENV.LOAD_ORGANIZATION_ID };
  const response = http.post(`${baseUrl}/api/v1/session`, JSON.stringify(body), params('sign_in'));
  requireStatus(response, 200, 'sign_in');
  const { token } = response.json() as SessionResponse;
  try {
    const channelIds = Array.from({ length: channels }, (_, index) => {
      const body: CreateChannelRequest = { name: `load-${Date.now()}-${index}`, visibility };
      const response = http.post(`${baseUrl}/api/v1/channels`, JSON.stringify(body), params('create_channel', token));
      requireStatus(response, 201, 'create_channel');
      return (response.json() as Channel).id;
    });
    return { token, channelIds };
  } catch (error) {
    // k6 skips teardown when setup fails; retain the provisioning error if sign-out also fails.
    try {
      teardown({ token, channelIds: [] });
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
  let closing = false;
  let failed = false;
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

  function connect(channelId: string, channel: number): void {
    const tags = { channel: String(channel) };
    subscriptions.add(0, tags);
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/v1/ws`, null,
      { headers: { Authorization: `Bearer ${data.token}` }, tags: { name: 'subscribe' } });
    sockets.push(socket);
    let opened = false;
    let subscribed = false;
    let lastSeq = 0;
    socket.onopen = () => {
      opened = true;
      connections.add(++activeConnections);
      const body: ClientMessage = { type: 'subscribe', channel_id: channelId, after_seq: 0 };
      socket.send(JSON.stringify(body));
    };
    socket.onmessage = (frame) => {
      try {
        const event = JSON.parse(String(frame?.data)) as ServerEvent;
        if (event.type === 'error') throw new Error('Subscription refused');
        if (event.type === 'subscribed') {
          if (subscribed || event.channel_id !== channelId || event.caught_up_seq !== 0) {
            throw new Error('Unexpected subscription acknowledgement');
          }
          subscribed = true;
          subscriptions.add(++perChannel[channel], tags);
        } else if (event.type === 'message') {
          const message = event.message;
          if (!subscribed || message.channel_id !== channelId) throw new Error('Unexpected Channel');
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
      // #57 owns the server's missing close-frame reply; teardown starts after delivery checks.
      if (!closing) recordError('WebSocket error');
    };
    socket.onclose = () => {
      if (opened) connections.add(--activeConnections);
      if (subscribed) subscriptions.add(--perChannel[channel], tags);
      if (!closing) recordError('WebSocket closed before delivery completed');
    };
  }

  async function publish(worker: number, deadline: number): Promise<void> {
    let iteration = worker;
    while (!failed && Date.now() < deadline) {
      const channel = iteration++ % channels;
      const channelId = data.channelIds[channel];
      const body: SendMessageRequest = { client_message_id: uuid(), body: 'Load test message' };
      deliveries.start(body.client_message_id, Date.now(), subscribers);
      publishes.add(++activePublishes);
      peakPublishes = Math.max(peakPublishes, activePublishes);
      const started = Date.now();
      try {
        const response = await http.asyncRequest('POST', `${baseUrl}/api/v1/channels/${channelId}/messages`,
          JSON.stringify(body), params('publish', data.token));
        publishResponseTime.add(Date.now() - started, { channel: String(channel) });
        requireStatus(response, 201, 'send_message');
        const message = response.json() as Message;
        if (!check(message, { 'canonical send': (m) => m.channel_id === channelId &&
          m.client_message_id === body.client_message_id && m.body === body.body && m.seq > 0 })) {
          throw new Error('Unexpected send response');
        }
        published.add(1, { channel: String(channel) });
      } catch (error) {
        recordError(String(error));
      } finally {
        publishes.add(--activePublishes);
      }
      if (!failed && Date.now() < deadline) await pause(interval);
    }
  }

  try {
    data.channelIds.forEach((id, channel) => {
      for (let i = 0; i < subscribers; i++) connect(id, channel);
    });
    const readyDeadline = Date.now() + readyTimeout * 1000;
    while (!failed && perChannel.some((count) => count !== subscribers) && Date.now() < readyDeadline) {
      await pause(10);
    }
    if (failed || perChannel.some((count) => count !== subscribers)) {
      throw new Error('Not all WebSockets subscribed before the deadline');
    }
    const deadline = Date.now() + duration * 1000;
    await Promise.all(Array.from({ length: publishers }, (_, worker) => publish(worker, deadline)));
    check(peakPublishes, { 'all publishers overlapped': (count) => count === publishers });
    const drainDeadline = Date.now() + drainTimeout * 1000;
    while (!failed && deliveries.missing > 0 && Date.now() < drainDeadline) await pause(10);
    missing.add(deliveries.missing);
    check(deliveries.missing, { 'every subscriber received every send': (count) => count === 0 });
  } catch (error) {
    recordError(String(error));
    throw error;
  } finally {
    closing = true;
    for (const socket of sockets) socket.close();
  }
}

export function teardown(data: Setup): void {
  if (data?.token) {
    requireStatus(http.del(`${baseUrl}/api/v1/session`, null, params('sign_out', data.token)), 204, 'sign_out');
  }
}
