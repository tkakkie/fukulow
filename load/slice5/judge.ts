// Pure judgement for the approved #515 slice 5 pre-registration. Only PASS is a
// pass: INVALID, NOT EVALUATED, REPORT ONLY and INVESTIGATE never are.
import { commits, partA, partB, partC, rounds, thresholds, validity, type Arm } from './config.ts';

export type Status = 'PASS' | 'FAIL' | 'INVALID' | 'NOT EVALUATED' | 'REPORT ONLY' | 'INVESTIGATE';
export type Counts = { attempted: number; accepted: number; rejected429: number; rejected503: number; otherErrors: number;
  clientTimeouts: number; transportErrors: number; droppedIterations: number; p95: number | null };
export type Evidence = { samples: number; maxSampleGapMs: number; samplingErrors: number };
export type Wal = { lsnBytes: number; checkpointsInside: number; autovacuumInside: string[]; statsReset: boolean };
export type Cost = { walBytes: number; ms: number };
export type RunIdentity = { cell: string; round: number; arm: Arm; commit: string; image: string; settingsHash: string;
  fixtureChecksum: string; complete: boolean; smoke: boolean };
export type StepA = { rate: number; seconds: number; send: Counts; retry: Counts; reader: Counts; evidence: Evidence; wal: Wal;
  vacuumAfter: Cost; checkpointAfter: Cost & { buffersWritten: number } };
export type RunA = RunIdentity & { part: 'A'; steps: StepA[]; storage: { bytes: number; accepted: number } };
export type RunB = RunIdentity & { part: 'B'; acceptedPerSecond: number; measured: Counts; nonSuccess: number;
  hostCpuMeanPercent: number; evidence: Evidence };
export type RunC = RunIdentity & { part: 'C'; p95: number | null; requests: number; invalidPages: number; readerErrors: number; outsideSender: number; r2?: { status: string; invalid?: number; errors?: number; p95?: number | null };
  sender: Counts; senderRate: number; senderSeconds: number; evidence: Evidence };
export type TimelineRow = { key: string; p95: number; n: number };
export type RunD = { part: 'D'; round: number; arm: Arm; commit: string; complete: boolean; smoke: boolean; topics: number; rows: TimelineRow[]; exitCode?: number };
export type Metric = { name: string; status: Status; reason?: string; medianB?: number; medianA?: number; ratio?: number;
  pairRatios?: number[]; spreadB?: number; spreadA?: number };
export type Verdict = { part: string; cell: string; status: Status; reasons: string[]; metrics: Metric[]; detail?: unknown };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
export const spread = (v: number[]) => (Math.max(...v) - Math.min(...v)) / median(v);
const order: Status[] = ['FAIL', 'INVESTIGATE', 'INVALID', 'NOT EVALUATED', 'REPORT ONLY', 'PASS'];
export const worst = (s: Status[]) => order.find(o => s.includes(o)) ?? 'NOT EVALUATED';

// One value per round and arm, ordered by round. `ok` receives median(A)/median(B).
export function compare(name: string, b: number[], a: number[], ok: (ratio: number, medianA: number) => boolean): Metric {
  if (b.length !== rounds.length || a.length !== rounds.length || ![...b, ...a].every(finite) || [...b, ...a].some(v => v < 0))
    return { name, status: 'INVALID', reason: 'missing or non-finite value' };
  const medianB = median(b), medianA = median(a);
  if (!(medianB > 0) || !(medianA > 0)) return { name, status: 'INVALID', reason: 'zero median' };
  const spreadB = spread(b), spreadA = spread(a), ratio = medianA / medianB;
  const pairRatios = a.map((v, i) => v / b[i]);
  const base = { name, medianB, medianA, ratio, pairRatios, spreadB, spreadA };
  // A spread failure is never rerun to pass and never a PASS (Q5).
  if (spreadB > thresholds.spread || spreadA > thresholds.spread) return { ...base, status: 'INVALID', reason: 'spread above 10%' };
  return { ...base, status: ok(ratio, medianA) ? 'PASS' : 'FAIL' };
}

const countsComplete = (c: Counts) => [c.attempted, c.accepted, c.rejected429, c.rejected503, c.otherErrors, c.clientTimeouts,
  c.transportErrors, c.droppedIterations].every(n => Number.isInteger(n) && n >= 0) &&
  c.attempted === c.accepted + c.rejected429 + c.rejected503 + c.otherErrors + c.clientTimeouts + c.transportErrors;
export const evidenceComplete = (e: Evidence) => Number.isInteger(e.samples) && e.samples > 0 && e.samplingErrors === 0 &&
  finite(e.maxSampleGapMs) && e.maxSampleGapMs >= 0 && e.maxSampleGapMs <= validity.maxSampleGapMs;

export function stepIncomplete(step: StepA): string[] {
  const reasons: string[] = [];
  if (!countsComplete(step.send)) reasons.push('incomplete outcomes');
  if (step.send.accepted && !(finite(step.send.p95) && step.send.p95 >= 0)) reasons.push('missing latency');
  if (!evidenceComplete(step.evidence)) reasons.push('incomplete 1 s resource evidence');
  if (!countsComplete(step.reader)) reasons.push('incomplete second-Organization reader outcomes');
  return reasons;
}
function stepFailures(step: StepA): string[] {
  const reasons: string[] = [], s = step.send, reader = step.reader;
  // Incomplete counts cannot establish a failure; independent complete lanes can.
  if (countsComplete(s)) {
    if (s.droppedIterations) reasons.push('dropped iterations');
    if (s.attempted < step.rate * step.seconds * validity.minimumOfferedFraction || s.attempted > step.rate * step.seconds + 1) reasons.push('offered load not generated');
    if (s.accepted !== s.attempted) reasons.push('errors');
  }
  const readerOffered = 2 * (step.seconds + partA.drainSeconds);
  if (countsComplete(reader) && (reader.droppedIterations || reader.accepted !== reader.attempted || reader.attempted < readerOffered * validity.minimumOfferedFraction || reader.attempted > readerOffered + 1))
    reasons.push('second-Organization reader not sustained');
  // The identical-retry lane is explicitly report-only.
  return reasons;
}
export function sustainable(step: StepA): string[] {
  return [...stepIncomplete(step), ...stepFailures(step)];
}
const stepOutcome = (step: StepA) => stepFailures(step).length ? 'definitely-unsustained'
  : stepIncomplete(step).length ? 'unknown' : 'sustained';
export function walInvalid(wal: Wal): string[] {
  const reasons: string[] = [];
  if (!finite(wal.lsnBytes) || wal.lsnBytes <= 0) reasons.push('missing LSN delta');
  if (wal.checkpointsInside !== 0) reasons.push('checkpoint inside the step');
  if (wal.autovacuumInside.length) reasons.push(`autovacuum/autoanalyze inside the step (${wal.autovacuumInside.join(', ')})`);
  if (wal.statsReset) reasons.push('statistics reset');
  return reasons;
}

// Mismatched settings, commits, images or fixtures, or a missing or extra run, make the cell INVALID.
export function consistency<T extends RunIdentity>(runs: T[], cell: string): { b: T[]; a: T[]; reasons: string[] } {
  const reasons: string[] = [];
  const pick = (arm: Arm) => rounds.map((_, i) => runs.filter(r => r.cell === cell && r.arm === arm && r.round === i + 1));
  const [bs, as] = [pick('B'), pick('A')];
  if ([...bs, ...as].some(r => r.length !== 1)) return { b: [], a: [], reasons: ['missing or duplicate run'] };
  const b = bs.map(r => r[0]), a = as.map(r => r[0]), all = [...b, ...a];
  if (all.length !== runs.filter(r => r.cell === cell).length) reasons.push('unexpected run');
  if (all.some(r => r.smoke)) reasons.push('smoke run');
  if (all.some(r => !r.complete)) reasons.push('incomplete run');
  if (all.some(r => !r.commit.startsWith(commits[r.arm]))) reasons.push('commit mismatch');
  if (new Set(b.map(r => r.image)).size !== 1 || new Set(a.map(r => r.image)).size !== 1) reasons.push('image mismatch');
  if (new Set(all.map(r => r.settingsHash)).size !== 1) reasons.push('settings mismatch');
  if (new Set(all.map(r => r.fixtureChecksum)).size !== 1) reasons.push('fixture checksum mismatch');
  return { b, a, reasons };
}

const ratioAtMost = (limit: number) => (ratio: number) => ratio <= limit;
const ratioAtLeast = (limit: number) => (ratio: number) => ratio >= limit;

export function judgePartA(runs: RunA[], cell: string): Verdict {
  const { b, a, reasons } = consistency(runs, cell);
  if (reasons.length) return { part: 'A', cell, status: 'INVALID', reasons, metrics: [] };
  const step = (r: RunA, rate: number) => r.steps.filter(s => s.rate === rate);
  if ([...b, ...a].some(r => partA.rates.some(rate => step(r, rate).length !== 1) || r.steps.length !== partA.rates.length))
    return { part: 'A', cell, status: 'INVALID', reasons: ['missing or duplicate step'], metrics: [] };
  const at = (r: RunA, rate: number) => step(r, rate)[0];
  // B sustains a step in every round but A misses it in any round: FAIL (no rerun to pass).
  const steps = partA.rates.map(rate => {
    const bOutcomes = b.map(r => stepOutcome(at(r, rate))), aOutcomes = a.map(r => stepOutcome(at(r, rate)));
    const status: Status | 'COMMON' = bOutcomes.includes('definitely-unsustained') ? 'REPORT ONLY'
      : bOutcomes.includes('unknown') ? 'INVALID'
      : aOutcomes.includes('definitely-unsustained') ? 'FAIL'
      : aOutcomes.includes('unknown') ? 'INVALID' : 'COMMON';
    return { rate, status, b: b.map(r => sustainable(at(r, rate))), a: a.map(r => sustainable(at(r, rate))) };
  });
  const failed = steps.filter(s => s.status === 'FAIL').map(s => s.rate);
  const common = steps.filter(s => s.status === 'COMMON').map(s => s.rate);
  const metrics: Metric[] = [];
  const out: string[] = failed.map(r => `B sustains ${r}/s but A does not`);
  if (!common.length) {
    out.push('no common sustainable step');
    return { part: 'A', cell, status: failed.length ? 'FAIL' : steps.some(s => s.status === 'INVALID') ? 'INVALID' : 'NOT EVALUATED', reasons: out, metrics, detail: { steps } };
  }
  const rate = Math.max(...common);
  const values = (f: (r: RunA) => number) => [b.map(f), a.map(f)] as const;
  metrics.push(compare(`send p95 at ${rate}/s`, ...values(r => at(r, rate).send.p95 ?? NaN), ratioAtMost(thresholds.sendP95Ratio)));
  metrics.push(compare(`accepted/s at ${rate}/s`, ...values(r => at(r, rate).send.accepted / at(r, rate).seconds), ratioAtLeast(thresholds.acceptedRatio)));
  const walReasons = [...b, ...a].flatMap(r => walInvalid(at(r, rate).wal).map(x => `${r.arm}${r.round}: ${x}`));
  metrics.push(walReasons.length ? { name: `creation WAL/op at ${rate}/s`, status: 'INVALID', reason: walReasons.join('; ') }
    : compare(`creation WAL/op at ${rate}/s`, ...values(r => at(r, rate).wal.lsnBytes / at(r, rate).send.accepted), ratioAtMost(thresholds.walPerOpRatio)));
  metrics.push(compare('storage/Message', ...values(r => r.storage.bytes / r.storage.accepted), ratioAtMost(thresholds.storagePerMessageRatio)));
  const status = worst([...metrics.map(m => m.status), ...(failed.length ? ['FAIL' as Status] : []), ...(steps.some(s => s.status === 'INVALID' && s.rate >= rate) ? ['INVALID' as Status] : [])]);
  return { part: 'A', cell, status, reasons: out, metrics, detail: { highestCommonSustainableRate: rate, steps } };
}

// Q3: report-only. Never part of the send gate; a large A/B ratio asks the maintainer.
export function vacuumCost(runs: RunA[], cell: string) {
  const { b, a, reasons } = consistency(runs, cell);
  if (reasons.length) return { cell, status: 'NOT EVALUATED' as const, reasons };
  if ([...b, ...a].some(r => r.steps.length !== partA.rates.length || r.steps.some(s => !finite(s.vacuumAfter.walBytes) || s.vacuumAfter.walBytes < 0 || !finite(s.vacuumAfter.ms) || s.vacuumAfter.ms <= 0)))
    return { cell, status: 'NOT EVALUATED' as const, reasons: ['missing explicit-VACUUM evidence'] };
  const total = (r: RunA, k: 'walBytes' | 'ms') => r.steps.reduce((sum, s) => sum + s.vacuumAfter[k], 0);
  const perSend = (r: RunA) => total(r, 'walBytes') / r.storage.accepted;
  const wal = compare('explicit VACUUM WAL per accepted send', b.map(perSend), a.map(perSend), () => true);
  const ms = compare('explicit VACUUM duration', b.map(r => total(r, 'ms')), a.map(r => total(r, 'ms')), () => true);
  const checkpoint = compare('explicit CHECKPOINT buffers written', b.map(r => r.steps.reduce((s, x) => s + x.checkpointAfter.buffersWritten, 0)),
    a.map(r => r.steps.reduce((s, x) => s + x.checkpointAfter.buffersWritten, 0)), () => true);
  if ([wal, ms].some(m => m.status === 'INVALID')) return { cell, status: 'NOT EVALUATED' as const, reasons: ['missing or invalid explicit-VACUUM evidence'], metrics: [wal, ms, checkpoint] };
  const decision = [wal, ms].some(m => (m.ratio ?? 0) > thresholds.vacuumDecisionRatio);
  return { cell, status: decision ? 'NEEDS DECISION' as const : 'REPORT ONLY' as const, metrics: [wal, ms, checkpoint] };
}

// Validate every closed-loop lane/window before reducing; missing evidence or an
// unexpected shape must not cancel errors in another window.
export function closedLoopNonSuccess(lanes: Record<string, Record<string, Counts>>): number {
  if (Object.keys(lanes).sort().join() !== 'reader,send') return NaN;
  let errors = 0;
  for (const lane of Object.values(lanes)) {
    if (Object.keys(lane).sort().join() !== 'after,measured,warmup') return NaN;
    for (const c of Object.values(lane)) {
      if (!countsComplete(c) || c.droppedIterations !== 0) return NaN;
      errors += c.attempted - c.accepted;
    }
  }
  return errors;
}

export function judgePartB(runs: RunB[], cell: string): Verdict {
  const { b, a, reasons } = consistency(runs, cell);
  if (reasons.length) return { part: 'B', cell, status: 'INVALID', reasons, metrics: [] };
  const all = [...b, ...a];
  const out: string[] = [];
  if (all.some(r => !countsComplete(r.measured) || !evidenceComplete(r.evidence) || !finite(r.hostCpuMeanPercent) || r.measured.droppedIterations !== 0)) out.push('incomplete evidence');
  if (all.some(r => r.nonSuccess !== 0 || r.measured.accepted !== r.measured.attempted)) out.push('non-2xx response');
  if (out.length) return { part: 'B', cell, status: 'INVALID', reasons: out, metrics: [] };
  const saturated = (r: RunB) => r.hostCpuMeanPercent >= partB.hostSaturationPercent;
  // Q8: A saturating where B does not is a candidate-specific regression to investigate.
  if (a.some(saturated) && !b.some(saturated)) return { part: 'B', cell, status: 'INVESTIGATE', reasons: ['only A reached host saturation'], metrics: [] };
  if (all.some(saturated)) return { part: 'B', cell, status: 'NOT EVALUATED', reasons: ['host saturation'], metrics: [] };
  const metric = compare('maximum accepted/s', b.map(r => r.acceptedPerSecond), a.map(r => r.acceptedPerSecond), ratioAtLeast(thresholds.maxAcceptedRatio));
  return { part: 'B', cell, status: metric.status, reasons: [], metrics: [metric] };
}

export function judgePartC(runs: RunC[], cell: string): Verdict {
  const { b, a, reasons } = consistency(runs, cell);
  if (reasons.length) return { part: 'C', cell, status: 'INVALID', reasons, metrics: [] };
  const out: string[] = [];
  for (const r of [...b, ...a]) {
    const who = `${r.arm}${r.round}`;
    if (r.requests !== partC.readers * partC.requests) out.push(`${who}: request count`);
    if (r.invalidPages !== 0) out.push(`${who}: ${r.invalidPages} pages without 50 consecutive positions`);
    if (r.outsideSender !== 0) out.push(`${who}: reader outside sender window or missing evidence`);
    if (r.readerErrors !== 0) out.push(`${who}: reader errors`);
    const s = r.sender;
    if (!countsComplete(s) || s.droppedIterations || s.accepted !== s.attempted || s.attempted < r.senderRate * r.senderSeconds * validity.minimumOfferedFraction)
      out.push(`${who}: concurrent sender not sustained`);
    if (!evidenceComplete(r.evidence)) out.push(`${who}: incomplete evidence`);
  }
  if (out.length) return { part: 'C', cell, status: 'INVALID', reasons: out, metrics: [] };
  const p95 = (r: RunC) => r.p95 ?? NaN;
  const metric = compare('R1 gap-fill p95', b.map(p95), a.map(p95),
    (ratio, medianA) => ratio <= thresholds.replayP95Ratio && medianA <= thresholds.replayP95LimitMs);
  return { part: 'C', cell, status: metric.status, reasons: [], metrics: [metric] };
}

// Part D keeps the existing absolute target: A's median p95 <=100 ms per PAGE row, both arms' spread <=10%.
export function judgePartD(runs: RunD[]): Verdict[] {
  const failed = runs.filter(r => r.exitCode !== undefined && r.exitCode !== 0);
  if (failed.length) return [{ part: 'D', cell: 'timeline', status: 'FAIL',
    reasons: failed.map(r => `${r.arm}${r.round}: Part D test failed (exit ${r.exitCode})`), metrics: [] }];
  const pick = (arm: Arm) => rounds.map((_, i) => runs.filter(r => r.arm === arm && r.round === i + 1));
  const [bs, as] = [pick('B'), pick('A')];
  if ([...bs, ...as].some(r => r.length !== 1) || runs.length !== 2 * rounds.length)
    return [{ part: 'D', cell: 'timeline', status: 'INVALID', reasons: ['missing or duplicate run'], metrics: [] }];
  const b = bs.map(r => r[0]), a = as.map(r => r[0]), all = [...b, ...a];
  const reasons = [...(all.some(r => r.smoke) ? ['smoke run'] : []), ...(all.some(r => !r.complete) ? ['incomplete run'] : []),
    ...(all.some(r => r.topics !== 10000) ? ['formal topic fixture mismatch'] : []),
    ...(all.some(r => !r.commit.startsWith(commits[r.arm])) ? ['commit mismatch'] : [])];
  const keys = ['PAGE boundary=None', 'PAGE boundary=Some(190000)', 'SEND boundary=None', 'SEND boundary=Some(190000)'];
  if (all.some(r => r.rows.length !== keys.length || keys.some(k => r.rows.filter(x => x.key === k).length !== 1)))
    reasons.push('missing or duplicate timeline row');
  if (reasons.length) return [{ part: 'D', cell: 'timeline', status: 'INVALID', reasons, metrics: [] }];
  return keys.map(key => {
    const value = (r: RunD) => r.rows.find(x => x.key === key)!.p95;
    const av = a.map(value), bv = b.map(value);
    const invalidSamples = all.some(r => {
      const row = r.rows.find(x => x.key === key)!;
      return key.startsWith('PAGE ') ? row.n !== 400 : !Number.isInteger(row.n) || row.n <= 0;
    });
    if (![...av, ...bv].every(v => finite(v) && v > 0) || invalidSamples)
      return { part: 'D', cell: key, status: 'INVALID' as Status, reasons: ['invalid p95 or sample count'], metrics: [] };
    const metric: Metric = { name: 'timeline p95 (absolute)', medianA: median(av), medianB: median(bv), spreadA: spread(av), spreadB: spread(bv),
      ratio: median(av) / median(bv), pairRatios: av.map((v, i) => v / bv[i]), status: 'PASS' };
    // Only PAGE rows carry the target; the concurrent SEND rows are report-only.
    metric.status = !key.startsWith('PAGE ') ? 'REPORT ONLY' : (metric.spreadA! > thresholds.spread || metric.spreadB! > thresholds.spread) ? 'INVALID'
      : metric.medianA! <= thresholds.timelineP95LimitMs ? 'PASS' : 'FAIL';
    if (metric.status === 'INVALID') metric.reason = 'spread above 10%';
    return { part: 'D', cell: key, status: metric.status, reasons: [], metrics: [metric] };
  });
}

export const parseTimeline = (log: string): TimelineRow[] => [...log.matchAll(/^TOPIC_(?!DATA)(\w+) boundary=(\S+) n=(\d+) p50_ms=[\d.]+ p95_ms=([\d.]+) max_ms=[\d.]+$/gm)]
  .map(m => ({ key: `${m[1]} boundary=${m[2]}`, p95: Number(m[4]), n: Number(m[3]) }));

export const timelineTopics = (log: string) => {
  const rows = [...log.matchAll(/^TOPIC_DATA topics=(\d+)\b/gm)];
  return rows.length === 1 ? Number(rows[0][1]) : NaN;
};
