import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { execute } from './dms-formal-exec.ts';
import { stopRecordedGroups } from './dms-formal-groups.ts';
const executor=new URL('./dms-formal-exec.ts',import.meta.url).href;
const groups=new URL('./dms-formal-groups.ts',import.meta.url).href;
async function waitFile(file:string) {
  const until=Date.now()+5000;
  while(!existsSync(file)) {if(Date.now()>until)throw new Error('Child did not start');await delay(10);}
  return Number(readFileSync(file,'utf8'));
}
async function absent(pid:number) {
  const until=Date.now()+5000;
  for(;;) {
    try {process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error;}
    if(Date.now()>until)assert.fail(`Owned process ${pid} still exists`);
    await delay(10);
  }
}
for(const scenario of ['nested executor timeout','worker killed before cleanup'])test(`${scenario} leaves no owned processes`,async t=>{
  const path=mkdtempSync(`${tmpdir()}/dm-groups-`);t.after(()=>rmSync(path,{recursive:true,force:true}));
  const leaf=`require('node:fs').writeFileSync(${JSON.stringify(path+'/leaf')},String(process.pid));setInterval(()=>{},1000)`;
  const worker=`import {execute} from ${JSON.stringify(executor)};import {currentGroup} from ${JSON.stringify(groups)};import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(path+'/group')},String(currentGroup()));writeFileSync(${JSON.stringify(path+'/worker-1.pid')},String(currentGroup()));await execute({program:process.execPath,args:['-e',${JSON.stringify(leaf)}],timeout:30000});`;
  if(scenario==='nested executor timeout') {
    const run=execute({program:process.execPath,args:['--input-type=module','-e',worker],timeout:1000});
    const rejected=assert.rejects(run,/timeout/);
    const pid=await waitFile(path+'/leaf'),group=await waitFile(path+'/group');
    t.after(()=>{try{process.kill(-group,'SIGKILL');}catch{}});
    await rejected;await absent(pid);await absent(group);
  } else {
    // Reproduce remote timeout's group ownership without contacting any host.
    const child=spawn('sh',['-c','export DM_FORMAL_OWNED_GROUP=$$; exec "$@"','worker',process.execPath,'--input-type=module','-e',worker],{detached:true,stdio:'ignore'});
    const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    t.after(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}});
    const pid=await waitFile(path+'/leaf'),group=await waitFile(path+'/group');
    child.kill('SIGKILL');await exited;
    assert.doesNotThrow(()=>process.kill(pid,0));
    // Persisted group works independently of the now-absent worker PID.
    await stopRecordedGroups(path);assert.equal(existsSync(path+'/worker-1.pid'),false);await absent(pid);await absent(child.pid!);
  }
});
test('invalid ownership record fails cleanup and remains available for diagnosis',async t=>{
  const path=mkdtempSync(`${tmpdir()}/dm-groups-invalid-`);t.after(()=>rmSync(path,{recursive:true,force:true}));
  const {writeFileSync}=await import('node:fs');
  writeFileSync(path+'/worker-1.pid','invalid');
  await assert.rejects(stopRecordedGroups(path),/Invalid owned process group/);
  assert.equal(existsSync(path+'/worker-1.pid'),true);
});
