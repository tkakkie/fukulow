import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from './database.ts';

test('partial Docker start attempts both owned removals and preserves original failure',()=>{
  const calls:string[][]=[];const original=new Error('container created but start failed');
  const db=new Database((...args:string[])=>{
    calls.push(args);if(args[0]==='run')throw original;
    if(args[0]==='rm')throw new Error('container removal failed');return '';
  });
  assert.throws(()=>db.start(),error=>error===original);
  const old=console.error;console.error=()=>{};
  try {assert.doesNotThrow(()=>db.cleanup(original));} finally {console.error=old;}
  assert.deepEqual(calls.slice(-2),[['rm','-f',db.name],['volume','rm',db.volume]]);
});

import { captureWalDump, parseWalDump, settleFixture, statsSnapshot } from './diagnostics.ts';
import { parseOptions, fixtureCondition } from './options.ts';
import { scenarios } from './measure.ts';
const dump=`WAL statistics between 0/100 and 0/200:
Type N (%) Record size (%) FPI size (%) Combined size (%)
Heap/INSERT 2 (50.00) 100 (50.00) 8000 (100.00) 8100 (98.78)
Heap/UPDATE 1 (25.00) 50 (25.00) 0 (0.00) 50 (0.61)
Transaction/COMMIT 1 (25.00) 50 (25.00) 0 (0.00) 50 (0.61)
Total 4 200 [2.44%] 8000 [97.56%] 8200 [100%]`;
test('diagnose is bounded, has 60 samples and uses the requested existing scenarios',()=>{
  const options=parseOptions(['--diagnose']);
  assert.deepEqual(options.rates,[50,250]);assert.equal(options.rounds,3);assert.equal(options.seconds,30);
  assert.equal(options.clients,16);assert.equal(options.settleFixture,false);
  assert.equal(scenarios.filter(s=>['create-1-17','mixed90-200-4000'].includes(s.name)).length,2);
  assert.equal(2*options.rates.length*options.rounds*5,60);
  for(const args of [[],['--smoke','--diagnose'],['--full','--diagnose'],['--diagnose','--rates','50'],['--diagnose','--seconds','1'],['--smoke','--clients','4'],['--diagnose','--out'],['--diagnose','--wat']])assert.throws(()=>parseOptions(args));
});
test('settle-fixture is opt-in, metadata and conditions retain it in every mode',()=>{
  for(const mode of ['--smoke','--full','--diagnose']) {
    const off=parseOptions([mode]),on=parseOptions([mode,'--settle-fixture','--out','/private/tmp/i160-options-test']);
    assert.equal(off.settleFixture,false);assert.equal(on.settleFixture,true);
    assert.deepEqual(fixtureCondition(off.settleFixture),{});
    assert.deepEqual(JSON.parse(JSON.stringify({configOptions:on})).configOptions.settleFixture,true);
    assert.deepEqual(JSON.parse(JSON.stringify({conditions:fixtureCondition(on.settleFixture)})).conditions,{settleFixture:true});
  }
  const full=parseOptions(['--full']);assert.deepEqual(full.rates,[50,250,1000]);
  assert.equal(full.seconds,30);assert.equal(full.maxSeconds,15);assert.equal(full.rounds,3);
  const smoke=parseOptions(['--smoke']);assert.deepEqual(smoke.rates,[20]);assert.equal(smoke.seconds,1);assert.equal(smoke.clients,2);
});
test('pg_waldump record sizes aggregate by resource manager and preserve FPI cost separately',()=>{
  const parsed=parseWalDump(dump);
  assert.deepEqual(parsed.total,{records:4,recordBytes:200,fpiBytes:8000,bytes:8200});
  assert.equal(parsed.byResourceManager.Heap.bytes,8150);
  assert.equal(parsed.byRecord['Heap/INSERT'].fpiBytes,8000);
  assert.throws(()=>parseWalDump(''),/incomplete/);
  assert.throws(()=>parseWalDump(dump.replace('Total 4','Total 5')),/incomplete/);
});
test('pg_waldump unavailable or recycled range is explicit, retained, and nonfatal',()=>{
  const db=new Database();db.sql=()=>'/var/lib/postgresql/18/docker';
  for(const reason of ['pg_waldump: not found','requested WAL segment has already been removed']) {
    let saved='';const calls:string[][]=[];
    const result=captureWalDump(db,'0/100','0/200','/private/tmp/sample',(...args)=>{
      calls.push(args);if(args.includes('pg_config'))return '/usr/lib/postgresql/18/bin';
      throw Object.assign(new Error(reason),{stdout:'partial statistics',stderr:reason});
    },(_path,data)=>{saved=String(data);});
    assert.equal(result.status,'unavailable');if(result.status==='unavailable')assert.match(result.reason,new RegExp(reason));
    assert.match(saved,/partial statistics/);assert.match(saved,/UNAVAILABLE/);
    assert.ok(calls[1].includes('--stats=record'));assert.ok(calls[1].includes('0/100'));assert.ok(calls[1].includes('0/200'));
  }
  let raw='';
  const result=captureWalDump(db,'0/100','0/200','/private/tmp/sample',(...args)=>args.includes('pg_config')?'/usr/lib/postgresql/18/bin\n':dump+'\npg_waldump: first record is after 0/100',(_path,data)=>{raw=String(data);});
  assert.equal(result.status,'available');assert.equal(result.binary,'/usr/lib/postgresql/18/bin/pg_waldump');
  assert.match(raw,/first record is after/);
  const malformed=captureWalDump(db,'0/100','0/200','/private/tmp/sample',(...args)=>args.includes('pg_config')?'/usr/lib/postgresql/18/bin':'partial statistics',()=>{});
  assert.equal(malformed.status,'unavailable');
});
test('settling vacuums every fixture table outside a transaction, snapshots do not read fixture rows',()=>{
  const sql:string[]=[];const db=new Database();db.sql=query=>{sql.push(query);return query.includes('json_agg(format') ? '["public.messages","public.expected_operations"]' : '{}';};
  settleFixture(db);statsSnapshot(db);
  assert.equal(sql[1],'VACUUM (FREEZE, ANALYZE) public.messages, public.expected_operations;');assert.doesNotMatch(sql[1],/BEGIN/);
  for(const view of ['pg_stat_wal','pg_stat_checkpointer','pg_stat_user_tables','pg_stat_activity','pg_stat_progress_vacuum'])assert.match(sql[2],new RegExp(view));
  assert.doesNotMatch(sql[2],/FROM messages|pg_stat_reset/);
});
