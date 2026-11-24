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

export function medianRatio(rs: Ratio[]): Ratio {
  const s = [...rs].sort((a, b) => below(a, b) ? -1 : below(b, a) ? 1 : 0);
  const lo = s[(s.length - 1) >> 1];
  const hi = s[s.length >> 1];
  return lo === hi ? lo : [lo[0] * hi[1] + hi[0] * lo[1], 2n * lo[1] * hi[1]];
}
