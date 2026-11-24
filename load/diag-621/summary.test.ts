import assert from 'node:assert/strict';
import test from 'node:test';
import { windows, type Window } from './plan.ts';
import { analyze, FAMILIES, METRICS, type Manifest, type Result, type Statement } from './summary.ts';

const accepted = 2000;
type Values = { execUs: number; calls: number; cpuUs: number; walBytes: number; stmtWal: number; stmtFpi: number; statFpi: number; statWal: number };
const armValues = (arm: string): Values => ({ execUs: 100 + (arm === 'base' ? 0 : 10), calls: 26, cpuUs: 900 + (arm === 'base' ? 0 : 50),
  walBytes: 1700 + (arm === 'base' ? 0 : 200), stmtWal: 1600, stmtFpi: arm === 'base' ? 0 : 0.03, statFpi: arm === 'base' ? 0.01 : 0.05, statWal: 1650 });

function fixture(w: Window, v: Values, o: Partial<Result> = {}): { result: Result; statements: Statement[] } {
  const load = { accepted, attempts: accepted, iterations: accepted, errors: 0, dropped: 0 };
  return {
    result: { id: w.id, valid: true, reasons: [], checkpoint: { ok: true, startedAt: 's', ms: 40 + w.position, before: {} as never, after: { redo: '0/1' } as never },
      warmup: { ...load, accepted: 750, attempts: 750, iterations: 750 },
      measured: { accepted, load, cpuUsec: v.cpuUs * accepted, walBytes: v.walBytes * accepted,
        statWal: { records: 16 * accepted, fpi: v.statFpi * accepted, bytes: v.statWal * accepted }, statementInfo: { dealloc: 0 } },
      verification: { verified: true, shapeAfter: { heap_bytes: 8192, index_bytes: 4096 } }, ...o },
    statements: [
      { toplevel: true, queryid: 1, calls: v.calls * accepted, total_exec_time: v.execUs * accepted / 1000, wal_records: 15 * accepted,
        wal_bytes: String(v.stmtWal * accepted), wal_fpi: v.stmtFpi * accepted, query: 'INSERT INTO messages' },
      { toplevel: true, queryid: 2, calls: accepted, total_exec_time: 999, wal_records: 0, wal_bytes: '0', wal_fpi: 0, query: 'SELECT 1' },
    ],
  };
}
const manifest = (smoke = false): Manifest => ({ smoke, windows: windows(smoke), c2Compatibility: { cases: 1400, mismatches: 0 } });

test('FPI, WAL, DB CPU and executor time are separate families with separate per-window columns and sections', () => {
  const all = Object.values(FAMILIES).flat();
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(Object.keys(FAMILIES), ['executor', 'db_cpu', 'wal', 'fpi']);
  const r = analyze(manifest(), w => fixture(w, armValues(w.arm)));
  assert.equal(r.ok, true);
  const fkc = r.tables.windows.find(x => x.arm === 'fkc')!;
  assert.equal(fkc.exec_us_per_send, 110);
  assert.equal(fkc.sql_per_send, 26);
  assert.equal(fkc.db_cpu_us_per_send, 950);
  assert.equal(fkc.wal_bytes_per_send, 1900);
  assert.equal(fkc.stmt_wal_bytes_per_send, 1600);
  assert.equal(fkc.stat_wal_bytes_per_send, 1650);
  assert.equal(fkc.stmt_wal_fpi_per_send, 0.03);
  assert.equal(fkc.stat_wal_fpi_per_send, 0.05);
  for (const family of ['executor', 'db_cpu', 'wal', 'fpi']) assert.match(r.markdown, new RegExp(`^## ${family}$`, 'm'));
  for (const m of METRICS) assert.ok(m in fkc, m);
});

test('paired-delta medians are candidate - base within phase, shape and round, with their spread', () => {
  const r = analyze(manifest(), w => fixture(w, { ...armValues(w.arm), cpuUs: armValues(w.arm).cpuUs + (w.arm === 'fk2' ? w.round : 0) }));
  const fk2 = r.tables['paired-medians'].find(x => x.phase === 'C1' && x.shape === 'many-17' && x.candidate === 'fk2')!;
  assert.equal(fk2.n, 5);
  assert.equal(fk2.exec_us_per_send, 10);
  assert.equal(fk2.db_cpu_us_per_send, 53);
  assert.equal(fk2.db_cpu_us_per_send_min, 51);
  assert.equal(fk2.db_cpu_us_per_send_max, 55);
  assert.equal(fk2.stmt_wal_fpi_per_send, 0.03);
  assert.equal(r.tables['paired-medians'].filter(x => x.phase === 'C2').length, 2);
});

test('the order-position effect is estimated from the balanced design', () => {
  // +4 µs DB CPU at position 1 whatever the arm; arm effects must not leak into the position estimate.
  const r = analyze(manifest(), w => fixture(w, { ...armValues(w.arm), cpuUs: armValues(w.arm).cpuUs + (w.position === 1 ? 4 : 0) }));
  const e = r.tables['position-effects'].find(x => x.phase === 'C1' && x.shape === 'hot-17' && x.metric === 'db_cpu_us_per_send')!;
  assert.ok(Math.abs((e.position_1 as number) - 3.2) < 1e-9);
  for (const p of [2, 3, 4, 5]) assert.ok(Math.abs((e[`position_${p}`] as number) + 0.8) < 1e-9);
  assert.ok(Math.abs((e.range as number) - 4) < 1e-9);
  const flat = r.tables['position-effects'].find(x => x.phase === 'C1' && x.shape === 'hot-17' && x.metric === 'exec_us_per_send')!;
  assert.equal(flat.range, 0);
  assert.match(r.markdown, /## Arm order per round/);
  assert.match(r.markdown, /\| C1 \| 2 \| hot-17 then many-17 \| fkc > fks > fk2 > pk > base \|/);
});

test('INVALID windows are listed, fail the summary and are never paired', () => {
  const bad = windows(false).find(w => w.phase === 'C1' && w.round === 1 && w.shape === 'many-17' && w.arm === 'base')!;
  const r = analyze(manifest(), w => w.id === bad.id
    ? { result: { ...fixture(w, armValues(w.arm)).result, valid: false, reasons: ['checkpoint: boom'], measured: null, verification: null }, statements: [] }
    : fixture(w, armValues(w.arm)));
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalid, [{ id: bad.id, reasons: ['checkpoint: boom'] }]);
  assert.equal(r.tables['paired-deltas'].some(x => x.phase === 'C1' && x.shape === 'many-17' && x.round === 1), false);
  assert.equal(r.tables['paired-medians'].find(x => x.phase === 'C1' && x.shape === 'many-17' && x.candidate === 'pk')!.n, 4);
  assert.match(r.markdown, /## INVALID windows\n\n- C1-r1-many-17-base: checkpoint: boom/);
});

test('the 2026-11-23 checks still invalidate a window: k6 counts, captured statistics, integrity, missing windows', () => {
  const plan = windows(false);
  const r = analyze(manifest(), w => {
    const f = fixture(w, armValues(w.arm));
    if (w.id === plan[0].id) f.result.measured!.load.iterations = 1;
    if (w.id === plan[1].id) f.result.measured!.cpuUsec = 0;
    if (w.id === plan[2].id) f.result.verification!.verified = false;
    return w.id === plan[3].id ? null : f;
  });
  assert.deepEqual(r.invalid.map(i => i.reasons), [['k6 counts do not reconcile'], ['statistics not captured'], ['not verified'], ['window missing']]);
});

test('a recorded order that differs from the plan, or an unbalanced one, is a run problem', () => {
  const m = manifest();
  const swapped = { ...m, windows: m.windows.map(w => w.round === 1 && w.phase === 'C2' ? { ...w, position: 3 - w.position } : w) };
  const r = analyze(swapped, w => fixture(w, armValues(w.arm)));
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['recorded window order differs from the plan', 'arm order is not balanced']);
  assert.deepEqual(analyze({ ...m, c2Compatibility: undefined }, w => fixture(w, armValues(w.arm))).problems, ['C2 compatibility record missing']);
});
