import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryWithInclusions, type AttemptMemory } from './revocation-holds-memory-inclusions.ts';

function entry(id: string, kind: 'fault' | 'control', kb: number, excluded = false, evidenceOnly = true): AttemptMemory {
  return {
    kind, id, cell: 'H512', duration: kind === 'fault' ? 'short' : undefined, hwm: 512,
    deltaKb: { short: [kb, kb] }, verdict: excluded ? 'INVALID' : kind === 'fault' ? 'PASS' : 'CONTROL',
    evidenceOnly: excluded && evidenceOnly,
  };
}
const result = 'H512/short';

test('V5 evaluates joint inclusions and keeps the memory FAIL through replacement', () => {
  const valid = [entry('f1', 'fault', 100), ...[1, 2, 3].map(i => entry(`c${i}`, 'control', 0))];
  const first = entry('f2', 'fault', 9000, true), second = entry('f3', 'fault', 9000, true);
  assert.equal(memoryWithInclusions([...valid, first])[result].memory.result, 'NOT EVALUATED');
  assert.equal(memoryWithInclusions([...valid, second])[result].memory.result, 'NOT EVALUATED');
  const joint = [...valid, first, second];
  const initial = memoryWithInclusions(joint);
  assert.equal(initial[result].memory.result, 'FAIL');
  assert.deepEqual(initial[result].failures.map(f => [f.included, f.firstObservedAt]), [[['f2', 'f3'], 'f3']]);
  const after = memoryWithInclusions([...joint, entry('f4', 'fault', 100), entry('f5', 'fault', 100)], initial);
  assert.equal(after[result].memory.result, 'FAIL');
  assert.deepEqual(after[result].failures, initial[result].failures);
});

test('V5 evaluates controls jointly with fault exclusions and never includes floor-INVALID runs', () => {
  const group = [
    entry('f1', 'fault', 1200), entry('f2', 'fault', 1200), entry('f3', 'fault', 1200, true),
    entry('c1', 'control', 0), entry('c2', 'control', 0), entry('c3', 'control', 0, true),
  ];
  const history = memoryWithInclusions(group);
  assert.equal(history[result].memory.result, 'FAIL');
  assert.deepEqual(history[result].failures.map(f => f.included), [['f3', 'c3']]);
  group[2].evidenceOnly = false;
  assert.equal(memoryWithInclusions(group)[result].memory.result, 'NOT EVALUATED');
  // Even a later input set with no failing subset cannot erase an observed failure.
  assert.equal(memoryWithInclusions(group, history)[result].memory.result, 'FAIL');
});
