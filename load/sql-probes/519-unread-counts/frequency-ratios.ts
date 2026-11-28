// Exact arithmetic for raw hardware rates and the legacy comparison.
export type Ratio = [bigint, bigint];
export type StoredRatio = [string, string];
export const keepFrequency: Ratio = [19n, 20n];
export const below = (a: Ratio, b: Ratio) => a[0] * b[1] < b[0] * a[1];
export const multiply = (a: Ratio, b: Ratio): Ratio => [a[0] * b[0], a[1] * b[1]];
export const store = (r: Ratio): StoredRatio => [String(r[0]), String(r[1])];
export const unsigned = (n: unknown): bigint => {
  if (typeof n !== 'string' || !/^(0|[1-9]\d*)$/.test(n) || n.length > 80) throw new Error('invalid unsigned integer');
  return BigInt(n);
};
export function restore(r: StoredRatio): Ratio {
  if (!Array.isArray(r) || r.length !== 2) throw new Error('invalid rate');
  const [n, d] = r.map(unsigned);
  if (n === 0n || d === 0n) throw new Error('nonpositive rate');
  return [n, d];
}

const sorted = (rs: Ratio[]) => [...rs].sort((a, b) => below(a, b) ? -1 : below(b, a) ? 1 : 0);
const mean = (lo: Ratio, hi: Ratio): Ratio => {
  return lo === hi ? lo : [lo[0] * hi[1] + hi[0] * lo[1], 2n * lo[1] * hi[1]];
};

export function medianRatio(rs: Ratio[]): Ratio {
  const s = sorted(rs);
  return mean(s[(s.length - 1) >> 1], s[s.length >> 1]);
}

export function medianBounds(votes: Ratio[], cohortSize: number) {
  const s = sorted(votes);
  const at = (offset: number) => {
    const lo = s[((cohortSize - 1) >> 1) - offset];
    const hi = s[(cohortSize >> 1) - offset];
    // A missing middle rank makes this bound open in its direction.
    return lo && hi ? mean(lo, hi) : null;
  };
  const lower = at(cohortSize - s.length);
  const upper = at(0);
  const verdict = upper && below(upper, keepFrequency) ? 'throttled'
    : lower && !below(lower, keepFrequency) ? 'clear' : 'invalid';
  return { lower: lower && store(lower), upper: upper && store(upper), verdict };
}
