import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Sample } from './summary.ts';

// #351 light k6 profile. Extend the publishing window to fit the fresh acquisitions.
export const trafficProfile = (smoke: boolean) => ({
  CHANNELS: '1', SUBSCRIBERS: '5', PUBLISHERS: '2', PUBLISH_MEMBERS: '8',
  PUBLISH_INTERVAL_MS: '250', DURATION_SECONDS: smoke ? '8' : '120',
});

export async function waitForTraffic(log: string, done: Promise<number | null>, signal: AbortSignal) {
  let finished = false;
  void done.then(() => { finished = true; });
  while (!finished) {
    signal.throwIfAborted();
    if (readFileSync(log, 'utf8').split('\n').includes('LOAD_MEASUREMENT_START')) {
      await sleep(2_000, undefined, { signal });
      if (!finished) return;
      break;
    }
    await sleep(100, undefined, { signal });
  }
  throw new Error('k6 ended before loaded sampling. See traffic.log');
}

export function verifyTraffic(log: string, rows: readonly Sample[], profile: ReturnType<typeof trafficProfile>) {
  const lines = readFileSync(log, 'utf8').split('\n');
  const rateLine = lines.find(line => line.startsWith('LOAD_RATE '));
  if (!rateLine || !lines.some(line => line.startsWith('LOAD_SUMMARY '))) throw new Error('Missing k6 traffic records');
  const rate: { offered: number; accepted: number; firstOfferedAt: number; lastOfferedAt: number } = JSON.parse(rateLine.slice('LOAD_RATE '.length));
  const expected = Number(profile.DURATION_SECONDS) * Number(profile.PUBLISHERS) * 1_000 / Number(profile.PUBLISH_INTERVAL_MS);
  if (rate.offered !== expected || rate.accepted !== expected ||
      !Number.isSafeInteger(rate.firstOfferedAt) || !Number.isSafeInteger(rate.lastOfferedAt) ||
      rows.length === 0 || rows.some(row => row.startedMs < rate.firstOfferedAt || row.finishedMs > rate.lastOfferedAt)) {
    throw new Error('Loaded samples must fit inside a complete k6 publishing window');
  }
  return { offered: rate.offered, accepted: rate.accepted, firstOfferedAt: rate.firstOfferedAt, lastOfferedAt: rate.lastOfferedAt };
}
