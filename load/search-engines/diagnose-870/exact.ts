// Exact threshold comparisons for §4.2 and §5.3 (review round 6: every threshold fails closed). A double is
// a dyadic rational, so a product of p95s is an exact bigint fraction, and a G95 (a k-th root of that
// product) or a ratio of two G95s compares against a rational threshold by cross-multiplication. A sum of
// two roots (r - 1 >= 3 x (N - 1) with N a measured spread) has no such form; it is decided by rigorous
// interval bounds, and a comparison the bounds cannot decide returns null, which never passes a threshold.

export type Q = {n: bigint; d: bigint};
// (q)^(1/k), q > 0.
export type Root = {q: Q; k: bigint};

export function rational(x: number): Q {
  if (!Number.isFinite(x)) throw new Error(`not a finite number: ${x}`);
  let d = 1n;
  // Doubling a finite double is exact, and at most 1074 doublings make it an integer.
  while (!Number.isInteger(x)) { x *= 2; d *= 2n; }
  return {n: BigInt(x), d};
}
export const q = (n: number | bigint, d: number | bigint = 1): Q => ({n: BigInt(n), d: BigInt(d)});

// The G95 of positive p95s: (product)^(1/count).
export function geometric(values: number[]): Root {
  const p = values.map(rational).reduce((a, b) => ({n: a.n * b.n, d: a.d * b.d}), q(1));
  return {q: p, k: BigInt(values.length)};
}

// a / b as one root.
export function ratio(a: Root, b: Root): Root {
  if (a.k === b.k) return {q: {n: a.q.n * b.q.d, d: a.q.d * b.q.n}, k: a.k};
  const [x, y] = [{n: a.q.n ** b.k, d: a.q.d ** b.k}, {n: b.q.n ** a.k, d: b.q.d ** a.k}];
  return {q: {n: x.n * y.d, d: x.d * y.n}, k: a.k * b.k};
}

// The sign of root - c, exactly.
export function compare(r: Root, c: Q): -1 | 0 | 1 {
  if (c.n <= 0n) return 1;
  const [lhs, rhs] = [r.q.n * c.d ** r.k, c.n ** r.k * r.q.d];
  return lhs > rhs ? 1 : lhs < rhs ? -1 : 0;
}
export const atLeast = (r: Root, c: Q) => compare(r, c) >= 0;
export const below = (r: Root, c: Q) => compare(r, c) < 0;

const bitLength = (x: bigint) => x === 0n ? 0 : x.toString(2).length;

// floor(x^(1/k)) for x >= 0, by Newton's method from an estimate rounded up to at least the root.
export function floorRoot(x: bigint, k: bigint): bigint {
  if (x < 2n || k === 1n) return x;
  const bits = bitLength(x);
  const shift = Math.max(0, bits - 53);
  const log2 = Math.log2(Number(x >> BigInt(shift))) + shift;
  const e = Math.floor(log2 / Number(k)) - 52;
  const mantissa = BigInt(Math.ceil(2 ** (log2 / Number(k) - Math.floor(log2 / Number(k)) + 52) * (1 + 1e-9)) + 1);
  let r = e >= 0 ? mantissa << BigInt(e) : (mantissa >> BigInt(-e)) + 1n;
  while (r ** k <= x) r *= 2n;
  for (;;) {
    const next = ((k - 1n) * r + x / r ** (k - 1n)) / k;
    if (next >= r) break;
    r = next;
  }
  while (r ** k > x) r--;
  return r;
}

// Integer bounds lo <= root * 2^s <= hi, with hi = lo when the root is exact at this scale.
function scaled(r: Root, s: bigint) {
  const [num, den] = [r.q.n << (r.k * s), r.q.d];
  const lo = floorRoot(num / den, r.k);
  return {lo, hi: num % den === 0n && lo ** r.k === num / den ? lo : lo + 1n};
}

const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
// The root as a rational when it is one (both terms of the reduced fraction are perfect k-th powers).
export function exactRoot(r: Root): Q | null {
  const g = gcd(r.q.n, r.q.d);
  const [n, d] = [r.q.n / g, r.q.d / g];
  const [rn, rd] = [floorRoot(n, r.k), floorRoot(d, r.k)];
  return rn ** r.k === n && rd ** r.k === d ? {n: rn, d: rd} : null;
}

// Whether a + x >= b * y for roots x, y and rationals a, b >= 0: true or false when the bounds decide
// it, null when they cannot (as for an exact equality); null never passes a threshold.
export function sumAtLeast(x: Root, a: Q, b: Q, y: Root): boolean | null {
  const [ex, ey] = [exactRoot(x), exactRoot(y)];
  if (ex && ey) return (a.n * ex.d + ex.n * a.d) * b.d * ey.d >= b.n * ey.n * a.d * ex.d;
  for (let s = 64n; s <= 4096n; s *= 2n) {
    const [xs, ys] = [scaled(x, s), scaled(y, s)];
    const unit = a.d * b.d;
    const base = a.n * b.d << s;
    const lower = xs.lo * unit + base - b.n * a.d * ys.hi;
    const upper = xs.hi * unit + base - b.n * a.d * ys.lo;
    if (lower >= 0n) return true;
    if (upper < 0n) return false;
  }
  return null;
}

// Spearman's rho >= threshold, exactly, from integer-scaled ranks (ties averaged): with A = n Σxy - ΣxΣy
// and B, C the same for x and y, rho = A / sqrt(B C).
export function rhoAtLeast(rx: number[], ry: number[], threshold: Q): boolean {
  if (threshold.n <= 0n) throw new Error('rhoAtLeast takes a positive threshold');
  const [x, y] = [rx.map(v => BigInt(Math.round(v * 2))), ry.map(v => BigInt(Math.round(v * 2)))];
  const n = BigInt(x.length);
  const sum = (v: bigint[]) => v.reduce((s, z) => s + z, 0n);
  const dot = (u: bigint[], v: bigint[]) => u.reduce((s, z, i) => s + z * v[i], 0n);
  const [A, B, C] = [n * dot(x, y) - sum(x) * sum(y), n * dot(x, x) - sum(x) ** 2n, n * dot(y, y) - sum(y) ** 2n];
  // A / sqrt(BC) >= t > 0  <=>  A > 0 and A^2 d^2 >= t^2 B C.
  return B > 0n && C > 0n && A > 0n && A * A * threshold.d ** 2n >= threshold.n ** 2n * B * C;
}
