import assert from 'node:assert/strict';
import test from 'node:test';
import { planFacts } from './plan.ts';

const root = {'Node Type': 'Nested Loop', 'Actual Rows': 1, 'Actual Loops': 1, 'Shared Hit Blocks': 35, 'Shared Read Blocks': 2};
const lookup = {'Node Type': 'Index Only Scan', 'Index Name': 'message_search_terms_lookup',
  'Actual Rows': .2, 'Actual Loops': 5, 'Heap Fetches': 3, 'Shared Hit Blocks': 16};
const plan = (node = lookup, parent = root) => planFacts([{Plan: {...parent, Plans: [node]}}]);

test('the plan gate compares node types, index names and executed lookup rows', () => {
  const a = plan();
  assert.notEqual(a.shape, plan({...lookup, 'Node Type': 'Index Scan'}).shape);
  assert.notEqual(a.shape, plan({...lookup, 'Index Name': 'another_lookup'}).shape);
  assert.notEqual(a.shape, plan({...lookup, 'Actual Rows': .4}).shape);
  assert.notEqual(a.shape, plan({...lookup, 'Actual Loops': 10}).shape);
  assert.equal(a.shape, plan({...lookup, 'Actual Rows': .5, 'Actual Loops': 2}).shape);
});

test('shared buffers and heap fetches are report-only', () => {
  const a = plan();
  const b = plan({...lookup, 'Heap Fetches': 9}, {...root, 'Shared Hit Blocks': 90, 'Shared Read Blocks': 7});
  assert.equal(a.shape, b.shape);
  assert.deepEqual([a.sharedHit, a.sharedRead, a.heapFetches], [35, 2, 3]);
  assert.deepEqual([b.sharedHit, b.sharedRead, b.heapFetches], [90, 7, 9]);
});
