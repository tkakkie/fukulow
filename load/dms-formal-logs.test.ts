import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {captureAppLogs} from './dms-formal-logs.ts';
for(const limit of [1024,1])test('live stderr capture is bounded and declares overflow '+limit,async t=>{
  const path=mkdtempSync(tmpdir()+'/dm-log-');t.after(()=>rmSync(path,{recursive:true,force:true}));
  const stop=captureAppLogs(path,['-e',"process.stderr.write('pool_stats fixture\\n');setInterval(()=>{},1000)"],limit,process.execPath);
  await delay(200);const record=await stop();
  assert.equal(record.complete,limit===1024);assert.ok(readFileSync(path+'/app.log').length<=limit);
  assert.equal(JSON.parse(readFileSync(path+'/app-log-retention.json','utf8')).complete,record.complete);
});
test('early log reader exit cannot be complete',async t=>{
  const path=mkdtempSync(tmpdir()+'/dm-log-');t.after(()=>rmSync(path,{recursive:true,force:true}));
  const stop=captureAppLogs(path,['-e','process.exit(0)'],1024,process.execPath);
  await delay(200);assert.equal((await stop()).complete,false);
});
