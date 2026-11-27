import assert from 'node:assert/strict';
import test from 'node:test';
import { formalPairs, reviewedAssignments, hit, existence, foreignMessageCount, globalSize, judgedPairs, negativeControl, positiveControl,
  slotBody, visible, visibilityMap } from './arms.ts';
import { formal, judgedIds, queries } from './design.ts';
import { checkPage } from './page.ts';
import { options } from './options.ts';
import { productionPath } from '../d3r/path.ts';

test('the judged matrix replaces same-length foreign decoys with exactly 1 or 1,000 whole query tokens', () => {
  assert.deepEqual(judgedPairs(formal).map(pair => pair.id), judgedIds);
  for (const {few, many} of judgedPairs(formal)) {
    assert.equal(few.slots, 1_000);
    assert.equal(few.slots, many.slots);
    assert.equal(few.scope, many.scope);
    assert.equal(few.query, many.query);
    for (const arm of [few, many]) {
      const slots = Array.from({length: arm.slots}, (_, i) => slotBody(arm, i + 1));
      assert.equal(slots.filter(body => body.includes(queries[arm.query])).length, arm === few ? 1 : 1_000);
      assert.ok(slots.every(body => body.length === 4));
    }
  }
});

test('P shares Q4’s trigram in exactly K slots while failing the full token recheck', () => {
  const {few, many} = positiveControl(128);
  assert.equal(few.query, 'Q4');
  assert.equal(few.candidates, 0);
  assert.equal(many.candidates, 128);
  assert.equal(few.scope, undefined);
  assert.equal(many.scope, undefined);
  const body = slotBody(many, 128);
  assert.ok(body.includes(queries.Q4.slice(0, 3)));
  assert.ok(!body.includes(queries.Q4));
  assert.equal(body.length, slotBody(few, 128).length);
});

test('reported-only builders apply exact counts to explicitly supplied reference assignments', () => {
  const e = existence('C3', 'Q2', formal);
  assert.deepEqual([e.few.matches, e.many.matches], [0, 1_000]);
  const s = globalSize('Q4', formal);
  assert.equal(s.many.extraForeignMessages, 9 * foreignMessageCount(s.few, formal));
  assert.equal(s.many.matches, 0);
  const ref = judgedPairs(formal).at(-1)!.few;
  const v = visibilityMap('C3', 'Q4', formal, ref);
  assert.equal(v.few, ref);
  assert.equal(v.many.afterVacuum, true);
  assert.equal(v.many.matches, 1_000);
  const negative = negativeControl(ref);
  assert.notEqual(negative.few, negative.many);
  assert.deepEqual(negative.few, negative.many);
});

test('page readback requires all five visible scopes and exactly the expected row', () => {
  const page = productionPath().page;
  const app = (response: string, scope = visible) => (sql: string) =>
    sql.includes('PREPARE') ? `scope-context\n${response}` : JSON.stringify([scope, true, 'qvwx']);
  const hitRow = `${hit}|at`;
  assert.equal(checkPage(app(hitRow), page, 'qvwx').visiblePage, hitRow);
  assert.throws(() => checkPage(app(`other|at\n${hitRow}`), page, 'qvwx'), /exactly one row/);
  assert.throws(() => checkPage(app(hitRow, visible.slice(1)), page, 'qvwx'));
});

test('formal cannot proceed with unresolved pre-registration assignments or a caller-supplied K', () => {
  assert.throws(() => formalPairs(128, reviewedAssignments), /assignments are unresolved/);
  assert.throws(() => options(['--formal', '--out=out', '--k=128']), /frozen manifest/);
  assert.deepEqual(options(['--smoke', '--out=out', '--k=32,128']).ks, [32, 128]);
});
