// #668 server log reader: measurement-target events and the 60 s metrics and pool events.
import type { PoolSample, SendRecord } from './revocation-burst-judgment.ts';
import type { HoldsSample } from './revocation-holds-judgment.ts';

// `at` is harness arrival; `wallMs` is the server's own tracing `timestamp`, taken when the event
// is logged (pool_stats and websocket_closed carry no server_ms). clockWall pairs with clock.
export type Stamped = { at: number; wallMs: number | undefined };
export type ServerPoolSample = PoolSample & { wallMs: number | undefined };
export type SendBufferReadback = { peerPort: number; effective: number };
export type ServerLog = { clock: number[]; clockWall: (number | undefined)[]; sends: SendRecord[]; holds: HoldsSample[]; pool: ServerPoolSample[]; metrics: PoolSample[]; closes: Stamped[]; sendBuffers: SendBufferReadback[] };
export const emptyLog = (): ServerLog => ({ clock: [], clockWall: [], sends: [], holds: [], pool: [], metrics: [], closes: [], sendBuffers: [] });

/** tracing-subscriber's `YYYY-MM-DDTHH:MM:SS.ffffffZ` in epoch ms, keeping the microseconds. */
export function wallMs(timestamp: unknown): number | undefined {
  if (typeof timestamp !== 'string') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(timestamp);
  if (!m) return undefined;
  const seconds = Date.parse(`${m[1]}Z`);
  return Number.isFinite(seconds) ? seconds + Number(`0.${m[2] ?? '0'}`) * 1000 : undefined;
}

const finite = (...values: unknown[]): boolean => values.every(v => typeof v === 'number' && Number.isFinite(v));

/** Reads one JSON log line received at harness time `at`; other lines are ignored. */
export function readLogLine(log: ServerLog, line: string, at: number) {
  let event: { timestamp?: unknown; target?: string; fields?: Record<string, unknown> };
  try { event = JSON.parse(line); } catch { return; }
  const f = event.fields ?? {};
  if (event.target === 'fukulow_revocation_measurement') {
    if (f.event === 'revocation_clock_sample' && finite(f.server_ms)) { log.clock.push(f.server_ms as number); log.clockWall.push(wallMs(event.timestamp)); }
    if (f.event === 'channel_access_revoked_sent' && typeof f.channel_id === 'string' && finite(f.before_ms, f.after_ms) && (f.before_ms as number) <= (f.after_ms as number)) {
      log.sends.push({ channelId: f.channel_id, beforeMs: f.before_ms as number, afterMs: f.after_ms as number, afterHold: typeof f.after_hold === 'boolean' ? f.after_hold : undefined });
    }
    if (f.event === 'revocation_holds_sample' && finite(f.server_ms, f.active_holds, f.high_water_mark, f.retry_attempts)) {
      log.holds.push({ serverMs: f.server_ms as number, activeHolds: f.active_holds as number, highWaterMark: f.high_water_mark as number, retryAttempts: f.retry_attempts as number });
    }
    return;
  }
  const numeric = Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  if (event.target === 'fukulow' && f.event === 'measurement_send_buffer') {
    const { peer_port: peerPort, effective } = numeric;
    if (Number.isInteger(peerPort) && peerPort > 0 && peerPort <= 65_535 && Number.isSafeInteger(effective) && effective > 0) {
      log.sendBuffers.push({ peerPort, effective });
    }
  }
  if (f.event === 'pool_stats') log.pool.push({ at, fields: numeric, wallMs: wallMs(event.timestamp) });
  if (f.event === 'metrics') log.metrics.push({ at, fields: numeric });
  if (f.event === 'websocket_closed') log.closes.push({ at, wallMs: wallMs(event.timestamp) });
}
