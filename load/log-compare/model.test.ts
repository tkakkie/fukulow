import assert from 'node:assert/strict';
import test from 'node:test';
import { arms, alternating, gates, reduce, repetition, type Sample } from './model.ts';
import { parsePgbench, planSummary } from './measure.ts';
import { commonSchema, variantSchema, functions, replaySQL, workloadSQL } from './sql.ts';
const entry=(position:number,deleted=false,body=deleted?'':'body',version=position)=>({position,id:'m',deleted,body,version});
function samples():Sample[] {
  return [0,1,2].flatMap(round=>arms.map(arm=>({arm,round,
    conditions:{scenario:'create',rate:10,seconds:10,clients:2,seed:160,image:'sha256:x',config:'same',machine:'same'},
    offered:100,accepted:100,errors:0,dropped:0,late:0,elapsed:10,p50:1,p95:2,p99:3,tps:10,
    walPerOp:100,heapPerOp:80,indexPerOp:20,correctness:{missing:0,resurrected:0,retryPositions:0}})));
}
test('reducer advances a consecutive stream and ends at the tombstone',()=>{
  const r=reduce([entry(1),entry(2),entry(3,true)]);
  assert.equal(r.cursor,3);assert.equal(r.state.get('m')?.body,'');
});
test('missing, duplicate and out-of-order positions fail',()=>{
  for(const entries of [[entry(1),entry(3)],[entry(1),entry(1)],[entry(2),entry(1)]])
    assert.throws(()=>reduce(entries),/missing\/out-of-order/);
});
test('resurrected deleted bodies and nonempty tombstones fail',()=>{
  assert.throws(()=>reduce([entry(1,true),entry(2,false)]),/resurrected/);
  assert.throws(()=>reduce([entry(1,true,'old body')]),/resurrected/);
});
test('current-state reconciliation may repeat one final version over several positions',()=>{
  assert.equal(reduce([entry(1,true,'',8),entry(2,true,'',8)]).cursor,2);
});
test('all reported gates pass at identical sustainable conditions',()=>{
  const result=gates(samples(),true);assert.equal(result.valid,true);assert.equal(result.pass,true);
  assert.equal(result.label,'MAC-RELATIVE');assert.match(result.absoluteBudgets,/NOT EVALUATED/);
});
test('mismatched image, seed, config, load, machine or scenario invalidates the run',()=>{
  for(const [key,value] of Object.entries({image:'other',seed:2,config:'other',rate:20,seconds:20,clients:4,machine:'other',scenario:'mixed'})) {
    const s=samples();Object.assign(s[1].conditions,{[key]:value});
    assert.equal(gates(s,true).valid,false,key);
  }
});
test('dropped work, errors, short acceptance and late completion invalidate',()=>{
  for(const change of [{dropped:1},{errors:1},{accepted:99},{late:1},{elapsed:11}]) {
    const s=samples();Object.assign(s[0],change);assert.equal(gates(s,true).valid,false);
  }
});
test('spread over ten percent invalidates rather than silently medianing it away',()=>{
  const s=samples();s[0].p95=2.21;const g=gates(s,true);
  assert.equal(g.valid,false);assert.ok(g.reasons.some(r=>r.includes('spread')));
});
test('missing, resurrection, retry positions, missing rounds and NaN cannot pass',()=>{
  for(const key of ['missing','resurrected','retryPositions'] as const) {
    const s=samples();s[0].correctness[key]=1;assert.equal(gates(s,true).pass,false);
  }
  assert.equal(gates(samples().filter(s=>s.round!==2),true).valid,false);
  const s=samples();s[0].p95=NaN;assert.equal(gates(s,true).valid,false);
});
test('10% throughput/p95 and 2x creation WAL/storage gates are not relaxed',()=>{
  for(const change of [{tps:8.99},{p95:2.201},{walPerOp:200.01},{heapPerOp:181}]) {
    const s=samples();s.filter(s=>s.arm==='log-ids').forEach(s=>Object.assign(s,change));
    const g=gates(s,true);assert.equal(g.valid,true);assert.equal(g.pass,false);assert.ok(g.regressions.length);
  }
  const s=samples();s.filter(s=>s.arm==='log-ids').forEach(s=>Object.assign(s,{tps:9,p95:2.2,walPerOp:200,heapPerOp:180}));
  assert.equal(gates(s,true).pass,true);
});
test('mixed comparisons do not apply the creation-only WAL gate',()=>{
  const s=samples();s.filter(s=>s.arm==='log-ids').forEach(s=>{s.walPerOp=300;});assert.equal(gates(s,false).pass,true);
});
test('round order alternates and every round contains every arm once',()=>{
  assert.deepEqual(alternating(1),alternating(0).reverse());assert.deepEqual(alternating(2),arms);
});
test('pgbench parsing separates transaction latency from scheduling lag and counts skips',()=>{
  const report='number of transactions actually processed: 2\nnumber of failed transactions: 0 (0%)\nnumber of transactions skipped: 1 (33%)\nnumber of transactions above the 1000.0 ms latency limit: 0\ntps = 2.000 (without initial connection time)';
  const r=parsePgbench(report,'0 1 2000 0 123 0 1000\n0 2 skipped 0 123 1 500\n1 1 4000 0 123 2 2000',1);
  assert.equal(r.p50,1);assert.equal(r.p95,2);assert.equal(r.scheduledP95,4);assert.equal(r.offered,3);assert.equal(r.dropped,1);
  assert.throws(()=>parsePgbench(report,'',1),/mismatch/);
  assert.throws(()=>parsePgbench('', '',1),/incomplete/);
});
test('physical rows scanned include loop multipliers and filtered rows, buffers use the root',()=>{
  const r=planSummary({'Node Type':'Nested Loop','Actual Rows':50,'Actual Loops':1,'Shared Hit Blocks':90,
    Plans:[{'Node Type':'Index Scan','Actual Rows':1,'Actual Loops':50,'Rows Removed by Filter':2,'Shared Hit Blocks':80}]});
  assert.equal(r.scanRows,150);assert.equal(r.buffers.hit,90);
});
test('SQL arms preserve production indexes, isolated org keys, and snapshot creation costs',()=>{
  assert.match(commonSchema(),/messages_topic_seq/);assert.match(commonSchema(),/messages_reply_chain_seq/);
  assert.match(commonSchema(),/history_generation/);assert.match(commonSchema(),/send_receipts/);
  assert.doesNotMatch(variantSchema('events-ids'),/CREATE TABLE creation_snapshots/);
  assert.match(variantSchema('events-snapshot'),/CREATE TABLE creation_snapshots/);
  assert.doesNotMatch(functions('events-ids'),/INSERT INTO creation_snapshots/);
  assert.match(functions('log-ids'),/INSERT INTO channel_log/);
  assert.match(replaySQL('events-ids',0),/UNION ALL/);
  assert.match(replaySQL('events-snapshot',0),/creation_snapshots/);
  assert.doesNotMatch(replaySQL('log-snapshot',0),/JOIN messages/);
});

test('repetition summaries reject too few rounds and excess spread',()=>{
  assert.equal(repetition([10,10,10]).valid,true);
  assert.equal(repetition([10,10]).valid,false);
  assert.equal(repetition([10,10,12]).valid,false);
  assert.equal(repetition([0,0,0]).valid,true);
});
test('receipt retry parent and new Reply root are separate from the bounded Move root',()=>{
  const sql=functions('log-ids');
  assert.match(sql,/WHEN reply THEN fixture_id\(c,40\)/);
  assert.match(sql,/WHEN op=2 THEN fixture_id\(c,1\)/);
});

test('mixed edits change content while preserving the configured body length',()=>{
  const ascii=workloadSQL('Load test message',1,[50,20,20,10]);
  assert.match(ascii,/chr\(65\+\(:n%26\)/);
  assert.match(ascii,/substr\('Load test message',2\)/);
  const maximum=workloadSQL('𠀀'.repeat(4000),1,[90,5,3,2]);
  assert.match(maximum,/chr\(131072\+\(:n%65536\)/);
});
