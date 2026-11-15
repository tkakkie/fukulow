import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanup } from './runtime.ts';

for (const mode of ['absent','hang','failure','leak']) {
  test(`cleanup handles ${mode} with bounded verification`,async t=>{
    const dir = mkdtempSync(join(tmpdir(),'search-cleanup-'));
    const before = process.env.PATH;
    t.after(()=>{process.env.PATH=before;rmSync(dir,{recursive:true,force:true});});
    writeFileSync(join(dir,'docker'),`#!${process.execPath}
const mode = ${JSON.stringify(mode)};
if (mode === 'hang') setInterval(()=>{},1000);
if (mode === 'failure') process.exit(1);
if (mode === 'leak' && process.argv.includes('ls')) console.log('owned');
if (mode === 'absent' && !process.argv.includes('ls')) { console.error('No such container');process.exit(1); }
`,{mode:0o755});
    process.env.PATH=dir+':'+before;
    if (mode==='absent') await cleanup('disposable','disposable-data',2000);
    else await assert.rejects(()=>cleanup('disposable','disposable-data',100),/cleanup/);
  });
}

for (const mode of ['success','cleanup-error','finalize-error']) {
  test(`supervisor finalizes only after verified cleanup: ${mode}`,async t=>{
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { existsSync, readFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(),'search-supervisor-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    writeFileSync(join(dir,'docker'),`#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv[2]==='volume' && process.argv[3]==='ls') writeFileSync(${JSON.stringify(join(dir,'verified'))},'');
if (${JSON.stringify(mode)}==='cleanup-error') process.exit(1);
`,{mode:0o755});
    const fixture = join(dir,'fixture.mjs');
    writeFileSync(fixture,`import { supervise } from ${JSON.stringify(new URL('./runtime.ts',import.meta.url).href)};
import { existsSync, writeFileSync } from 'node:fs';
if (await supervise(import.meta.url,${JSON.stringify(dir)},'test-manifest',()=>{
  if (!existsSync(${JSON.stringify(join(dir,'verified'))})) throw Error('cleanup not finished');
  if (${JSON.stringify(mode)}==='finalize-error') throw Error('finalization failed');
  writeFileSync(${JSON.stringify(join(dir,'summary.json'))},'final');
}))
writeFileSync(${JSON.stringify(join(dir,'completed.json'))},JSON.stringify({manifestHash:'test-manifest'}));`);
    const child = spawn(process.execPath,[fixture],{env:{...process.env,PATH:dir+':'+process.env.PATH},stdio:'ignore'});
    assert.deepEqual(await once(child,'close'),[mode==='success'?0:1,null]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'run-status.json'),'utf8')),
      {manifestHash:'test-manifest',valid:mode==='success',cleanupVerified:mode!=='cleanup-error',exitCode:mode==='success'?0:1});
    assert.equal(existsSync(join(dir,'finished.json')),mode==='success');
    assert.equal(existsSync(join(dir,'summary.json')),mode==='success');
  });
}

for (const phase of ['rm','volume-rm','container-ls','volume-ls']) {
  for (const [signal,code] of [['SIGINT',130],['SIGTERM',143]] as const) {
    test(`${signal} during ${phase} invalidates otherwise successful cleanup`,{timeout:10000},async t=>{
      const { spawn } = await import('node:child_process');
      const { once } = await import('node:events');
      const { existsSync, readFileSync } = await import('node:fs');
      const { setTimeout: pause } = await import('node:timers/promises');
      const dir = mkdtempSync(join(tmpdir(),'search-cleanup-signal-'));
      t.after(()=>rmSync(dir,{recursive:true,force:true}));
      writeFileSync(join(dir,'docker'),`#!${process.execPath}
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const phase = args[0]==='rm' ? 'rm' : args.slice(0,2).join('-');
appendFileSync(${JSON.stringify(join(dir,'calls'))},phase+'\\n');
if (phase===${JSON.stringify(phase)}) {
  writeFileSync(${JSON.stringify(join(dir,'paused'))},'');
  const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(dir,'release'))})) clearInterval(timer);},10);
}
`,{mode:0o755});
      const fixture = join(dir,'fixture.mjs');
      writeFileSync(fixture,`import { supervise } from ${JSON.stringify(new URL('./runtime.ts',import.meta.url).href)};
import { writeFileSync } from 'node:fs';
if (await supervise(import.meta.url,${JSON.stringify(dir)},'test-manifest',()=>writeFileSync(${JSON.stringify(join(dir,'summary.json'))},'final')))
writeFileSync(${JSON.stringify(join(dir,'completed.json'))},JSON.stringify({manifestHash:'test-manifest'}));`);
      const child = spawn(process.execPath,[fixture],{env:{...process.env,PATH:dir+':'+process.env.PATH},stdio:'ignore'});
      const closed = once(child,'close');
      t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
      while (!existsSync(join(dir,'paused'))) { t.signal.throwIfAborted(); assert.equal(child.exitCode,null); await pause(10); }
      assert.equal(child.kill(signal),true);
      await pause(50);
      writeFileSync(join(dir,'release'),'');
      assert.deepEqual(await closed,[code,null]);
      assert.deepEqual(JSON.parse(readFileSync(join(dir,'run-status.json'),'utf8')),
        {manifestHash:'test-manifest',valid:false,cleanupVerified:true,exitCode:code});
      assert.equal(existsSync(join(dir,'finished.json')),false);
      assert.equal(existsSync(join(dir,'summary.json')),false);
      assert.deepEqual(readFileSync(join(dir,'calls'),'utf8').trim().split('\n'),['rm','volume-rm','container-ls','volume-ls']);
    });
  }
}

for (const phase of ['completion-read','status-write','finished-write','finalize','summary-write','final-status-write','after-supervise','before-exit']) {
  for (const [signal,code] of [['SIGINT',130],['SIGTERM',143]] as const) {
    test(`${signal} during synchronous ${phase} revokes publication`,{timeout:10000},async t=>{
      const { spawn } = await import('node:child_process');
      const { once } = await import('node:events');
      const { existsSync, readFileSync } = await import('node:fs');
      const { setTimeout: pause } = await import('node:timers/promises');
      const dir = mkdtempSync(join(tmpdir(),'search-publication-signal-'));
      t.after(()=>rmSync(dir,{recursive:true,force:true}));
      writeFileSync(join(dir,'docker'),`#!${process.execPath}\nprocess.exit(0);\n`,{mode:0o755});
      const fixture = join(dir,'fixture.mjs');
      writeFileSync(fixture,`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { supervise } from ${JSON.stringify(new URL('./runtime.ts',import.meta.url).href)};
const dir=${JSON.stringify(dir)}, phase=${JSON.stringify(phase)};
const read=fs.readFileSync, write=fs.writeFileSync;
let statusWrites=0;
function block(at) {
  if (process.env.SEARCH_WORKER==='1' || at!==phase) return;
  write(dir+'/paused','');
  while (!fs.existsSync(dir+'/release')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
}
fs.readFileSync=function(path,...args) {
  if (String(path)===dir+'/completed.json') block('completion-read');
  return read(path,...args);
};
fs.writeFileSync=function(path,...args) {
  const result=write(path,...args);
  if (String(path)===dir+'/run-status.json') block(++statusWrites===1?'status-write':'final-status-write');
  if (String(path)===dir+'/finished.json') block('finished-write');
  if (String(path)===dir+'/summary.json') block('summary-write');
  return result;
};
syncBuiltinESMExports();
if (await supervise(import.meta.url,dir,'test-manifest',()=>{
  block('finalize');
  fs.writeFileSync(dir+'/summary.json','final');
}))
fs.writeFileSync(dir+'/completed.json',JSON.stringify({manifestHash:'test-manifest'}));
block('after-supervise');
process.once('beforeExit',()=>block('before-exit'));`);
      const child = spawn(process.execPath,[fixture],{env:{...process.env,PATH:dir+':'+process.env.PATH},stdio:'ignore'});
      const closed = once(child,'close');
      t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
      while (!existsSync(join(dir,'paused'))) { t.signal.throwIfAborted(); assert.equal(child.exitCode,null); await pause(10); }
      assert.equal(child.kill(signal),true);
      await pause(50);
      writeFileSync(join(dir,'release'),'');
      assert.deepEqual(await closed,[code,null]);
      assert.deepEqual(JSON.parse(readFileSync(join(dir,'run-status.json'),'utf8')),
        {manifestHash:'test-manifest',valid:false,cleanupVerified:true,exitCode:code});
      assert.equal(existsSync(join(dir,'finished.json')),false);
      assert.equal(existsSync(join(dir,'summary.json')),false);
    });
  }
}
