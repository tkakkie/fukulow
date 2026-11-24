import assert from 'node:assert/strict';
import test from 'node:test';
import { ordered, sequence, type Step } from './plan.ts';

const ids = (steps: Step[]) => steps.map(s => s.id);
const orderOf = (steps: Step[], id: string) => (steps.find(s => s.id === id) as {order: string}).order;

test('Stage 1 is the fixed rev 2 sequence: 14 copy rounds and 6 same-copy measurements', () => {
  const steps = sequence('1');
  assert.deepEqual(ids(steps), ['A1.1', 'A1.2', 'A1.3', 'A1.4', 'A1.5', 'A1.6', 'A2.idle', 'A2.1', 'A2.2',
    'C1.warm', 'C1.hot1', 'C1.hot2', 'C1.restart', 'D.current1', 'D.settle1', 'D.current2', 'D.settle2',
    'C2.warm', 'C2.hot1', 'C2.hot2', 'C2.restart']);
  assert.equal(steps.filter(s => s.kind === 'copy').length, 14);
  assert.equal(steps.filter(s => s.kind === 'hot' || s.kind === 'restart-only').length, 6);
  assert.deepEqual(steps.filter(s => s.kind === 'copy' && s.settle).map(s => s.id), ['D.settle1', 'D.settle2']);
  assert.deepEqual(steps.find(s => s.id === 'A2.idle'), {kind: 'idle', id: 'A2.idle', ms: 30 * 60_000});
  assert.equal(steps.some(s => s.kind === 'scan'), false);
});

test('copy rounds alternate F and R from F; same-copy measurements keep their copy order', () => {
  const steps = sequence('1');
  assert.deepEqual(['A1.1', 'A1.2', 'A1.3', 'A1.4', 'A1.5', 'A1.6', 'A2.1', 'A2.2'].map(id => orderOf(steps, id)),
    ['F', 'R', 'F', 'R', 'F', 'R', 'F', 'R']);
  assert.deepEqual(['C1.warm', 'C1.hot1', 'C1.hot2', 'C1.restart'].map(id => orderOf(steps, id)), ['F', 'F', 'F', 'F']);
  assert.deepEqual(['D.current1', 'D.settle1', 'D.current2', 'D.settle2', 'C2.warm', 'C2.restart'].map(id => orderOf(steps, id)),
    ['R', 'F', 'R', 'F', 'R', 'R']);
});

test('Stage 2 has the scan after one round, then 3 rounds, a cool-down and 2 rounds', () => {
  const steps = sequence('2');
  assert.deepEqual(ids(steps), ['B.pre', 'B.scan', 'B.post1', 'B.post2', 'B.post3', 'B.idle', 'B.cool1', 'B.cool2']);
  assert.equal(steps.filter(s => s.kind === 'copy').length, 6);
});

test('the smoke is the approved single copy round, with the settle wait', () => {
  assert.deepEqual(sequence('smoke'), [{kind: 'copy', id: 'smoke.1', arm: 'smoke', settle: true, order: 'F'}]);
});

test('R reverses the frozen query order without changing it', () => {
  const set = [['a', '1'], ['b', '2'], ['c', '3']] as const;
  assert.deepEqual(ordered(set, 'R').map(([q]) => q), ['c', 'b', 'a']);
  assert.deepEqual(ordered(set, 'F').map(([q]) => q), ['a', 'b', 'c']);
  assert.deepEqual(set.map(([q]) => q), ['a', 'b', 'c']);
});
