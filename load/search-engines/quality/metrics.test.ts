import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate, score } from './metrics.ts';
import { corpus, queries, classes } from './dataset.ts';

test('hand-computed overlap, misses and false positives',()=>{
  const s = score(['a','b','c'],['b','x']);
  assert.deepEqual([s.tp,s.fp,s.fn],[1,1,2]);
  assert.equal(s.precision,1/2); assert.equal(s.recall,1/3); assert.equal(s.f1,.4);
  assert.deepEqual(s.missed,['a','c']); assert.deepEqual(s.falsePositives,['x']);
  assert.equal(s.ndcg20,undefined);
});
test('empty conventions and duplicates',()=>{
  for (const [gold,found,value] of [[[],[],1],[['a'],[],0],[[],['a'],0]] as const) {
    const s = score([...gold],[...found],true);
    assert.deepEqual([s.precision,s.recall,s.f1,s.ndcg20],[value,value,value,value]);
  }
  assert.throws(()=>score([],['a','a']),/Duplicate/);
  assert.throws(()=>aggregate([]),/Empty/);
});
test('micro differs from unweighted query macro; F1 is averaged directly',()=>{
  const a = aggregate([score(['a','b','c'],['a']),score(['x'],['x'])]);
  assert.equal(a.micro.precision,1); assert.equal(a.micro.recall,.5);
  assert.equal(a.micro.f1,2/3); assert.equal(a.macro.recall,2/3); assert.equal(a.macro.f1,.75);
});
test('binary nDCG@20 with id tie ordering supplied by runner',()=>{
  const s = score(['a','b'],['x','a','b'],true);
  assert.equal(s.ndcg20,(1/Math.log2(3)+.5)/(1+1/Math.log2(3)));
  assert.equal(score(['a'],Array.from({length:20},(_,i)=>String(i)).concat('a'),true).ndcg20,0);
});
test('gold ids are unique, resolvable and classes covered',()=>{
  const data = corpus(), ids = new Set(data.map(m=>m.id));
  assert.equal(ids.size,data.length);
  assert.equal(new Set(queries.map(q=>q.id)).size,queries.length);
  assert.deepEqual(new Set(queries.map(q=>q.class)),new Set(Object.keys(classes)));
  for (const q of queries) {
    assert.equal(new Set(q.gold).size,q.gold.length);
    for (const id of q.gold) assert.ok(ids.has(id),`${q.id}: ${id}`);
  }
});
