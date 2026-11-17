import { createHash } from 'node:crypto';
export const roots = 25_000;
export const seed = 409;
export const readers = 4;
export const intervalMs = 25;
export const nominalRate = readers * 1000 / intervalMs;
export const scenarios = ['normal', 'long10000', 'long100000'] as const;
export type Scenario = typeof scenarios[number];
export const target = (s: Scenario) => s === 'normal' ? 50 : 200;
export const replies = (root: number) => root % 7;
const normalReplies = Array.from({ length: roots }, (_, i) => replies(i + 1)).reduce((a, b) => a + b, 0);
export function sizing(s: Scenario) {
  const longReplies = s === 'normal' ? 0 : s === 'long10000' ? 10_000 : 100_000;
  return { roots, normalReplies, normalMessages: roots + normalReplies, longReplies,
    messages: roots + normalReplies + (longReplies ? longReplies + 1 : 0) };
}
export const id = (seq: number) => {
  const h = createHash('md5').update(`fk409p:${seq}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export function batch(s: Scenario, sample: number) {
  const size = sizing(s), anchors: { message_id: string; root_id: string; reply_count: number }[] = [];
  // Coprime stride traverses all 25k roots; fixed seed and sample number are independent of completion order.
  for (let i = 0; i < (s === 'normal' ? 100 : 50); i++) {
    const r = ((seed + sample * 101 + i * 251) % roots) + 1;
    const previous = Math.floor((r - 1) / 7) * 21 + ((r - 1) % 7) * (((r - 1) % 7) + 1) / 2;
    const descendant = i % 4 === 0 && replies(r) > 0;
    anchors.push({ message_id: id(descendant ? roots + previous + replies(r) : r), root_id: id(r), reply_count: replies(r) });
  }
  if (size.longReplies) {
    const root = size.normalMessages + 1;
    for (let i = 0; i < 50; i++) anchors.push({ message_id: id(root + (i === 0 ? 0 : 1 + ((sample * 97 + i * 193) % size.longReplies))), root_id: id(root), reply_count: size.longReplies });
  }
  return anchors.sort((a, b) => a.message_id.localeCompare(b.message_id));
}
export function stats(values: number[]) {
  if (!values.length || values.some(n => !Number.isFinite(n) || n < 0)) throw new Error('invalid latency samples');
  const sorted = [...values].sort((a, b) => a - b);
  const p = (fraction: number) => sorted[Math.ceil(fraction * sorted.length) - 1];
  return { n: values.length, p50: p(.5), p95: p(.95), p99: p(.99), max: sorted.at(-1)! };
}
export type Run = { scenario: Scenario; repeat: number; errors: number; warmupErrors: number; latencies: number[]; firstMs: number; seconds: number };
export function judgement(s: Scenario, runs: Run[], formal: boolean, complete: boolean) {
  const rows = runs.filter(r => r.scenario === s);
  if (rows.some(r => r.errors || r.warmupErrors || (r.latencies.length && stats(r.latencies).p95 > target(s)))) return 'FAIL';
  if (!formal || !complete || rows.length !== 3 || new Set(rows.map(r => r.repeat)).size !== 3 || rows.some(r => r.latencies.length !== 10_000 || !Number.isFinite(r.seconds) || r.seconds <= 0 || r.latencies.length / r.seconds < .95 * nominalRate)) return 'NOT EVALUATED';
  return 'PASS';
}
export function ranges(runs: Run[]) {
  return Object.fromEntries((['p50', 'p95', 'p99', 'max'] as const).map(key => {
    const values = runs.filter(r => r.latencies.length).map(r => stats(r.latencies)[key]);
    return [key, values.length ? [Math.min(...values), Math.max(...values)] : null];
  }));
}
