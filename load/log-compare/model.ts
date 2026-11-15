export type Arm = 'baseline' | 'events-ids' | 'events-snapshot' | 'log-ids' | 'log-snapshot';
export const arms: Arm[] = ['baseline', 'events-ids', 'events-snapshot', 'log-ids', 'log-snapshot'];
export const organization = '00000000-0000-0000-0000-000000000001';
export const sender = '00000000-0000-0000-0000-000000000002';
export const snapshot = (arm: Arm) => arm.endsWith('snapshot');
export const logTable = (arm: Arm) => arm.startsWith('events') ? 'channel_events' : 'channel_log';
export interface Entry { position: number; id: string; version: number; deleted: boolean; body: string }
export function reduce(entries: Entry[], start = 0) {
  const state = new Map<string, Entry>();
  let cursor = start;
  for (const entry of entries) {
    if (entry.position !== cursor + 1) throw new Error('missing/out-of-order position');
    const previous = state.get(entry.id);
    if (previous?.deleted && (!entry.deleted || entry.body !== '')) throw new Error('resurrected body');
    if (entry.deleted && entry.body !== '') throw new Error('resurrected body');
    if (!previous || entry.version >= previous.version) state.set(entry.id, entry);
    cursor = entry.position;
  }
  return { cursor, state };
}
export interface Conditions {
  scenario: string; rate: number; seconds: number; clients: number;
  seed: number; image: string; config: string; machine: string;
}
export interface Sample {
  arm: Arm; round: number; conditions: Conditions; offered: number; accepted: number;
  errors: number; dropped: number; late: number; elapsed: number;
  p50: number; p95: number; p99: number; tps: number;
  walPerOp: number; heapPerOp: number; indexPerOp: number;
  correctness: { missing: number; resurrected: number; retryPositions: number };
}
export const spreadLimit = 0.10;
const median = (values: number[]) => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
export function gates(samples: Sample[], creation: boolean) {
  const reasons: string[] = [];
  if (!samples.length) reasons.push('no samples');
  const conditions = JSON.stringify(samples[0]?.conditions);
  for (const sample of samples) {
    if (JSON.stringify(sample.conditions) !== conditions) reasons.push('mismatched conditions');
    if (sample.errors || sample.dropped || sample.late || sample.accepted !== sample.offered || !sample.accepted
      || sample.elapsed > sample.conditions.seconds * 1.01) reasons.push('dropped work, errors or unsustainable load');
    if (Object.values(sample.correctness).some(n => n !== 0)) reasons.push('correctness');
    if ([sample.p50,sample.p95,sample.p99,sample.tps,sample.walPerOp,sample.heapPerOp,sample.indexPerOp]
      .some(n => !Number.isFinite(n) || n < 0)) reasons.push('invalid metrics');
  }
  const summary = Object.fromEntries(arms.map(arm => {
    const rows = samples.filter(s => s.arm === arm);
    if (rows.length < 3 || new Set(rows.map(r => r.round)).size !== rows.length) reasons.push(`${arm}: need three distinct rounds`);
    const metrics = Object.fromEntries(['tps','p95','walPerOp','heapPerOp','indexPerOp','storagePerOp'].map(key => {
      const values = rows.map(r => key==='storagePerOp' ? r.heapPerOp+r.indexPerOp : r[key as 'tps']);
      const m = median(values);
      const spread = m === 0 ? (Math.max(...values) === 0 ? 0 : Infinity) : (Math.max(...values)-Math.min(...values))/m;
      if (spread > spreadLimit) reasons.push(`${arm}: ${key} spread over ${spreadLimit}`);
      return [key, { median: m, min: Math.min(...values), max: Math.max(...values), spread }];
    }));
    return [arm, metrics];
  }));
  const regressions: string[] = [];
  const baseline = summary.baseline;
  for (const arm of arms.slice(1)) {
    const s = summary[arm];
    if (s.tps.median < baseline.tps.median * 0.9) regressions.push(`${arm}: throughput >10% regression`);
    if (s.p95.median > baseline.p95.median * 1.1) regressions.push(`${arm}: p95 >10% regression`);
    if (creation && s.walPerOp.median > baseline.walPerOp.median * 2) regressions.push(`${arm}: creation WAL >2x`);
    if (creation && s.storagePerOp.median > 2 * baseline.storagePerOp.median) regressions.push(`${arm}: creation storage >2x`);
  }
  return { label: 'MAC-RELATIVE', absoluteBudgets: 'NOT EVALUATED (#431)',
    valid: reasons.length === 0, pass: reasons.length === 0 && regressions.length === 0,
    reasons: [...new Set(reasons)], regressions, summary };
}
export function alternating(round: number): Arm[] {
  return round % 2 === 0 ? [...arms] : [...arms].reverse();
}
export function repetition(values:number[], minimum=3) {
  const m=median(values);
  const spread=m===0 ? (values.every(v=>v===0)?0:Infinity) : (Math.max(...values)-Math.min(...values))/m;
  return {count:values.length,median:m,min:Math.min(...values),max:Math.max(...values),spread,
    valid:values.length>=minimum && values.every(v=>Number.isFinite(v)&&v>=0) && spread<=spreadLimit};
}
