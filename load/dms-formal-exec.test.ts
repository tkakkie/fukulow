import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checked, execute } from './dms-formal-exec.ts';
import { temporary } from './dms-formal-run-fixture.ts';

test('executor retains nonzero exit and kills a hung child at its deadline',async()=>{
  assert.equal((await execute({program:process.execPath,args:['-e','process.exit(17)'],timeout:1000})).code,17);
  await assert.rejects(checked(execute,{program:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeout:20}),/timeout/);
});
test('deadline kills descendants holding inherited pipes and reaps leader',async()=>{
  const start=Date.now();
  await assert.rejects(execute({program:process.execPath,args:['-e',`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)`],timeout:100}),/timeout/);
  assert.ok(Date.now()-start<1000);
});

for(const code of [0,17])test('executor records flushed generator log bytes, exit '+code,async t=>{
  const path=temporary(t)+'/run.log';
  const result=await execute({program:process.execPath,args:['-e',"process.stdout.write('日本語');process.stderr.write('stderr');process.exitCode="+code],log:path});
  assert.equal(result.code,code);
  const manifest=JSON.parse(readFileSync(path+'-retention.json','utf8'));
  assert.equal(manifest.complete,true);
  assert.equal(manifest.bytes,Buffer.byteLength('日本語stderr'));
  assert.equal(manifest.bytes,readFileSync(path).length);
});
test('executor marks timed out log capture incomplete',async t=>{
  const path=temporary(t)+'/run.log';
  await assert.rejects(execute({program:process.execPath,args:['-e',"process.stdout.write('partial');setInterval(()=>{},1000)"],timeout:500,log:path}),/timeout/);
  const manifest=JSON.parse(readFileSync(path+'-retention.json','utf8'));
  assert.equal(manifest.complete,false);
  assert.equal(manifest.bytes,readFileSync(path).length);
});

test('executor writes a redacted log only, never the raw cp output with home paths',async t=>{
  const path=temporary(t)+'/transfer.log';
  const redactLog=(text:string)=>text.replace(/\/Users\/[^/\s]+/g,'/Users/[user]');
  await assert.rejects(checked(execute,{program:'sh',args:['-c',"echo 'cp: /Users/someone/runs/out/formal: Permission denied' >&2; echo out /Users/someone/x; exit 1"],timeout:5000,log:path,redactLog}),/sh failed/);
  const saved=readFileSync(path,'utf8');
  assert.ok(!saved.includes('someone'),saved);
  assert.match(saved,/cp: \/Users\/\[user\]\/runs\/out\/formal: Permission denied/);
  const manifest=JSON.parse(readFileSync(path+'-retention.json','utf8'));
  assert.deepEqual([manifest.complete,manifest.redacted,manifest.bytes>0],[true,true,true]);
});
