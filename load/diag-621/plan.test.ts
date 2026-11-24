import assert from 'node:assert/strict';
import test from 'node:test';
import { balanced, conditions, PHASES, positionCounts, rotation, SHAPES, windows, type Window } from './plan.ts';

test('every arm takes every position equally often in each phase and shape', () => {
  const plan = windows(false);
  assert.equal(balanced(plan), true);
  for (const [phase, arms] of PHASES) for (const shape of SHAPES) for (const arm of arms) {
    const row = positionCounts(plan).get(`${phase}/${shape}/${arm}`);
    assert.deepEqual(row, Array(arms.length).fill(phase === 'C1' ? 1 : 2), `${phase}/${shape}/${arm}`);
  }
});

test('the full plan is C1 5 rounds x 5 arms and C2 4 rounds x 2 arms, on both shapes, each id once', () => {
  const plan = windows(false);
  assert.equal(plan.filter(w => w.phase === 'C1').length, 50);
  assert.equal(plan.filter(w => w.phase === 'C2').length, 16);
  assert.equal(new Set(plan.map(w => w.id)).size, plan.length);
  assert.deepEqual(plan.map(w => w.index), plan.map((_, i) => i + 1));
});

test('each window records its round order and its position in it; rounds rotate the arms', () => {
  const plan = windows(false);
  const c1 = (round: number, shape: string) => plan.filter(w => w.phase === 'C1' && w.round === round && w.shape === shape);
  assert.deepEqual(c1(1, 'many-17').map(w => w.arm), ['base', 'fkc', 'fks', 'fk2', 'pk']);
  assert.deepEqual(c1(2, 'many-17').map(w => w.arm), ['fkc', 'fks', 'fk2', 'pk', 'base']);
  assert.deepEqual(c1(5, 'hot-17').map(w => w.arm), ['pk', 'base', 'fkc', 'fks', 'fk2']);
  for (const w of plan) assert.equal(w.order[w.position - 1], w.arm);
  // Shapes alternate by round as in the 2026-11-23 run.
  assert.deepEqual([...new Set(plan.filter(w => w.phase === 'C2' && w.round === 2).map(w => w.shape))], ['hot-17', 'many-17']);
});

test('an unbalanced order is detected (forward/reverse/forward of the 2026-11-23 run)', () => {
  const old: Window[] = [];
  for (const [phase, arms] of PHASES) for (let round = 1; round <= 3; round++) {
    const order = round === 2 ? [...arms].reverse() : [...arms];
    for (const shape of SHAPES) order.forEach((arm, i) => old.push({ id: `${phase}-${round}-${shape}-${arm}`, index: old.length + 1,
      phase, round, shape, arm, position: i + 1, order }));
  }
  assert.equal(balanced(old), false);
  assert.equal(balanced(windows(false).filter(w => w.round !== 3)), false);
});

test('rotation keeps every arm once', () => {
  assert.deepEqual(rotation(['a', 'b', 'c'], 4), ['b', 'c', 'a']);
});

test('the smoke plan is many-17 only, two rotated rounds per phase', () => {
  const plan = windows(true);
  assert.deepEqual([...new Set(plan.map(w => w.shape))], ['many-17']);
  assert.equal(plan.length, 2 * 5 + 2 * 2);
  assert.deepEqual(plan.filter(w => w.phase === 'C2').map(w => w.arm), ['base', 'inline', 'inline', 'base']);
});

test('measurement conditions are those of the 2026-11-23 run', () => {
  assert.deepEqual(conditions(false), { rate: 250, warmSeconds: 3, measuredSeconds: 8 });
  assert.deepEqual(conditions(true), { rate: 20, warmSeconds: 3, measuredSeconds: 10 });
  assert.deepEqual(PHASES, [['C1', ['base', 'fkc', 'fks', 'fk2', 'pk']], ['C2', ['base', 'inline']]]);
});
