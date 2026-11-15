import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanup } from './runtime.ts';

for (const mode of ['absent','hang','failure','leak']) {
  test(`cleanup handles ${mode} with bounded verification`,t=>{
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
    if (mode==='absent') cleanup('disposable','disposable-data',2000);
    else assert.throws(()=>cleanup('disposable','disposable-data',100),/cleanup/);
  });
}

test('successful supervised worker records verified cleanup and valid results',async t=>{
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(),'search-supervisor-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'docker'),`#!${process.execPath}\n`,{mode:0o755});
  const fixture = join(dir,'fixture.mjs');
  writeFileSync(fixture,`import { supervise } from ${JSON.stringify(new URL('./runtime.ts',import.meta.url).href)};
await supervise(import.meta.url,${JSON.stringify(dir)});`);
  const child = spawn(process.execPath,[fixture],{env:{...process.env,PATH:dir+':'+process.env.PATH},stdio:'ignore'});
  assert.deepEqual(await once(child,'close'),[0,null]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'run-status.json'),'utf8')),{valid:true,cleanupVerified:true,exitCode:0});
});
