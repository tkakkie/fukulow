import assert from 'node:assert/strict';
import test from 'node:test';
import { windows, type Window } from './plan.ts';
import { analyze, FAMILIES, LOAD, METRICS, type Manifest, type Result, type Statement } from './summary.ts';
import type { Control } from './window.ts';

const accepted = 2000;
type Values = { execUs: number; calls: number; cpuUs: number; walBytes: number; stmtWal: number; stmtFpi: number; statFpi: number; statWal: number };
const armValues = (arm: string): Values => ({ execUs: 100 + (arm === 'base' ? 0 : 10), calls: 26, cpuUs: 900 + (arm === 'base' ? 0 : 50),
  walBytes: 1700 + (arm === 'base' ? 0 : 200), stmtWal: 1600, stmtFpi: arm === 'base' ? 0 : 0.03, statFpi: arm === 'base' ? 0.01 : 0.05, statWal: 1650 });

// Explicit checkpoint: redo record at 0/2, completion at 0/3; the window ends at 0/500.
const control = (lsn: string): Control => ({ lsn, redo: '0/2', checkpoint: '0/3', time: 't' });
const explicitWal = { ok: true as const, from: '0/1', to: '0/500', records: [{ lsn: '0/2', type: 'CHECKPOINT_REDO' }, { lsn: '0/3', type: 'CHECKPOINT_ONLINE' }] };

function fixture(w: Window, v: Values, o: Partial<Result> = {}): { result: Result; statements: Statement[] } {
  const load = { accepted, attempts: accepted, iterations: accepted, errors: 0, dropped: 0 };
  return {
    result: { id: w.id, valid: true, reasons: [], checkpoint: { ok: true, startedAt: 's', ms: 40 + w.position, before: control('0/1'), after: control('0/4') },
      warmup: { ...load, accepted: 750, attempts: 750, iterations: 750 }, walCheckpoints: explicitWal,
      measured: { accepted, load, controlBefore: control('0/4'), controlAfter: control('0/500'), cpuUsec: v.cpuUs * accepted, walBytes: v.walBytes * accepted,
        statWal: { records: 16 * accepted, fpi: v.statFpi * accepted, bytes: v.statWal * accepted }, statementInfo: { dealloc: 0 } },
      verification: { verified: true, shapeAfter: { heap_bytes: 8192, index_bytes: 4096 } }, ...o },
    statements: [
      { toplevel: true, queryid: 1, calls: v.calls * accepted, total_exec_time: v.execUs * accepted / 1000, wal_records: 15 * accepted,
        wal_bytes: String(v.stmtWal * accepted), wal_fpi: v.stmtFpi * accepted, query: 'INSERT INTO messages' },
      { toplevel: true, queryid: 2, calls: accepted, total_exec_time: 999, wal_records: 0, wal_bytes: '0', wal_fpi: 0, query: 'SELECT 1' },
    ],
  };
}
function manifest(smoke = false, invalid?: { id: string; reasons: string[] }): Manifest {
  const plan = windows(smoke);
  const results = plan.map(({ id }) => id === invalid?.id ? { ...invalid, valid: false } : { id, valid: true, reasons: [] });
  return { smoke, windows: plan, results, c2Compatibility: { cases: 1400, mismatches: 0 } };
}

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
  assert.equal(e.note, null);
  const flat = r.tables['position-effects'].find(x => x.phase === 'C1' && x.shape === 'hot-17' && x.metric === 'exec_us_per_send')!;
  assert.equal(flat.range, 0);
  assert.match(r.markdown, /## Arm order per round/);
  assert.match(r.markdown, /\| C1 \| 2 \| hot-17 then many-17 \| fkc > fks > fk2 > pk > base \|/);
});

test('INVALID windows are listed, fail the summary and are never paired', () => {
  const bad = windows(false).find(w => w.phase === 'C1' && w.round === 1 && w.shape === 'many-17' && w.arm === 'base')!;
  const r = analyze(manifest(false, { id: bad.id, reasons: ['checkpoint: boom'] }), w => w.id === bad.id
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
  assert.deepEqual(r.invalid.map(i => i.reasons), [['k6 counts do not reconcile'], ['statistics not captured'], ['integrity verification failed'], ['window missing']]);
});

test('a window recorded valid without checkpoint, warm-up or statement evidence is INVALID and fails the summary', () => {
  const plan = windows(false);
  const cases: [(f: ReturnType<typeof fixture>) => void, string][] = [
    [f => { f.result.checkpoint = null; }, 'checkpoint evidence missing'],
    [f => { f.result.warmup = null; }, 'warm-up evidence missing or malformed'],
    [f => { f.statements = []; }, 'statement evidence missing'],
    [f => { f.statements = f.statements.filter(s => s.query === 'SELECT 1'); }, 'statement evidence missing'],
    [f => { f.result.walCheckpoints = null; }, 'checkpoint WAL evidence missing'],
    [f => { f.result.walCheckpoints = { ...explicitWal, records: [...explicitWal.records, { lsn: '0/400', type: 'CHECKPOINT_REDO' }] }; },
      'another checkpoint started or completed between the explicit checkpoint and the end of the window'],
    [f => { f.result.measured = null; }, 'measurement missing'],
    [f => { f.result.verification = null; }, 'integrity evidence missing or malformed'],
  ];
  for (const [mutate, reason] of cases) {
    const r = analyze(manifest(), w => { const f = fixture(w, armValues(w.arm)); if (w.id === plan[0].id) mutate(f); return f; });
    assert.equal(r.ok, false, reason);
    assert.equal(r.invalid.length, 1, reason);
    assert.ok(r.invalid[0].reasons.includes(reason), `${reason}: ${r.invalid[0].reasons.join('; ')}`);
    assert.equal(r.tables.windows.find(x => x.id === plan[0].id)!.valid, false);
  }
});

function assertPartialEvidenceInvalid(overrides: Partial<Result>, reason: string) {
  const m = manifest();
  const [bad] = m.windows;
  const r = analyze(m, w => fixture(w, armValues(w.arm), w.id === bad.id ? overrides : {}));
  assert.equal(r.tables.windows.find(row => row.id === bad.id)?.valid, false);
  assert.deepEqual(r.invalid, [{ id: bad.id, reasons: [reason] }]);
}

test('empty warm-up counts make the window INVALID', () => {
  assertPartialEvidenceInvalid({ warmup: {} as NonNullable<Result['warmup']> }, 'warm-up evidence missing or malformed');
});

test('a missing verified field makes the window INVALID', () => {
  const verification = { shapeAfter: { heap_bytes: 8192, index_bytes: 4096 } } as NonNullable<Result['verification']>;
  assertPartialEvidenceInvalid({ verification }, 'integrity verification failed');
});

test('duplicate checkpoint redo with no completion record makes the window INVALID', () => {
  assertPartialEvidenceInvalid({ walCheckpoints: { ...explicitWal, records: [explicitWal.records[0], explicitWal.records[0]] } },
    'explicit checkpoint records not found exactly once in WAL');
});

test('an INVALID manifest decision excludes a valid result from pairs', () => {
  const [bad] = windows(false);
  const m = manifest(false, { id: bad.id, reasons: ['checkpoint: boom'] });
  const r = analyze(m, w => fixture(w, armValues(w.arm)));
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalid, [{ id: bad.id, reasons: ['manifest and result decisions conflict'] }]);
  assert.equal(r.tables['paired-deltas'].some(x => x.phase === bad.phase && x.shape === bad.shape && x.round === bad.round), false);
});

test('missing or conflicting manifest decisions exclude otherwise valid windows', () => {
  const m = manifest();
  const [missing, duplicate, wrongId, wrongReasons] = m.windows;
  m.results = m.results!.filter(d => d.id !== missing.id);
  m.results.push({ id: duplicate.id, valid: true, reasons: [] });
  m.results.find(d => d.id === wrongReasons.id)!.reasons = ['unexpected reason'];
  const r = analyze(m, w => fixture(w, armValues(w.arm), w.id === wrongId.id ? { id: missing.id } : {}));
  assert.deepEqual(r.invalid, [
    { id: missing.id, reasons: ['manifest decision missing'] },
    { id: duplicate.id, reasons: ['manifest decision duplicated or malformed'] },
    { id: wrongId.id, reasons: ['manifest and result decisions conflict'] },
    { id: wrongReasons.id, reasons: ['manifest and result decisions conflict'] },
  ]);
  assert.equal(r.tables['paired-deltas'].some(x => x.phase === missing.phase && x.shape === missing.shape && x.round === missing.round), false);
});

test('a window the runner recorded INVALID keeps its recorded reasons; one recorded valid passes unchanged', () => {
  const [w] = windows(false);
  const r = analyze(manifest(false, { id: w.id, reasons: ['k6 counts do not reconcile'] }), x => x.id === w.id
    ? { ...fixture(x, armValues(x.arm)), result: { ...fixture(x, armValues(x.arm)).result, valid: false, reasons: ['k6 counts do not reconcile'] } }
    : fixture(x, armValues(x.arm)));
  assert.deepEqual(r.invalid, [{ id: w.id, reasons: ['k6 counts do not reconcile'] }]);
  assert.equal(analyze(manifest(), x => fixture(x, armValues(x.arm))).ok, true);
});

test('a recorded order that differs from the plan, or an unbalanced one, is a run problem', () => {
  const m = manifest();
  const swapped = { ...m, windows: m.windows.map(w => w.round === 1 && w.phase === 'C2' ? { ...w, position: 3 - w.position } : w) };
  const r = analyze(swapped, w => fixture(w, armValues(w.arm)));
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['recorded window order differs from the plan', 'arm order is not balanced']);
  assert.deepEqual(analyze({ ...m, c2Compatibility: undefined }, w => fixture(w, armValues(w.arm))).problems, ['C2 compatibility record missing']);
});

test('the position effect is suppressed for smoke runs and for a phase and shape that is not a complete square of valid windows', () => {
  // Round 1 is slower for every arm: a complete square cancels it, a square missing one window does not.
  const values = (w: Window) => ({ ...armValues(w.arm), cpuUs: armValues(w.arm).cpuUs + (w.round === 1 ? 24 : 0) });
  const find = (r: ReturnType<typeof analyze>, shape: string) =>
    r.tables['position-effects'].find(x => x.phase === 'C1' && x.shape === shape && x.metric === 'db_cpu_us_per_send')!;
  const full = analyze(manifest(), w => fixture(w, values(w)));
  assert.ok(Math.abs(find(full, 'many-17').range as number) < 1e-9);
  const gone = windows(false).find(w => w.phase === 'C1' && w.round === 1 && w.shape === 'many-17' && w.arm === 'base')!;
  const partial = analyze(manifest(), w => w.id === gone.id ? null : fixture(w, values(w)));
  const e = find(partial, 'many-17');
  assert.equal(e.range, null);
  assert.equal(e.position_1, undefined);
  assert.equal(e.note, 'suppressed: not a complete balanced square of valid windows');
  assert.equal(find(partial, 'hot-17').note, null);
  assert.match(partial.markdown, /suppressed: not a complete balanced square of valid windows/);
  const smoke = analyze(manifest(true), w => fixture(w, values(w)));
  assert.ok(smoke.tables['position-effects'].length > 0);
  for (const x of smoke.tables['position-effects']) {
    assert.equal(x.range, null);
    assert.equal(x.note, 'suppressed: smoke run (not a complete square)');
  }
});

test('duplicate manifest window rows suppress the position estimate for their phase and shape', () => {
  const m = manifest();
  const [first] = m.windows;
  m.windows.push({ ...first });
  const r = analyze(m, w => fixture(w, { ...armValues(w.arm), cpuUs: armValues(w.arm).cpuUs + (w.round === 1 ? 24 : 0) }));
  assert.ok(r.problems.includes('recorded window order differs from the plan'));
  const effects = r.tables['position-effects'].filter(x => x.phase === first.phase && x.shape === first.shape);
  assert.equal(effects.length, METRICS.length);
  for (const e of effects) {
    assert.equal(e.range, null);
    assert.equal(e.note, 'suppressed: not a complete balanced square of valid windows');
  }
  assert.ok(r.tables['position-effects'].some(x => x.phase === first.phase && x.shape !== first.shape && x.note === null));
});

test('load accounting: accepted sends, errors and dropped iterations per arm and paired against base', () => {
  const r = analyze(manifest(), w => {
    const f = fixture(w, armValues(w.arm));
    if (w.arm === 'pk') Object.assign(f.result.measured!, { accepted: 1990 }, { load: { ...f.result.measured!.load, accepted: 1990, errors: 3, dropped: 7 } });
    return f;
  });
  assert.deepEqual([...LOAD], ['accepted', 'errors', 'dropped', 'warm_accepted']);
  const pk = r.tables['load-medians'].find(x => x.phase === 'C1' && x.shape === 'hot-17' && x.arm === 'pk')!;
  assert.deepEqual([pk.n, pk.accepted, pk.errors, pk.dropped, pk.warm_accepted], [5, 1990, 3, 7, 750]);
  const d = r.tables['load-paired-medians'].find(x => x.phase === 'C1' && x.shape === 'hot-17' && x.candidate === 'pk')!;
  assert.deepEqual([d.n, d.accepted, d.errors, d.dropped], [5, -10, 3, 7]);
  assert.match(r.markdown, /^## load accounting$/m);
});
