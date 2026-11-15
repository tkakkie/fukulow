import { createHash } from 'node:crypto';
export const scenarioMix=(name:string):number[]=>name.startsWith('mixed90')?[90,5,3,2]:name.startsWith('mixed50')?[50,20,20,10]:[100,0,0,0];
export function arrivalSchedule(rate:number,seconds:number,seed:number,mix:number[]) {
  let rng=seed>>>0;
  const random=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return (rng+.5)/4294967296;};
  const operations:{at:number;op:number;n:number}[]=[]; const counts=[0,0,0,0];
  for(let at=-Math.log(random())/rate;rate>0 && at<seconds;at+=-Math.log(random())/rate) {
    const ticket=random()*100;let op=0,total=mix[0];while(op<3 && ticket>=total) total+=mix[++op];
    operations.push({at:at*1000,op,n:operations.length+1});counts[op]++;
  }
  return {operations,mix:counts,hash:createHash('sha256').update(JSON.stringify(operations)).digest('hex')};
}
export type Arm = 'baseline' | 'events-ids' | 'events-snapshot' | 'log-ids' | 'log-snapshot';
export const arms: Arm[] = ['baseline', 'events-ids', 'events-snapshot', 'log-ids', 'log-snapshot'];
export const organization = '00000000-0000-0000-0000-000000000001';
export const sender = '00000000-0000-0000-0000-000000000002';
export const snapshot = (arm: Arm) => arm.endsWith('snapshot');
export const logTable = (arm: Arm) => arm.startsWith('events') ? 'channel_events' : 'channel_log';
export interface Entry { position: number; id: string; version: number; deleted: boolean; body: string }
export function reduce(entries: Entry[], start = 0, prior = new Map<string, Entry>()) {
  const state = new Map(prior);
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
  schedule: { count:number; hash:string; mix:number[] }; offeredMix:number[]; missingOffers:number;
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
    const scheduled=arrivalSchedule(sample.conditions.rate,sample.conditions.seconds,sample.conditions.seed,
      scenarioMix(sample.conditions.scenario));
    if(sample.conditions.rate>0 && (sample.schedule.hash!==scheduled.hash || sample.schedule.count!==scheduled.operations.length
      || sample.offered!==scheduled.operations.length || sample.missingOffers!==0
      || JSON.stringify(sample.offeredMix)!==JSON.stringify(scheduled.mix)
      || sample.accepted+sample.errors+sample.dropped+sample.missingOffers!==sample.schedule.count)) reasons.push('schedule omission or unmatched actual offers/mix');
    const paired=samples.find(s=>s.round===sample.round && s.arm==='baseline');
    if(paired && (sample.offered!==paired.offered || JSON.stringify(sample.offeredMix)!==JSON.stringify(paired.offeredMix)
      || sample.schedule.hash!==paired.schedule.hash)) reasons.push('unmatched paired offers/mix');
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

export const correct=(rows:{correctness:Sample['correctness']}[])=>rows.length>0 && rows.every(r=>Object.values(r.correctness).every(n=>n===0));
export const sustainable=(rows:Sample[])=>correct(rows) && rows.every(r=>!r.errors&&!r.dropped&&!r.late&&!r.missingOffers&&r.accepted===r.offered&&r.accepted>0&&r.elapsed<=r.conditions.seconds*1.01);
export function coverage(expected:Entry[],actual:Entry[]) {
  const identity=(e:Entry)=>JSON.stringify(e);
  return expected.length===actual.length && expected.every((e,i)=>identity(e)===identity(actual[i]));
}

export function sameOperations(actual:string[],expected:string[]) {
  return JSON.stringify([...actual].sort())===JSON.stringify([...expected].sort());
}
