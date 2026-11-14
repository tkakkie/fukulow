// O5 uses the production client's held-target scheduler and refetch bounds.
// Run only against a disposable seed via ACTIVITY_SEED; never print credentials or bodies.
import http from 'k6/http';
import { Counter, Gauge, Trend } from 'k6/metrics';
import { setTimeout, clearTimeout } from 'k6/timers';
import { WebSocket } from 'k6/websockets';
import type { Options } from 'k6/options';
import { createActivity, createActivityTarget } from '../web/src/activity.ts';
import type { ActivityNotice } from '../web/src/activity.ts';
import type { Result } from '../web/src/api.ts';

Object.assign(globalThis, { setTimeout, clearTimeout });
type Seed = { organization: string; tokens: string[]; channel: string; topic: string };
const seed = JSON.parse(open(__ENV.ACTIVITY_SEED || '/seed.json')) as Seed;
const count = Number(__ENV.ACTIVITY_SOCKETS || 10_000);
const offset = Number(__ENV.ACTIVITY_OFFSET || 0);
const connectInterval = Number(__ENV.ACTIVITY_CONNECT_INTERVAL_MS || 100);
const seconds = Number(__ENV.ACTIVITY_SECONDS || 95);
const base = (__ENV.BASE_URL || 'http://host.docker.internal:18097').replace(/\/$/, '');
const active = new Gauge('activity_connections');
const errors = new Counter('activity_errors');
const calls = new Counter('activity_rest_requests');
const latency = new Trend('activity_rest_latency_ms', true);
const first = new Trend('activity_first_periodic_offset_ms', true);
const firstRequest = new Trend('activity_first_periodic_request_offset_ms', true);
const scheduleGap = new Trend('activity_steady_periodic_gap_ms', true);
const scheduled = new Counter('activity_periodic_schedules');
export const options: Options = {
  scenarios: { activity: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '240s', gracefulStop: '0s' } },
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max'],
  systemTags: ['status', 'method', 'name', 'expected_response'],
  thresholds: { activity_errors: ['count==0'], activity_connections: ['value==0'], http_req_failed: ['rate==0'],
    ...Object.fromEntries(['ready', 'first', 'steady'].flatMap(phase => [[`activity_rest_requests{phase:${phase}}`, ['count>=0']], [`activity_rest_latency_ms{phase:${phase}}`, ['max>=0']]])),
  },
};
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export default async function () {
  const sockets: WebSocket[] = [];
  const controllers: ReturnType<typeof createActivity>[] = [];
  let connected = 0, ready = 0, stopping = false;
  errors.add(0);
  const org = `${base}/api/v1/orgs/${seed.organization}`;
  for (let index = 0; index < count; index++) {
    const token = seed.tokens[Math.floor((index + offset) / 32)];
    if (!token) throw new Error('The disposable seed needs one Account per 32 sockets');
    const socket = new WebSocket(`${org.replace(/^http/, 'ws')}/ws`, null, { headers: { Authorization: `Bearer ${token}` } });
    sockets.push(socket);
    let opened = false;
    socket.addEventListener('open', () => { opened = true; connected++; active.add(connected); });
    socket.addEventListener('error', () => errors.add(1, { kind: 'websocket' }));
    socket.addEventListener('close', () => { if (opened) { connected--; active.add(connected); } if (!stopping) errors.add(1, { kind: 'unexpected_close' }); });
    socket.addEventListener('message', event => {
      if (!('data' in event)) return;
      const notice = JSON.parse(String(event.data)) as ActivityNotice;
      if (notice.type !== 'activity_ready') return;
      ready++;
      const started = Date.now();
      const controller = createActivity({ watched: () => false });
      controllers.push(controller);
      const mix: [string, string][] = [['channels', `${org}/channels`], ['capabilities', `${org}/me`]];
      if ((index + offset) % 4 === 0) mix.push(['members', `${org}/members`]);
      if (index % 4 === 1) mix.push(['channel-members:c', `${org}/channels/${seed.channel}/members`]);
      if (index % 4 === 2) mix.push(['main:c', `${org}/channels/${seed.channel}/topics`]);
      if (index % 4 === 3) mix.push(['topic:c:t', `${org}/channels/${seed.channel}/topics/${seed.topic}`]);
      for (const [key, url] of mix) {
        let invalidations = 0, previousPeriodic = 0;
        const target = createActivityTarget({
          async load(): Promise<Result<undefined>> {
            const phase = invalidations <= 1 ? 'ready' : invalidations === 2 ? 'first' : 'steady';
            const begin = Date.now();
            if (phase === 'first' && key === 'channels') firstRequest.add(begin - started);
            const response = await http.asyncRequest('GET', url, null, { headers: { Authorization: `Bearer ${token}` }, timeout: '10s', tags: { name: key.split(':')[0], phase } });
            calls.add(1, { target: key.split(':')[0], phase });
            latency.add(Date.now() - begin, { target: key.split(':')[0], phase });
            if (response.status !== 200) { errors.add(1, { kind: `http_${response.status}` }); return { ok: false, kind: 'http', status: response.status }; }
            return { ok: true, data: undefined };
          },
          accept() {},
        });
        controller.hold(key, {
          invalidate(reason, delay) {
            invalidations++;
            if (key === 'channels' && invalidations >= 2) {
              scheduled.add(1, { phase: invalidations === 2 ? 'first' : 'steady' });
              if (invalidations === 2) first.add(Date.now() - started);
              else scheduleGap.add(Date.now() - previousPeriodic);
              previousPeriodic = Date.now();
            }
            target.invalidate(reason, delay);
          },
          close: target.close,
        });
      }
      controller.notice(notice);
    });
    if ((index + 1) % 100 === 0) await pause(connectInterval);
  }
  const deadline = Date.now() + 60_000;
  while (ready < count && Date.now() < deadline) await pause(100);
  console.log(JSON.stringify({ requested: count, offset, connected, ready, held: { channels: ready, capabilities: ready, members: Math.ceil(ready / 4), channelMembers: Math.ceil(ready / 4), mainSummaries: Math.ceil(ready / 4), topicSummaries: Math.ceil(ready / 4) }, periodMs: 30_000, measurementSecondsAfterReady: seconds }));
  if (ready !== count) errors.add(count - ready, { kind: 'not_ready' });
  await pause(seconds * 1000);
  stopping = true;
  controllers.forEach(controller => controller.close()); sockets.forEach(socket => socket.close());
  await pause(1000);
}

export function handleSummary(data: unknown) { return { '/output/summary.json': JSON.stringify(data, null, 2) }; }
