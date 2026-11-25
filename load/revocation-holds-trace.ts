// Reads the dedicated PR 1 trace sink and verifies the drain's accounting.
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

const TARGET = 'fukulow_revocation_measurement';
export const TRACE_EVENTS = ['subscription_fallback_pass', 'revocation_fallback_snapshot',
  'revocation_fallback_outcome', 'revocation_fallback_check'] as const;
type TraceName = typeof TRACE_EVENTS[number];
type Line = { seq: number; bytes: number; receivedAt?: number };
type Pass = Line & { name: typeof TRACE_EVENTS[0]; tick: number; started: number; session: number; completed: number; outcome: string; dropped: number };
type Snapshot = Line & { name: typeof TRACE_EVENTS[1]; check: number; at: number; registrations: number; records: string };
type Outcome = Line & { name: typeof TRACE_EVENTS[2]; check: number; at: number; records: string };
type Check = Line & { name: typeof TRACE_EVENTS[3]; check: number; started: number; finished: number; registrations: number; rows: number; chunks: number; failed: number };
type TraceEvent = Pass | Snapshot | Outcome | Check;
type Timing = { tick: number; started: number; session: number; admission?: number; completed: number };
type Counts = { attempted: number; written: number; dropped: number };
export type HoldsTrace = {
  events: TraceEvent[]; timing: Timing[];
  watermark?: { evidence: Counts; timing: Counts };
  evidenceErrors: string[]; timingErrors: string[];
};

function counters(fields: Record<string, unknown>, prefix: string): Counts {
  const { attempted, written, dropped } = Object.fromEntries(['attempted', 'written', 'dropped'].map(key => [key, count(fields[prefix + key])]));
  return { attempted, written, dropped };
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid timestamp');
  return value;
}

function count(value: unknown): number {
  const n = timestamp(value);
  if (!Number.isSafeInteger(n)) throw new Error('invalid count');
  return n;
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected a string');
  return value;
}

function parseLine(trace: HoldsTrace, line: string, receivedAt?: number) {
  const { target, fields: f } = JSON.parse(line) as { target: string; fields: Record<string, unknown> };
  if (target !== TARGET) throw new Error('wrong trace target');
  if (f.event === 'revocation_trace_watermark') {
    trace.watermark = { evidence: counters(f, ''), timing: counters(f, 'timing_') };
    return;
  }
  if (f.event === 'subscription_fallback_timing') {
    const timing = {
      tick: count(f.tick), started: timestamp(f.started_ms), session: timestamp(f.session_ms),
      admission: f.final_admission_ms == null ? undefined : timestamp(f.final_admission_ms),
      completed: timestamp(f.completed_ms),
    };
    if (timing.session < timing.started || (timing.admission ?? timing.session) < timing.session ||
      timing.completed < (timing.admission ?? timing.session)) throw new Error('unordered worker timing');
    trace.timing.push(timing);
    return;
  }
  const base = { seq: count(f.trace_seq), bytes: Buffer.byteLength(line) + 1, receivedAt };
  switch (f.event) {
    case 'subscription_fallback_pass':
      trace.events.push({ ...base, name: f.event, tick: count(f.tick), started: timestamp(f.started_ms),
        session: timestamp(f.session_ms), completed: timestamp(f.completed_ms), outcome: string(f.outcome), dropped: count(f.trace_dropped) });
      break;
    case 'revocation_fallback_snapshot':
      trace.events.push({ ...base, name: f.event, check: count(f.check_seq), at: timestamp(f.server_ms),
        registrations: count(f.registrations), records: string(f.records) });
      break;
    case 'revocation_fallback_outcome':
      trace.events.push({ ...base, name: f.event, check: count(f.check_seq), at: timestamp(f.server_ms), records: string(f.records) });
      break;
    case 'revocation_fallback_check':
      trace.events.push({ ...base, name: f.event, check: count(f.check_seq), started: timestamp(f.started_ms),
        finished: timestamp(f.finished_ms), registrations: count(f.registrations), rows: count(f.rows),
        chunks: count(f.chunks), failed: count(f.failed_chunks) });
      break;
    default: throw new Error('unknown trace event');
  }
}

function checkCounts(errors: string[], label: string, watermark: Counts, read: number) {
  if (watermark.attempted !== watermark.written + watermark.dropped) errors.push(`${label} watermark attempted != written + dropped`);
  if (watermark.dropped > 0) errors.push(`${label} watermark reports ${watermark.dropped} dropped lines`);
  if (watermark.written !== read) errors.push(`${label} watermark written ${watermark.written} != records read ${read}`);
}

export function parseTrace(content: string, graceful: boolean, arrivals: number[] = []): HoldsTrace {
  const trace: HoldsTrace = { events: [], timing: [], evidenceErrors: [], timingErrors: [] };
  const integrityErrors: string[] = [];
  if (!graceful) integrityErrors.push('server did not exit gracefully');
  const lines = content.split('\n');
  if (lines.pop() !== '') integrityErrors.push('incomplete final trace line');
  for (const [index, line] of lines.entries()) {
    try {
      if (trace.watermark) throw new Error('line after watermark');
      parseLine(trace, line, arrivals[index]);
    } catch {
      integrityErrors.push(`unreadable trace line ${index + 1}`);
    }
  }
  if (!trace.watermark) integrityErrors.push('missing or unreadable watermark');
  trace.evidenceErrors.push(...integrityErrors);
  trace.timingErrors.push(...integrityErrors);
  if (trace.watermark) {
    checkCounts(trace.evidenceErrors, 'S1–S4', trace.watermark.evidence, trace.events.length);
    checkCounts(trace.timingErrors, 'worker timing', trace.watermark.timing, trace.timing.length);
  }
  if (trace.events.some((event, i) => event.seq !== i + 1)) trace.evidenceErrors.push('trace_seq is not contiguous from 1');
  if (trace.events.some(event => event.name === 'subscription_fallback_pass' && event.dropped !== 0)) trace.evidenceErrors.push('S1 reports dropped trace lines');
  if (trace.timing.some((event, i) => event.tick !== i + 1)) trace.timingErrors.push('worker timing ticks are not contiguous from 1');
  return trace;
}

export function readTrace(path: string, graceful: boolean, arrivals?: number[]) {
  try {
    return parseTrace(readFileSync(path, 'utf8'), graceful, arrivals);
  } catch {
    const trace = parseTrace('', graceful);
    trace.evidenceErrors.push('trace file is unreadable');
    trace.timingErrors.push('trace file is unreadable');
    return trace;
  }
}

/** Used in the overhead runs only. A missed observation is reported as missing lag evidence. */
export function watchTrace(path: string, now = () => performance.now()) {
  const arrivals: number[] = [];
  let watcher: FSWatcher | undefined;
  const file = basename(path);
  try {
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename !== file && filename !== null) return;
      const at = now();
      try {
        const complete = readFileSync(path, 'utf8').split('\n').length - 1;
        while (arrivals.length < complete) arrivals.push(at);
      } catch { /* The sink may not have been created yet. */ }
    });
    watcher.on('error', () => watcher?.close());
  } catch { /* Completeness is checked by the final read. */ }
  return { arrivals, stop: () => watcher?.close() };
}
