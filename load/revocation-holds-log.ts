// #668 server log reader: measurement-target events and the 60 s metrics and pool events.
import type { PoolSample, SendRecord } from './revocation-burst-judgment.ts';
import type { HoldsSample } from './revocation-holds-judgment.ts';

// closes: harness arrival of each `websocket_closed` event, logged before the server sends Close.
export type ServerLog = { clock: number[]; sends: SendRecord[]; holds: HoldsSample[]; pool: PoolSample[]; metrics: PoolSample[]; closes: number[] };
export const emptyLog = (): ServerLog => ({ clock: [], sends: [], holds: [], pool: [], metrics: [], closes: [] });

const finite = (...values: unknown[]): boolean => values.every(v => typeof v === 'number' && Number.isFinite(v));

/** Reads one JSON log line received at harness time `at`; other lines are ignored. */
export function readLogLine(log: ServerLog, line: string, at: number) {
  let event: { target?: string; fields?: Record<string, unknown> };
  try { event = JSON.parse(line); } catch { return; }
  const f = event.fields ?? {};
  if (event.target === 'fukulow_revocation_measurement') {
    if (f.event === 'revocation_clock_sample' && finite(f.server_ms)) log.clock.push(f.server_ms as number);
    if (f.event === 'channel_access_revoked_sent' && typeof f.channel_id === 'string' && finite(f.before_ms, f.after_ms) && (f.before_ms as number) <= (f.after_ms as number)) {
      log.sends.push({ channelId: f.channel_id, beforeMs: f.before_ms as number, afterMs: f.after_ms as number, afterHold: typeof f.after_hold === 'boolean' ? f.after_hold : undefined });
    }
    if (f.event === 'revocation_holds_sample' && finite(f.server_ms, f.active_holds, f.high_water_mark, f.retry_attempts)) {
      log.holds.push({ serverMs: f.server_ms as number, activeHolds: f.active_holds as number, highWaterMark: f.high_water_mark as number, retryAttempts: f.retry_attempts as number });
    }
    return;
  }
  const numeric = Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  if (f.event === 'pool_stats') log.pool.push({ at, fields: numeric });
  if (f.event === 'metrics') log.metrics.push({ at, fields: numeric });
  if (f.event === 'websocket_closed') log.closes.push(at);
}
