import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';

const runners = ['./run.ts','./quality/run.ts'];
const version = readFileSync(new URL('../../.node-version',import.meta.url),'utf8').trim();

function start(t: TestContext, runnerPath: string, mode: string, existing = false) {
  const runner = new URL(runnerPath,import.meta.url).href;
  const dir = mkdtempSync(join(tmpdir(),'search-lifecycle-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const log = join(dir,'docker.jsonl');
  const out = join(dir,'results');
  writeFileSync(join(dir,'docker'),`#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG,JSON.stringify(args)+'\\n');
const state = process.env.STUB_LOG+'.state';
if (args[0] === 'run') {
  if (process.env.STUB_MODE !== 'absent') writeFileSync(state,'owned');
  if (!['signal','hang','mismatch'].includes(process.env.STUB_MODE)) process.exit(42);
}
if (args[0] === 'exec' && process.env.STUB_MODE === 'mismatch' && args.includes('psql')) {
  let input='';for await (const chunk of process.stdin) input+=chunk;
  console.log(input.includes('server_version_num')?'180005':'1');
}
if (args[0] === 'exec' && process.env.STUB_MODE === 'hang') setInterval(()=>{},1000);
if (args[0] === 'rm') {
  if (process.env.STUB_MODE !== 'leak') rmSync(state,{force:true});
}
if (args[0] === 'container' && args[1] === 'ls' && existsSync(state)) console.log('owned');
`,{mode:0o755});
  if (existing) {
    // A retained artifact must survive refusal byte-for-byte.
    mkdirSync(out);
    writeFileSync(join(out,'metadata.json'),'retained artifact\n');
  }
  const child = spawn(process.execPath,['--input-type=module','-e',
    // Exercise the real entrypoint even when the test host lacks pinned Node.
    `Object.defineProperty(process,'version',{value:${JSON.stringify('v'+version)}}); await import(${JSON.stringify(runner)});`],{
    cwd:fileURLToPath(new URL('../..',import.meta.url)),
    env:{...process.env,PATH:dir+':'+process.env.PATH,SEARCH_RESULT_DIR:out,
      SEARCH_QUALITY_DIR:out,SEARCH_SKIP_BUILD:'1',STUB_LOG:log,STUB_MODE:mode},
    stdio:['ignore','ignore','pipe'],
  });
  let stderr = '';
  child.stderr.on('data',data=>{ stderr+=String(data); });
  const closed = once(child,'close');
  t.after(()=>{ if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const calls = (): string[][] => existsSync(log) ? readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s)) : [];
  return {child,closed,calls,out,stderr:()=>stderr};
}

function assertCleanup(calls: string[][]) {
  const run = calls.find(args=>args[0]==='run');
  assert.ok(run,'container creation was attempted');
  const name = run[run.indexOf('--name')+1];
  assert.match(name,/^fukulow-search-153-/);
  // The named volume is independently removed and both resources are checked.
  assert.deepEqual(calls.filter(args=>args[0]==='rm'),[['rm','-fv',name]]);
  assert.ok(calls.some(args=>args[0]==='volume' && args[1]==='rm' && args.at(-1)===`${name}-data`));
  assert.equal(calls.filter(args=>args[1]==='ls').length,2);
}

for (const runner of runners) {
  for (const mode of ['partial','absent','leak','mismatch']) {
    test(`${runner}: startup failure cleans up once, including ${mode} container`,{timeout:10000},async t=>{
      const run = start(t,runner,mode);
      assert.deepEqual(await run.closed,[1,null]);
      assert.match(run.stderr(),mode==='mismatch'?/Frozen PostgreSQL version mismatch/:/docker run failed/);
      if (mode==='leak') assert.match(run.stderr(),/cleanup verification found/);
      assertCleanup(run.calls());
      const status = JSON.parse(readFileSync(join(run.out,'run-status.json'),'utf8'));
      assert.equal(status.valid,false);
      assert.equal(status.cleanupVerified,mode!=='leak');
    });
  }

  for (const [signal,code] of [['SIGINT',130],['SIGTERM',143]] as const) {
    test(`${runner}: ${signal} cleans up and exits ${code}`,{timeout:10000},async t=>{
      const run = start(t,runner,'hang');
      // The fake Docker client hangs inside a synchronous readiness call.
      while (!run.calls().some(args=>args[0]==='exec')) {
        t.signal.throwIfAborted();
        assert.equal(run.child.exitCode,null,run.stderr());
        await setTimeout(10);
      }
      assert.equal(run.child.kill(signal),true);
      assert.deepEqual(await run.closed,[code,null]);
      assertCleanup(run.calls());
      assert.deepEqual(JSON.parse(readFileSync(join(run.out,'run-status.json'),'utf8')),{valid:false,cleanupVerified:true,exitCode:code});
    });
  }

  test(`${runner}: existing output is rejected before Docker or artifact writes`,{timeout:10000},async t=>{
    const run = start(t,runner,'partial',true);
    const before = readdirSync(run.out).sort();
    assert.deepEqual(await run.closed,[1,null]);
    assert.match(run.stderr(),/EEXIST/);
    assert.deepEqual(run.calls(),[]);
    assert.deepEqual(readdirSync(run.out).sort(),before);
    assert.equal(readFileSync(join(run.out,'metadata.json'),'utf8'),'retained artifact\n');
  });
}
