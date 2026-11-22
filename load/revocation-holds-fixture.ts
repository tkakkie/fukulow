// Test fixture for #668 judgement: a clean H512 short run on a synthetic clock (offset ±1 ms).
import { SOCKETS_PER_ACCOUNT } from './revocation-holds-plan.ts';
import type { HoldsRun, HoldsSample, TargetSocket } from './revocation-holds-judgment.ts';

export const TIMES = { pass: 40_000, stall: 36_000, revoke: 37_000, fault: 39_700, resume: 40_100, recovery: 43_500, end: 80_000 };
export const CHANNELS = Array.from({ length: 16 }, (_, i) => `c${i}`);

const retriesAt = (t: number) => t >= 41_800 ? 1536 : t >= 40_800 ? 1024 : t >= 40_300 ? 512 : 0;
export const sample = (serverMs: number, over: Partial<HoldsSample> = {}): HoldsSample => ({
  serverMs, activeHolds: serverMs >= 39_750 && serverMs < 44_000 ? 512 : 0,
  highWaterMark: serverMs >= 39_750 ? 512 : 0, retryAttempts: retriesAt(serverMs), ...over,
});

export const target = (socket: number): TargetSocket => ({
  account: Math.floor(socket / SOCKETS_PER_ACCOUNT), ready: true, subscribed: true,
  stall: { reads: [{ at: 1_000, bytes: 200 }, { at: 40_101, bytes: 64_000 }], pausedAt: [TIMES.stall], resumedAt: [TIMES.resume], closes: [] },
  stallMessagesAt: [40_150],
});

export function holdsFixture(): HoldsRun {
  const sockets = 32;
  const notices = Array.from({ length: sockets }, (_, socket) => CHANNELS.map((channelId, i) => ({ socket, channelId, at: 44_100 + i }))).flat();
  const probes = (ms: number) => Array.from({ length: 1600 }, (_, i) => ({ at: i * 50, ms, ok: true, status: 200 }));
  const poolSample = (at: number) => ({ at, fields: { wait_count: 0, acquire_timeout: 0 } });
  return {
    kind: 'fault', cell: 'H512', duration: 'short', repeat: 1,
    times: { ...TIMES, nominalRecovery: { short: TIMES.recovery } },
    setup: { bystanders: 1024, bystandersReady: 1024, calibrationErrors: [], stallPostFailures: 0 },
    revokedChannels: [...CHANNELS],
    accounts: [{ revokeStartedAt: 37_000, revokedAt: 37_100, revokeStatus: 200 }],
    targets: Array.from({ length: sockets }, (_, i) => target(i)),
    notices, bystanderNotices: 0, bystanderCloses: 0,
    sendTiming: {
      offsetBoundsMs: [-1, 1], uncertaintyMs: 2,
      records: notices.map(n => ({ channelId: n.channelId, beforeMs: 44_000, afterMs: 44_002, afterHold: true })),
    },
    samples: Array.from({ length: 321 }, (_, i) => sample(i * 250)),
    statements: [], refused: [],
    dbProbe: probes(1), httpProbe: probes(5),
    pool: [poolSample(0), poolSample(39_000), poolSample(44_000), poolSample(80_000)],
    rss: Array.from({ length: 160 }, (_, i) => ({ at: i * 500, kb: 1000 })),
    metrics: { revocation_held: 512, revocation_delivered_after_hold: 512, revocation_retired_timeout: 0, revocation_retired_retries: 0, revocation_retired_fenced: 0, revocation_retired_global_cap: 0, revocation_retired_registration_cap: 0 },
  };
}
