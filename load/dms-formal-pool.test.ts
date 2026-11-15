import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitEdges,occupancyEdges,parseProductionPoolLine,productionPoolEvidence,type PoolRetention} from './dms-formal-pool.ts';
import {judge} from './dms-formal-judgment.ts';
const from=Date.parse('2026-11-15T00:00:00Z'),to=from+20000;
const retained:PoolRetention={complete:true,startedAt:from-1000,endedAt:to+1000};
function fixture(waits:readonly number[]=[...Array(95).fill(10000),...Array(4).fill(50000),100000],active:(i:number)=>number=(i:number)=>i===20?32:24) {
  const rows: {timestamp:string;fields:Record<string,string|number>}[]=[];
  const occupancy=occupancyEdges.map(()=>0);
  for(let i=0;i<=20;i++) {
    const inUse=active(i);occupancyEdges.forEach((edge,j)=>{if(inUse<=edge)occupancy[j]++;});
    rows.push({timestamp:new Date(from+i*1000).toISOString(),fields:{event:'pool_stats',version:1,coverage:'application_after_connect',uncovered_paths:'startup_connect,migration_commands',interval_ms:1000,sample_sequence:i+1,sample_elapsed_ms:1000,in_use:inUse,idle:32-inUse,waiting:0,
      ...Object.fromEntries(['success','timeout','closed','io','database','other','cancelled'].map(name=>['acquire_'+name,name==='success'?i*waits.length:0])),
      ...Object.fromEntries(waitEdges.map(edge=>['wait_le_'+edge+'_us',i*waits.filter(value=>value<=edge).length])),wait_count:i*waits.length,
      ...Object.fromEntries(occupancyEdges.map((edge,j)=>['occupancy_le_'+edge,occupancy[j]])),occupancy_count:i+1}});
  }
  return rows;
}
const evaluate=(rows=fixture(),retention:PoolRetention|undefined=retained)=>productionPoolEvidence(rows.map(row=>JSON.stringify(row)),from,to,retention);
const poolRows=(result:ReturnType<typeof evaluate>)=>judge(result.evidence,'formal').rows.filter(row=>['pool.p95','pool.p99','pool.activeP95','pool.peak','pool.timeouts'].includes(row.budget));
test('production exact-edge window PASS: 10000/50000 us, occupancy 24 and peak 32',()=>{
  const result=evaluate();assert.deepEqual(result.reasons,[]);
  assert.deepEqual(poolRows(result).map(row=>row.value),[10,50,24,32,0]);
  assert.ok(poolRows(result).every(row=>row.status==='PASS'));
  assert.equal(judge(result.evidence,'formal').acceptance,false);
  const line='2026-11-15T00:00:00.000000000Z '+JSON.stringify(fixture()[0]);
  assert.equal(parseProductionPoolLine(line)?.at,from);
});
for(const [name,change,reason] of [
  ['missing all lines',(r:ReturnType<typeof fixture>)=>r.splice(0),/Missing pool_stats/],
  ['missing baseline',(r:ReturnType<typeof fixture>)=>r.shift(),/Missing baseline/],
  ['missing end',(r:ReturnType<typeof fixture>)=>r.pop(),/Missing end/],
  ['missing line',(r:ReturnType<typeof fixture>)=>r.splice(10,1),/sequence gap/],
  ['sequence restart',(r:ReturnType<typeof fixture>)=>r[10].fields.sample_sequence=1,/restart/],
  ['sequence duplicate',(r:ReturnType<typeof fixture>)=>r[10].fields.sample_sequence=10,/Non-monotonic/],
  ['sequence gap',(r:ReturnType<typeof fixture>)=>r[10].fields.sample_sequence=12,/sequence gap/],
  ['counter restart',(r:ReturnType<typeof fixture>)=>r[10].fields.acquire_success=0,/counter decrease/],
  ['elapsed gap',(r:ReturnType<typeof fixture>)=>r[10].fields.sample_elapsed_ms=2001,/elapsed/],
  ['clock mismatch',(r:ReturnType<typeof fixture>)=>r[10].fields.sample_elapsed_ms=800,/elapsed/],
  ['wrong coverage',(r:ReturnType<typeof fixture>)=>r[10].fields.coverage='requests_only',/coverage/],
  ['wrong uncovered paths',(r:ReturnType<typeof fixture>)=>r[10].fields.uncovered_paths='',/uncovered_paths/],
  ['version',(r:ReturnType<typeof fixture>)=>r[10].fields.version=2,/version/],
  ['extra field',(r:ReturnType<typeof fixture>)=>r[10].fields.tenant='no',/field set/],
  ['missing field',(r:ReturnType<typeof fixture>)=>delete r[10].fields.idle,/field set/],
  ['wrong type',(r:ReturnType<typeof fixture>)=>r[10].fields.in_use='24',/types/],
  ['negative counter',(r:ReturnType<typeof fixture>)=>r[10].fields.wait_count=-1,/types/],
  ['invalid histogram',(r:ReturnType<typeof fixture>)=>r[20].fields.wait_le_10000_us=2001,/histogram/],
  ['missing occupancy',(r:ReturnType<typeof fixture>)=>r[20].fields.occupancy_count=22,/Occupancy count/],
] as const)test('pool NOT EVALUATED: '+name,()=>{
  const rows=fixture();change(rows);const result=evaluate(rows);
  assert.match(result.reasons.join('; '),reason);assert.ok(poolRows(result).every(row=>row.status==='NOT EVALUATED'));
});
test('zero acquisitions is NOT EVALUATED',()=>assert.match(evaluate(fixture([])).reasons.join(),/Zero acquisitions/));
test('elapsed <=2s still requires >=99% expected samples',()=>{
  const rows=fixture();rows.forEach((row,i)=>{row.timestamp=new Date(from+i*1100).toISOString();row.fields.sample_elapsed_ms=1100;});
  assert.match(evaluate(rows).reasons.join(),/99%/);
});
for(const retention of [undefined,{...retained,complete:false,reason:'rotation loss'},{...retained,startedAt:from+1},{...retained,endedAt:to-1}])test('retention/capture loss is NOT EVALUATED: '+JSON.stringify(retention),()=>{
  const result=productionPoolEvidence(fixture().map(row=>JSON.stringify(row)),from,to,retention);
  assert.ok(result.reasons.length);assert.ok(poolRows(result).every(row=>row.status==='NOT EVALUATED'));
});
for(const [name,waits,active,budget] of [
  ['p95',[...Array(94).fill(10000),...Array(6).fill(50000)],undefined,'pool.p95'],
  ['p99',[...Array(98).fill(10000),...Array(2).fill(100000)],undefined,'pool.p99'],
  ['occupancy p95',undefined,()=>32,'pool.activeP95'],
  ['peak 33',undefined,(i:number)=>i===20?33:24,'pool.peak'],
] as const)test('pool budget FAIL: '+name,()=>{
  // idle is a nonnegative raw gauge even when a hypothetical cap is exceeded.
  const rows=fixture(waits,active);for(const row of rows)row.fields.idle=Math.max(0,Number(row.fields.idle));
  const result=evaluate(rows);assert.deepEqual(result.reasons,[]);assert.equal(poolRows(result).find(row=>row.budget===budget)?.status,'FAIL');
});
test('one timeout FAILs; all other error/cancellation deltas are reported',()=>{
  const rows=fixture();for(const name of ['timeout','closed','io','database','other','cancelled'])rows[20].fields['acquire_'+name]=1;
  const result=evaluate(rows);assert.equal(poolRows(result).find(row=>row.budget==='pool.timeouts')?.status,'FAIL');
  for(const name of ['closed','io','database','other','cancelled'])assert.equal(result.evidence['pool.acquire_'+name],1);
});
for(const event of ['measure_hold','measure_pool'])test('reject '+event,()=>assert.match(productionPoolEvidence([event,...fixture().map(row=>JSON.stringify(row))],from,to,retained).reasons.join(),/Rejected/));

test('restart before baseline cannot be hidden by boundary selection',()=>{
  const rows=fixture();const earlier=structuredClone(rows[0]);
  earlier.timestamp=new Date(from-1000).toISOString();earlier.fields.sample_sequence=100;
  rows.unshift(earlier);assert.match(evaluate(rows).reasons.join(),/restart/);
});
test('wall-clock reversal is not sorted away',()=>{
  const rows=fixture();rows[10].timestamp=rows[9].timestamp;
  assert.match(evaluate(rows).reasons.join(),/Non-monotonic.*timestamps/);
});
