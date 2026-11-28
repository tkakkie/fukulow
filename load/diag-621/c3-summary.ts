import { planVersion, scheduleReason, warmSeconds, type Window } from './c3-plan.ts';
import { statementReasons, type statementEvidence } from './c3-statements.ts';

export const metrics = ['dbCpuUsec', 'appCpuUsec', 'executorUsec', 'latencyP50Usec', 'latencyP95Usec', 'walBytes', 'walRecords', 'walFpi'] as const;
type Metric = typeof metrics[number];
export type WindowResult = { window: Window; reasons: string[]; late?: boolean; metrics?: Record<Metric, number>;
  statements?: ReturnType<typeof statementEvidence> };

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
export function pairedInterval(deltas: number[]) {
  if (deltas.length !== 12 || !deltas.every(Number.isFinite)) throw new Error('paired interval needs 12 finite deltas');
  const center = mean(deltas), sorted = [...deltas].sort((left, right) => left - right);
  const sd = Math.sqrt(deltas.reduce((sum, value) => sum + (value - center) ** 2, 0) / 11);
  const half = 2.200985160082949 * sd / Math.sqrt(12);
  return { mean: center, lower: center - half, upper: center + half, median: (sorted[5] + sorted[6]) / 2, df: 11 };
}

export function reading(intervals: { upper: number; lower: number }[], meaningful: number) {
  if (intervals.length !== 2) throw new Error('reading needs both shapes');
  if (intervals.every(interval => interval.upper <= -meaningful)) return 'shown';
  if (intervals.every(interval => interval.lower > -meaningful)) return 'not shown';
  return 'inconclusive';
}

const comparisons = [['c3', 'split'], ['split', 'base'], ['c3', 'base']] as const;
const shapes = ['many-17', 'hot-17'] as const;

function effect(rows: WindowResult[], metric: Metric) {
  const residuals = [1, 2, 3].map(position => mean(rows.filter(row => row.window.position === position).map(row =>
    row.metrics![metric] - mean(rows.filter(peer => peer.window.arm === row.window.arm).map(peer => peer.metrics![metric])))));
  return { residualsByPosition: residuals, range: Math.max(...residuals) - Math.min(...residuals) };
}

export function summarizeC3(smoke: boolean, evidence: WindowResult[], problems: string[]) {
  const order = scheduleReason(smoke, evidence.map(row => row.window));
  const reasons = [...problems, ...(order ? [order] : [])];
  const windows = evidence.map(row => ({ ...row, reasons: [...row.reasons] }));
  for (const row of windows) {
    if (!row.metrics || !metrics.every(metric => Number.isFinite(row.metrics?.[metric]) && row.metrics![metric] >= 0)) row.reasons.push('window metrics missing or malformed');
    if (typeof row.late !== 'boolean') row.reasons.push('late-backend evidence missing');
    if (row.late) row.reasons.push('late app backend');
    if (!row.statements) row.reasons.push('statement evidence missing');
    else if (row.window.arm === 'base') row.reasons.push(...statementReasons('base', row.statements));
  }
  for (const row of windows.filter(row => row.window.arm !== 'base')) {
    const bases = windows.filter(candidate => candidate.window.arm === 'base' && candidate.window.shape === row.window.shape
      && candidate.window.round === row.window.round && !candidate.reasons.length);
    const base = bases.length === 1 ? bases[0].statements : undefined;
    if (row.statements) row.reasons.push(...statementReasons(row.window.arm, row.statements, base));
    else if (!base) row.reasons.push('same-shape, same-round base is missing or INVALID');
  }
  const valid = !reasons.length && windows.every(row => !row.reasons.length);
  const result = { planVersion, smoke, warmSeconds, valid, reasons, windows: windows.map(row => ({ ...row, valid: !row.reasons.length })) };
  if (!valid || smoke) return result;
  const pairs = shapes.flatMap(shape => comparisons.flatMap(([candidate, baseline]) => metrics.map(metric => {
    const rows = windows.filter(row => row.window.shape === shape);
    const deltas = rows.filter(row => row.window.arm === candidate).map(row => ({ round: row.window.round,
      delta: row.metrics![metric] - rows.find(peer => peer.window.arm === baseline && peer.window.round === row.window.round)!.metrics![metric] }));
    return { shape, candidate, baseline, metric, deltas, ...pairedInterval(deltas.map(row => row.delta)) };
  })));
  const primary = (metric: Metric, meaningful: number) => ({ meaningful, reading: reading(
    pairs.filter(row => row.candidate === 'c3' && row.baseline === 'split' && row.metric === metric), meaningful) });
  return { ...result, pairs, orderPosition: shapes.flatMap(shape => metrics.map(metric => ({ shape, metric,
    ...effect(windows.filter(row => row.window.shape === shape), metric) }))),
  primary: { dbCpuUsec: primary('dbCpuUsec', 20), latencyP50Usec: primary('latencyP50Usec', 30) },
  limits: ['Prepared-statement warmth is not measured.', 'SQL await time inside the app is not measured.',
    'Exploratory attribution on Docker; no capacity or formal-gate inference.', 'Automatic maintenance is disabled on send relations.',
    'The pool is pre-grown to 20 backends; measurements cover warm steady state.',
    'Attribution reports the last query of each late backend still connected at the after-drain read.'] };
}

export function c3ExitCode(result: { valid: boolean }) { return result.valid ? 0 : 1; }
