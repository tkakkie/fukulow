import test from 'node:test';
import assert from 'node:assert/strict';
import { matrix,integers,estimate,equal,oracleDigest,percentile,summary,type Sample } from './model.ts';
import { documents } from './measure.ts';
import { fixture,projectionSql,countSql } from './sql.ts';
import { readinessArgs } from './database.ts';
test('matrix varies Members for public visibility; other operations affect one',()=>{
  const points=matrix([10,1000,10000],[1,100,1000]);
  assert.equal(points.length,24);assert.equal(points.filter(p=>p.operation==='public').length,9);
  assert.ok(points.every(p=>p.operation==='public'||p.members===1));
  assert.equal(estimate(points,3,10).runs,144);
  assert.equal(estimate(points,3,10).topicWrites,37125720);
  assert.ok(estimate(points,5,10).minutes>estimate(points,3,10).minutes);
});
test('options reject noninteger, duplicate and empty counts; estimates enforce repeats',()=>{
  for(const s of ['','1,1','0','-1','1.5','NaN'])assert.throws(()=>integers(s));
  assert.deepEqual(integers('10,1000'),[10,1000]);
  assert.throws(()=>estimate(matrix([10],[1]),2,10));
  assert.throws(()=>estimate(matrix([10],[1]),3,1));
});
test('equality checker compares complete structured results and fails on missing/count/baseline drift',()=>{
  const x={baseline:[{initial_seq:10}],baselineCounts:[{unread:2,mention:1}],sparse:[{read_seq:15,unread:0}]};
  equal(x,structuredClone(x),'positive');
  for(const y of [{...x,baseline:[]},{...x,baselineCounts:[{unread:2,mention:0}]},{...x,sparse:[{read_seq:14,unread:0}]}])assert.throws(()=>equal(x,y,'negative'),/eager\/lazy mismatch/);
});
test('summary emits paste-ready paired improvements and explicitly labels pilot',()=>{
  const base:Sample={operation:'public',topics:10,members:100,variant:'eager',repeat:0,latencyMs:10,rows:1000,walBytes:10000,buffers:100,senderMs:11,senderBaselineMs:1,reads:[{stage:'baseline',query:'counts',mode:'custom',ms:2,buffers:7}]};
  const md=summary([base,{...base,variant:'lazy',latencyMs:5,rows:100}],true,'conditions');
  assert.match(md,/PILOT/);assert.match(md,/50\.000%/);assert.match(md,/1000\/100/);assert.match(md,/conditions/);assert.match(md,/public\/10\/100 \| baseline\/counts\/custom/);assert.match(md,/2\.000\/2\.000/);
  assert.throws(()=>summary([base],false,''),/unpaired/);
  assert.equal(percentile([3,1,2],.95),3);assert.equal(percentile([3,1,2],.5),2);
});
test('JSON framing handles nested plans and escaped payloads, rejects unexpected output',()=>{
  assert.deepEqual(documents('[{"Plan":{"x":"}\\\"["}}]\n{"latency_ms":2}'),[[{Plan:{x:'}"['}}],{latency_ms:2}]);
  assert.throws(()=>documents('NOTICE: bad'));assert.throws(()=>documents('[{}'));
});
test('production read extraction retains initial_seq fallback and Mention counts',()=>{
  assert.match(countSql(),/COALESCE\(tr.read_seq, p.initial_seq\)/);assert.match(countSql(),/message_mentions/);
  assert.match(projectionSql(),/COALESCE\(tr.read_seq, cr.initial_seq, w.as_of_seq\)/);
  assert.match(projectionSql(),/mention_unread_count/);assert.doesNotMatch(projectionSql(),/\{\}/);
  const join=fixture({operation:'join',topics:10,members:1},10);
  assert.match(join,/FROM generate_series\(0,0\) g/);assert.doesNotMatch(join,/@topics@|@members@/);
});
test('readiness probes TCP so the image init temporary socket-only server is not taken as ready',()=>{
  const args=readinessArgs('c');
  assert.deepEqual(args.slice(0,3),['exec','c','pg_isready']);
  assert.equal(args[args.indexOf('-h')+1],'127.0.0.1');
});

test('oracle digest is stable for equal rows and differs for any changed row', () => {
  const rows = { baselines: [1], 'baseline/counts': [{ channel: 'a', unread: 2 }] };
  assert.equal(oracleDigest(rows).sha256, oracleDigest(structuredClone(rows)).sha256);
  assert.notEqual(oracleDigest(rows).sha256, oracleDigest({ ...rows, 'baseline/counts': [{ channel: 'a', unread: 3 }] }).sha256);
  assert.equal(oracleDigest(rows).bytes, Buffer.byteLength(JSON.stringify(rows)));
});
