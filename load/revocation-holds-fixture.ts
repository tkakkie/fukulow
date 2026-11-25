// Test fixture for #668 judgement: a clean H512 short run on a synthetic clock (offset ±1 ms).
// Server wall timestamps equal harness time here, with the same ±1 ms calibration.
import { channelsXor } from './revocation-holds-evidence.ts';
import { SOCKETS_PER_ACCOUNT, STALL_MESSAGES } from './revocation-holds-plan.ts';
import type { HoldsRun, HoldsSample, TargetSocket } from './revocation-holds-judgment.ts';
import { parseTrace } from './revocation-holds-trace.ts';

export const TIMES = { pass: 40_000, stall: 36_000, revoke: 37_000, resume: 40_100, end: 80_000 };
export const GATE_ON = 39_700, GATE_OFF = 43_500;
// A pool sample logged at harness time `at`, received `lag` ms later.
export const poolSample = (at: number, lag = 0) => ({ at: at + lag, wallMs: at, fields: { wait_count: 0, acquire_timeout: 0 } as Record<string, number> });
/** Sets the cumulative timeout counter to `n` on every pool sample logged at or after `from`. */
export const timeoutsFrom = (run: { pool: { wallMs: number | undefined; fields: Record<string, number> }[] }, from: number, n: number) => {
  for (const p of run.pool) if ((p.wallMs ?? -Infinity) >= from) p.fields.acquire_timeout = n;
};
export const channelId = (i: number) => `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`;
export const CHANNELS = Array.from({ length: 16 }, (_, i) => channelId(i));
export const memberId = (i: number) => `a0000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`;

export const traceLine = (event: string, fields: Record<string, unknown>) =>
  JSON.stringify({ target: 'fukulow_revocation_measurement', fields: { event, ...fields } });
export const watermarkLine = (n: number, overrides: Record<string, unknown> = {}) => traceLine('revocation_trace_watermark', {
  attempted: n, written: n, dropped: 0, timing_attempted: 1, timing_written: 1, timing_dropped: 0, ...overrides,
});
export function traceLines(run: HoldsRun) {
  const fault = run.kind === 'fault', n = run.revokedChannels.length, xor = channelsXor(run.revokedChannels);
  const snapshots = run.targets.map((t, i) => `${run.accounts[t.account].memberId}:${n}:${n}:${n}:${xor}:${i}`);
  const outcomes = run.targets.map((t, i) => {
    const member = run.accounts[t.account].memberId;
    return fault ? `${member}:${n}:0:0:0:0:0:${i}:40020` : `${member}:0:0:0:${n}:0:0:${i}:-`;
  });
  return [
    traceLine('revocation_fallback_snapshot', { trace_seq: 1, check_seq: 1, server_ms: 40_010, registrations: run.targets.length, records: snapshots.join(',') }),
    traceLine('revocation_fallback_outcome', { trace_seq: 2, check_seq: 1, server_ms: 40_025, records: outcomes.join(',') }),
    traceLine('revocation_fallback_check', { trace_seq: 3, check_seq: 1, started_ms: 40_005, finished_ms: 40_025,
      registrations: 1024 + run.targets.length, rows: 2048, chunks: 3, failed_chunks: fault ? 3 : 0 }),
    traceLine('subscription_fallback_pass', { trace_seq: 4, trace_dropped: 0, tick: 1, started_ms: 40_000,
      session_ms: 40_004, completed_ms: 40_029, outcome: fault ? 'error' : 'ok' }),
    traceLine('subscription_fallback_timing', { tick: 1, started_ms: 40_000, session_ms: 40_004,
      final_admission_ms: fault ? 40_024 : undefined, completed_ms: 40_030 }),
  ];
}
export const jsonl = (lines: string[]) => lines.join('\n') + '\n';

const retriesAt = (t: number) => t >= 41_800 ? 1536 : t >= 40_800 ? 1024 : t >= 40_300 ? 512 : 0;
export const sample = (serverMs: number, over: Partial<HoldsSample> = {}): HoldsSample => ({
  serverMs, activeHolds: serverMs >= 39_750 && serverMs < 44_000 ? 512 : 0,
  highWaterMark: serverMs >= 39_750 ? 512 : 0, retryAttempts: retriesAt(serverMs), ...over,
});

export const target = (socket: number): TargetSocket => ({
  account: Math.floor(socket / SOCKETS_PER_ACCOUNT), ready: true, subscribed: true,
  stall: { reads: [{ at: 1_000, bytes: 200 }, { at: 40_101, bytes: 64_000 }], pausedAt: [TIMES.stall], resumedAt: [TIMES.resume], closes: [] },
  stallMessages: Array.from({ length: STALL_MESSAGES }, (_, i) => ({ id: String(i), at: 40_150 + i })),
});

export function holdsFixture(kind: HoldsRun['kind'] = 'fault'): HoldsRun {
  const sockets = 32;
  const notices = Array.from({ length: sockets }, (_, socket) => CHANNELS.map((channelId, i) => ({ socket, channelId, at: 44_100 + i }))).flat();
  const probes = (ms: number) => Array.from({ length: 1600 }, (_, i) => ({ at: i * 50, ms, ok: true, status: 200 }));
  
  const run: HoldsRun = {
    kind, cell: 'H512', duration: kind === 'fault' ? 'short' : undefined, repeat: 1,
    times: { ...TIMES, gateOn: [GATE_ON, GATE_ON], gateOff: [GATE_OFF, GATE_OFF], nominalRecovery: { short: GATE_OFF } },
    setup: { bystanders: 1024, bystandersReadyAtStall: 1024, targetsReadyAtStall: sockets, calibrationErrors: [], stallPostFailures: 0 },
    serverCloses: [], wallOffsetBoundsMs: [-1, 1],
    revokedChannels: [...CHANNELS],
    accounts: [{ memberId: memberId(0), revokeStartedAt: 37_000, revokedAt: 37_100, revokeStatus: 200 }],
    targets: Array.from({ length: sockets }, (_, i) => target(i)),
    notices, bystanderNotices: 0, bystanderCloses: [],
    sendTiming: {
      offsetBoundsMs: [-1, 1], uncertaintyMs: 2,
      records: notices.map(n => ({ channelId: n.channelId, beforeMs: 44_000, afterMs: 44_002, afterHold: true })),
    },
    samples: Array.from({ length: 321 }, (_, i) => sample(i * 250)),
    statements: [], refused: [],
    dbProbe: probes(1), httpProbe: probes(5),
    // Each closing bracket is the sample after the first logged certainly after the window end:
    // 45_000 for the fault window (43_500), 81_000 for the recovery window (53_500).
    pool: [poolSample(0), poolSample(39_000), poolSample(44_000), poolSample(45_000), poolSample(80_000), poolSample(81_000)],
    rss: Array.from({ length: 160 }, (_, i) => ({ at: i * 500, kb: 1000 })),
    metrics: { revocation_held: 512, revocation_delivered_after_hold: 512, revocation_retired_timeout: 0, revocation_retired_retries: 0, revocation_retired_fenced: 0, revocation_retired_global_cap: 0, revocation_retired_registration_cap: 0 },
  };
  run.trace = parseTrace(jsonl([...traceLines(run), watermarkLine(4)]), true);
  return run;
}
