export const outcomes = ['accepted', 'rejected429', 'rejected503', 'otherErrors', 'clientTimeouts', 'transportErrors'] as const;
export type Outcome = typeof outcomes[number];
export type Lane = Record<Outcome, number> & {
  attempted: number;
  droppedIterations: number;
  p95: number | null;
  p99: number | null;
};

export function samples() {
  const counts = { accepted: 0, rejected429: 0, rejected503: 0, otherErrors: 0, clientTimeouts: 0, transportErrors: 0 };
  const times: number[] = [];
  return {
    add({ outcome, ms }: { outcome: Outcome; ms: number }) {
      counts[outcome]++;
      if (outcome === 'accepted') times.push(ms);
    },
    summarize(droppedIterations = 0): Lane {
      const sorted = [...times].sort((a, b) => a - b);
      const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1] ?? null;
      return { ...counts, attempted: Object.values(counts).reduce((sum, n) => sum + n, 0), droppedIterations,
        p95: percentile(0.95), p99: percentile(0.99) };
    },
  };
}
