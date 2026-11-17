// #515 slice 5 pre-registration, approved by the maintainer on 2026-11-17
// (issue #515, comments 6947860789 and 6948478872). Every value here is fixed
// before any run; changing one after a result is a new pre-registration.
export const scope = '#515 slice 5: whole B..A diff, attributed to #515 only on send, replay and timeline; Mac-relative only, never a production-default pass, separate from #431';
export const commits = { B: 'b975ffa', A: 'f7fe08a' } as const;
export type Arm = keyof typeof commits;
export const rounds = [['B', 'A'], ['A', 'B'], ['B', 'A']] as const satisfies readonly (readonly [Arm, Arm])[];

export const fixture = { members: 4000, channels: 200, otherOrganizationReaderRate: 2,
  partAMessages: 1_000_000, perChannel: 5000, shortBody: 'Load test message', longScalars: 4000,
  replayChannels: [{ name: '1M', messages: 1_000_000 }, { name: '100k', messages: 100_000 }] } as const;
// Same 4,000-scalar / 16,000-byte body as #160: astral CJK scalars, not compressible repetition.
export const longBody = (hash: (n: number) => number) =>
  Array.from({ length: fixture.longScalars }, (_, n) => String.fromCodePoint(0x20000 + hash(n))).join('');

// Q2: control conditions for a Mac-relative comparison only (same in both arms).
export const dbSettings = { max_wal_size: '8GB', checkpoint_timeout: '30min' } as const;
export const insertAutovacuumOff = ['messages', 'channel_log'] as const;

export const partA = { rates: [250, 500, 1000], seconds: 60, drainSeconds: 11, idleSeconds: 5,
  cells: [{ name: 'hot-17', channels: 1, body: 'short' }, { name: 'hot-16000', channels: 1, body: 'long' },
    { name: 'many-17', channels: 200, body: 'short' }, { name: 'many-16000', channels: 200, body: 'long' }],
  retryRate: 5, retryTargets: 50, sendBurst: 10, sendRefillPerSecond: 1 } as const;
export const partB = { vus: 128, warmupSeconds: 30, seconds: 60,
  cells: ['hot-17', 'many-17', 'hot-16000', 'many-16000'], sendBurst: 1_000_000, sendRefillPerSecond: 1_000_000,
  hostSaturationPercent: 90 } as const;
export const partC = { readers: 4, warmups: 10, requests: 250, limit: 50, senderRate: 20,
  cells: ['1M-recent', '1M-deep', '100k-recent', '100k-deep'], recentWindow: 1000 } as const;
export const partD = { target: 'measure_topic_projection_pages', p95LimitMs: 100 } as const;

export const thresholds = {
  sendP95Ratio: 1.10, acceptedRatio: 0.90, walPerOpRatio: 1.15, storagePerMessageRatio: 1.25,
  maxAcceptedRatio: 0.90, replayP95Ratio: 1.10, replayP95LimitMs: 100, timelineP95LimitMs: 100,
  spread: 0.10,
  // Q3: report-only; above this A/B ratio the explicit-VACUUM cost goes to the maintainer.
  vacuumDecisionRatio: 1.25,
} as const;
export const validity = { minimumOfferedFraction: 0.95, maxSampleGapMs: 2500 } as const;
export const nights = { 1: { parts: ['A'], hardTimeoutMinutes: 210 }, 2: { parts: ['B', 'C', 'D'], hardTimeoutMinutes: 210 } } as const;
