import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checked, execute } from './dms-formal-exec.ts';
import { temporary } from './dms-formal-run-fixture.ts';

test('preliminary summary preserves aggregate with old and tagged round fixtures',async t=>{
  for(const tagged of [false,true]) {
    const path=temporary(t);mkdirSync(path+'/shard-0');
    writeFileSync(path+'/shard-0/metrics.json',JSON.stringify({type:'Point',metric:'dm_round_ms',data:{time:new Date().toISOString(),value:42,tags:tagged?{attempts:'5'}:{}}})+'\n');
    await checked(execute,{program:'env',args:['DM_SHARDS=1',process.execPath,resolve(import.meta.dirname,'dms-summary.ts'),path],timeout:10000});
    const summary=JSON.parse(readFileSync(path+'/combined.json','utf8'));
    assert.equal(summary.latencies.dm_round_ms.p99,42);
    if(tagged)assert.equal(summary.latencies['dm_round_ms:attempts=5'].p99,42);
  }
});
