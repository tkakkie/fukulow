// #621 C1/C2 diagnostic summary (diagnosis only, no PASS/FAIL). Ported from the 2026-11-23 summarize.py.
// FPI, WAL, DB CPU and executor time are separate metric families. Each gets per-window values, medians
// per arm with their spread, paired-delta medians (candidate - base in the same phase, shape and round)
// with their spread, and an order-position effect estimate, next to per-arm and paired load accounting
// (accepted sends, errors, dropped iterations). INVALID windows are listed and never paired. The position
// effect is reported only for a complete balanced square of valid windows (never for smoke).
// Usage: node load/diag-621/summary.ts <output-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { balanced, windows, type Window } from './plan.ts';
import { decide, topLevel, type Result, type Statement } from './validity.ts';

export type { Result, Statement } from './validity.ts';

export const FAMILIES = {
  executor: ['exec_us_per_send', 'sql_per_send'],
  db_cpu: ['db_cpu_us_per_send'],
  wal: ['wal_bytes_per_send', 'stmt_wal_records_per_send', 'stmt_wal_bytes_per_send', 'stat_wal_records_per_send', 'stat_wal_bytes_per_send'],
  fpi: ['stmt_wal_fpi_per_send', 'stat_wal_fpi_per_send'],
} as const;
export const METRICS = [...Object.values(FAMILIES).flat(), 'log_heap_bytes', 'log_index_bytes'];
// Load accounting: two arms can reconcile their k6 counts while delivering different amounts of load.
export const LOAD = ['accepted', 'errors', 'dropped', 'warm_accepted'] as const;
const STATEMENT_METRICS = ['calls', 'exec_us_per_send', 'wal_records_per_send', 'wal_bytes_per_send', 'wal_fpi_per_send'];

export type Manifest = { smoke: boolean; windows: Window[]; c2Compatibility?: { cases: number; mismatches: number } };
type Row = Record<string, string | number | boolean | null>;
type Tables = Record<string, Row[]>;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
};
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const perSend = (value: number, accepted: number) => accepted ? value / accepted : null;
const nums = (rows: Row[], metric: string) => rows.map(r => r[metric]).filter((v): v is number => typeof v === 'number');
const groupBy = (rows: Row[], keys: string[]) => {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const k = JSON.stringify(keys.map(key => r[key]));
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return [...out.values()];
};
const pick = (r: Row, keys: string[]) => Object.fromEntries(keys.map(k => [k, r[k]]));

// One row per group: n plus median, min and max of each metric (the per-window spread).
function spread(rows: Row[], keys: string[], metrics: readonly string[]): Row[] {
  return groupBy(rows, keys).map(g => {
    const row: Row = { ...pick(g[0], keys), n: g.length };
    for (const m of metrics) {
      const v = nums(g, m);
      Object.assign(row, { [m]: median(v), [`${m}_min`]: v.length ? Math.min(...v) : null, [`${m}_max`]: v.length ? Math.max(...v) : null });
    }
    return row;
  });
}

// candidate - base within one phase, shape and round (and statement, when given).
function pairs(rows: Row[], keys: string[], metrics: readonly string[]): Row[] {
  const out: Row[] = [];
  for (const g of groupBy(rows, keys)) {
    const base = g.find(r => r.arm === 'base');
    if (!base) continue;
    for (const c of g) if (c.arm !== 'base') out.push({ ...pick(c, keys), baseline: 'base', candidate: c.arm, ...Object.fromEntries(metrics.map(m =>
      [m, typeof c[m] === 'number' && typeof base[m] === 'number' ? (c[m] as number) - (base[m] as number) : null])) });
  }
  return out;
}

// Balanced order: each arm takes each position equally often, so the mean residual (value minus that
// arm's mean in the phase and shape) at a position estimates the order-position effect. That holds only for
// a complete square: with a window missing, round drift leaks into it, so it is suppressed (null, with a note).
function positionEffects(rows: Row[], metrics: readonly string[], suppressed: (phase: unknown, shape: unknown) => string | null): Row[] {
  const out: Row[] = [];
  for (const g of groupBy(rows, ['phase', 'shape'])) for (const m of metrics) {
    const note = suppressed(g[0].phase, g[0].shape);
    if (note) { out.push({ phase: g[0].phase, shape: g[0].shape, metric: m, range: null, note }); continue; }
    const armMean = new Map(groupBy(g, ['arm']).map(a => [a[0].arm, mean(nums(a, m))]));
    const positions = Math.max(...g.map(r => r.positions as number));
    const effects = Array.from({ length: positions }, (_, p) => mean(g.filter(r => r.position === p + 1 && typeof r[m] === 'number')
      .map(r => (r[m] as number) - (armMean.get(r.arm) as number))));
    const known = effects.filter((e): e is number => e !== null);
    out.push({ phase: g[0].phase, shape: g[0].shape, metric: m, ...Object.fromEntries(effects.map((e, p) => [`position_${p + 1}`, e])),
      range: known.length ? Math.max(...known) - Math.min(...known) : null, note: null });
  }
  return out;
}

export function analyze(manifest: Manifest, read: (w: Window) => { result: Result; statements: Statement[] } | null) {
  const problems: string[] = [];
  const plan = windows(manifest.smoke);
  if (JSON.stringify(manifest.windows) !== JSON.stringify(plan)) problems.push('recorded window order differs from the plan');
  if (!manifest.smoke && !balanced(manifest.windows)) problems.push('arm order is not balanced');
  if (manifest.c2Compatibility?.cases !== 1400 || manifest.c2Compatibility.mismatches !== 0) problems.push('C2 compatibility record missing');
  const rows: Row[] = [], statements: Row[] = [], invalid: { id: string; reasons: string[] }[] = [];
  for (const w of manifest.windows) {
    const read1 = read(w);
    const tags: Row = { id: w.id, phase: w.phase, shape: w.shape, round: w.round, arm: w.arm, position: w.position, positions: w.order.length, order: w.order.join('>') };
    if (!read1) { invalid.push({ id: w.id, reasons: ['window missing'] }); continue; }
    const { result: r, statements: stats } = read1;
    const m = r.measured, top = topLevel(stats);
    // The same decision run.ts recorded in result.json and the manifest; re-applied, never relaxed.
    const { valid, reasons } = decide(r, stats);
    if (!valid) invalid.push({ id: w.id, reasons });
    const cp = r.checkpoint;
    const row: Row = { ...tags, valid, reasons: reasons.join('; '), checkpoint_started_at: cp?.startedAt ?? null, checkpoint_ms: cp?.ms ?? null,
      checkpoint_redo_lsn: cp?.ok ? cp.after.redo : null };
    if (m && r.verification) {
      const a = m.accepted, sum = (f: (s: Statement) => number) => top.reduce((t, s) => t + f(s), 0);
      Object.assign(row, { accepted: a, errors: m.load.errors, dropped: m.load.dropped, warm_accepted: r.warmup?.accepted ?? null,
        exec_us_per_send: perSend(1000 * sum(s => s.total_exec_time), a), sql_per_send: perSend(sum(s => s.calls), a),
        db_cpu_us_per_send: perSend(m.cpuUsec, a),
        wal_bytes_per_send: perSend(m.walBytes, a),
        stmt_wal_records_per_send: perSend(sum(s => s.wal_records), a), stmt_wal_bytes_per_send: perSend(sum(s => Number(s.wal_bytes)), a),
        stat_wal_records_per_send: perSend(m.statWal.records, a), stat_wal_bytes_per_send: perSend(m.statWal.bytes, a),
        stmt_wal_fpi_per_send: perSend(sum(s => s.wal_fpi), a), stat_wal_fpi_per_send: perSend(m.statWal.fpi, a),
        log_heap_bytes: r.verification.shapeAfter.heap_bytes, log_index_bytes: r.verification.shapeAfter.index_bytes,
        stat_deallocations: m.statementInfo.dealloc });
      if (valid) {
        const byQuery = new Map<string, Statement[]>();
        for (const s of stats) byQuery.set(JSON.stringify([s.toplevel, s.query]), [...(byQuery.get(JSON.stringify([s.toplevel, s.query])) ?? []), s]);
        for (const entries of byQuery.values()) {
          const total = (f: (s: Statement) => number) => entries.reduce((t, s) => t + f(s), 0);
          statements.push({ ...tags, toplevel: entries[0].toplevel, query: entries[0].query, queryids: entries.map(s => String(s.queryid)).sort().join(' '),
            calls: total(s => s.calls), exec_us_per_send: perSend(1000 * total(s => s.total_exec_time), a),
            wal_records_per_send: perSend(total(s => s.wal_records), a), wal_bytes_per_send: perSend(total(s => Number(s.wal_bytes)), a),
            wal_fpi_per_send: perSend(total(s => s.wal_fpi), a) });
        }
      }
    }
    rows.push(row);
  }
  const good = rows.filter(r => r.valid);
  const arm = ['phase', 'shape', 'arm'], window = ['phase', 'shape', 'round'], stmt = ['toplevel', 'query'];
  const deltas = pairs(good, window, METRICS);
  const loadDeltas = pairs(good, window, LOAD);
  const validIds = new Set(rows.filter(r => r.valid).map(r => r.id));
  const suppressed = (phase: unknown, shape: unknown) => {
    if (manifest.smoke) return 'suppressed: smoke run (not a complete square)';
    const square = plan.filter(w => w.phase === phase && w.shape === shape);
    return square.every(w => validIds.has(w.id)) && balanced(square) ? null : 'suppressed: not a complete balanced square of valid windows';
  };
  const statementDeltas = pairs(statements, [...window, ...stmt], STATEMENT_METRICS);
  const tables: Tables = {
    windows: rows,
    medians: spread(good, arm, METRICS),
    'paired-deltas': deltas,
    'paired-medians': spread(deltas, ['phase', 'shape', 'baseline', 'candidate'], METRICS),
    'position-effects': positionEffects(good, METRICS, suppressed),
    'load-medians': spread(good, arm, LOAD),
    'load-paired-deltas': loadDeltas,
    'load-paired-medians': spread(loadDeltas, ['phase', 'shape', 'baseline', 'candidate'], LOAD),
    statements,
    'statement-medians': spread(statements, [...arm, ...stmt], STATEMENT_METRICS),
    'statement-paired-medians': spread(statementDeltas, ['phase', 'shape', 'baseline', 'candidate', ...stmt], STATEMENT_METRICS),
  };
  const ok = problems.length === 0 && invalid.length === 0;
  return { ok, problems, invalid, tables, markdown: markdown(manifest, rows, tables, problems, invalid) };
}

const fmt = (v: unknown) => v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v);
const cell = (v: unknown) => fmt(v).replace(/\|/g, '\\|');
function table(columns: string[], rows: Row[], value = (r: Row, c: string) => cell(r[c])) {
  return [`| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`, ...rows.map(r => `| ${columns.map(c => value(r, c)).join(' | ')} |`)].join('\n');
}
const ranged = (r: Row, c: string) => r[`${c}_min`] === undefined ? cell(r[c]) : `${fmt(r[c])} [${fmt(r[`${c}_min`])}, ${fmt(r[`${c}_max`])}]`;

function markdown(manifest: Manifest, rows: Row[], t: Tables, problems: string[], invalid: { id: string; reasons: string[] }[]) {
  const out = ['# #621 C1/C2 diagnostic (diagnosis only, no PASS/FAIL)', '',
    `Valid windows: ${rows.filter(r => r.valid).length}/${manifest.windows.length}. Values are medians [min, max] over windows.`, ''];
  if (problems.length) out.push('## Run problems', '', ...problems.map(p => `- ${p}`), '');
  if (invalid.length) out.push('## INVALID windows', '', ...invalid.map(i => `- ${i.id}: ${i.reasons.join('; ')}`), '');
  const rounds = groupBy(manifest.windows as unknown as Row[], ['phase', 'round']).map(g => ({ phase: g[0].phase, round: g[0].round,
    shapes: [...new Set(g.map(w => w.shape))].join(' then '), order: (g[0].order as unknown as string[]).join(' > ') }));
  out.push('## Arm order per round', '', table(['phase', 'round', 'shapes', 'order'], rounds), '');
  out.push('## Checkpoint before each window', '', table(['phase', 'shape', 'arm', 'n', 'checkpoint_ms'], spread(rows.filter(r => r.checkpoint_ms !== null),
    ['phase', 'shape', 'arm'], ['checkpoint_ms']), ranged), '');
  for (const [family, metrics] of Object.entries(FAMILIES)) {
    out.push(`## ${family}`, '', '### Per arm', '', table(['phase', 'shape', 'arm', 'n', ...metrics], t.medians, ranged), '',
      '### Paired-delta medians (candidate - base)', '', table(['phase', 'shape', 'candidate', 'n', ...metrics], t['paired-medians'], ranged), '',
      '### Order-position effect (mean residual by position; only for a complete balanced square of valid windows)', '');
    const effects = t['position-effects'].filter(r => (metrics as readonly string[]).includes(r.metric as string));
    const positions = Math.max(0, ...effects.flatMap(r => Object.keys(r).filter(k => k.startsWith('position_')).map(k => Number(k.slice(9)))));
    out.push(table(['phase', 'shape', 'metric', ...Array.from({ length: positions }, (_, p) => `position_${p + 1}`), 'range', 'note'], effects), '');
  }
  out.push('## load accounting', '', '### Per arm', '', table(['phase', 'shape', 'arm', 'n', ...LOAD], t['load-medians'], ranged), '',
    '### Paired-delta medians (candidate - base)', '', table(['phase', 'shape', 'candidate', 'n', ...LOAD], t['load-paired-medians'], ranged), '');
  return out.join('\n');
}

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows: Row[]) => {
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))];
  return [columns.join(','), ...rows.map(r => columns.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
};

export function summarize(dir: string): boolean {
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as Manifest;
  const { ok, problems, invalid, tables, markdown: md } = analyze(manifest, w => {
    const json = (name: string) => { try { return JSON.parse(readFileSync(resolve(dir, w.id, name), 'utf8')); } catch { return null; } };
    const result = json('result.json') as Result | null;
    // An INVALID window has no statement snapshot.
    return result && { result, statements: (json('pg_stat_statements.json') ?? []) as Statement[] };
  });
  const out = resolve(dir, 'summary');
  mkdirSync(out, { recursive: true });
  for (const [name, rows] of Object.entries(tables)) writeFileSync(resolve(out, `${name}.csv`), csv(rows));
  writeFileSync(resolve(out, 'results.md'), md + '\n');
  console.log(`Valid ${manifest.windows.length - invalid.length}/${manifest.windows.length} windows`);
  for (const p of problems) console.log('Run problem:', p);
  for (const i of invalid) console.log('INVALID', i.id, i.reasons.join('; '));
  return ok;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: summary.ts <output-dir>');
  process.exitCode = summarize(dir) ? 0 : 1;
}
