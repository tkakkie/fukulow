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
import { manifestFile } from './manifest.ts';

const runners = ['./run.ts','./quality/run.ts'];
const manifest = JSON.parse(readFileSync(new URL(`../../${manifestFile}`,import.meta.url),'utf8'));
const manifestHash = manifest.sha256;
// A fresh build has a different identity even when its runtime matches.
const imageId = 'sha256:'+'b'.repeat(64);
const version = readFileSync(new URL('../../.node-version',import.meta.url),'utf8').trim();

// The stub may still be appending while a test polls; only a final record without its
// newline is "not yet written". Once the child has exited every record must be complete.
function parseStubLog(text: string, polling: boolean): string[][] {
  const lines = text.split('\n');
  const tail = lines.pop();
  if (tail !== '' && !polling) throw new Error(`incomplete stub log record: ${tail}`);
  return lines.map(s=>JSON.parse(s));
}

test('stub log parsing skips only an unterminated record while polling',()=>{
  assert.deepEqual(parseStubLog('["run"]\n["exec"',true),[['run']]);
  assert.throws(()=>parseStubLog('["run"]\n["exec"',false),/incomplete stub log record/);
  assert.throws(()=>parseStubLog('["run"]\n["ex\n',true),SyntaxError);
  assert.deepEqual(parseStubLog('',false),[]);
});

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
if (args[1] === 'ls' && args.includes('--format') && process.env.STUB_MODE.startsWith('orphan-')) {
 console.log(process.env.STUB_MODE==='orphan-label'?'another-name|153':'fukulow-search-153-old|');
}
if (args[0] === 'image') console.log(process.env.STUB_MODE==='invalid-image'?'sha256:changed':${JSON.stringify(imageId)});
if (args[0] === 'run') {
  if (process.env.STUB_MODE !== 'absent') writeFileSync(state,'owned');
  if (!['signal','hang','mismatch','planner-owner','planner-app'].includes(process.env.STUB_MODE)) process.exit(42);
}
if (args[0] === 'exec' && process.env.STUB_MODE === 'mismatch' && args.includes('psql')) {
  let input='';for await (const chunk of process.stdin) input+=chunk;
  console.log(input.includes('server_version_num')?'180005':'1');
}
if (args[0] === 'exec' && process.env.STUB_MODE.startsWith('planner-')) {
  if (args.includes('dpkg-query')) console.log(${JSON.stringify(Object.entries(manifest.frozen.image.packages).map(p=>p.join('|')).join('\n'))});
  if (args.includes('psql')) {
    let input='';for await (const chunk of process.stdin) input+=chunk;
    if (input.includes('INSERT INTO messages') || input.includes('COPY messages')) appendFileSync(process.env.STUB_LOG,JSON.stringify(['unexpected-load'])+'\\n');
    if (input.includes('SELECT 1;')) console.log('1');
    else if (input.includes('server_version_num')) console.log('180006');
    else if (input.includes('SHOW shared_preload_libraries')) console.log(${JSON.stringify(manifest.frozen.settings.shared_preload_libraries)});
    else if (input.includes('pg_available_extensions')) console.log(${JSON.stringify(JSON.stringify(manifest.frozen.image.extensions))});
    else if (input.includes('count(*) FROM pg_settings')) {
      // Model an image PGOPTIONS default or an app-role-specific default.
      const changed=process.env.STUB_MODE==='planner-owner' || args.includes('fukulow_app');
      console.log(changed?'1':'0');
    } else if (input.includes("'row_security'") && args.includes('fukulow_app')) console.log(${JSON.stringify(JSON.stringify(manifest.frozen.sessionPolicy.appSettings))});
    else if (input.includes('pg_settings')) console.log(input.includes("'row_security'")?${JSON.stringify(JSON.stringify(manifest.frozen.sessionPolicy.settings))}:${JSON.stringify(JSON.stringify(manifest.frozen.settings))});
  }
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
  const calls = (polling = false): string[][] => existsSync(log) ? parseStubLog(readFileSync(log,'utf8'),polling) : [];
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
  assert.equal(calls.filter(args=>args[1]==='ls' && args.includes('--filter')).length,2);
}

for (const runner of runners) {
  for (const mode of ['orphan-prefix','orphan-label']) {
    test(`${runner}: ${mode} refuses startup and lists resources without deleting`,{timeout:10000},async t=>{
      const run = start(t,runner,mode);
      assert.deepEqual(await run.closed,[1,null]);
      assert.match(run.stderr(),/Invalid run: earlier harness resources exist:/);
      assert.match(run.stderr(),mode==='orphan-label'?/another-name/:/fukulow-search-153-old/);
      assert.match(run.stderr(),/cleanup.ts --remove/);
      assert.ok(run.calls().every(args=>args[1]==='ls'));
      assert.equal(existsSync(run.out),false);
    });
  }
  for (const mode of ['partial','absent','leak','mismatch']) {
    test(`${runner}: startup failure cleans up once, including ${mode} container`,{timeout:10000},async t=>{
      const run = start(t,runner,mode);
      assert.deepEqual(await run.closed,[1,null]);
      assert.match(run.stderr(),mode==='mismatch'?/Frozen PostgreSQL version mismatch/:/docker run failed/);
      if (mode==='leak') assert.match(run.stderr(),/cleanup verification found/);
      assertCleanup(run.calls());
      const status = JSON.parse(readFileSync(join(run.out,'run-status.json'),'utf8'));
      assert.deepEqual(status.image,{id:imageId,reused:true});
      assert.equal(status.valid,false);
      assert.equal(status.cleanupVerified,mode!=='leak');
    });
  }

  for (const [signal,code] of [['SIGINT',130],['SIGTERM',143]] as const) {
    test(`${runner}: ${signal} cleans up and exits ${code}`,{timeout:10000},async t=>{
      const run = start(t,runner,'hang');
      // The fake Docker client hangs inside a synchronous readiness call.
      while (!run.calls(true).some(args=>args[0]==='exec')) {
        t.signal.throwIfAborted();
        assert.equal(run.child.exitCode,null,run.stderr());
        await setTimeout(10);
      }
      assert.equal(run.child.kill(signal),true);
      assert.deepEqual(await run.closed,[code,null]);
      assertCleanup(run.calls());
      assert.deepEqual(JSON.parse(readFileSync(join(run.out,'run-status.json'),'utf8')),{manifestHash,image:{id:imageId,reused:true},valid:false,cleanupVerified:true,exitCode:code});
    });
  }

  for (const mode of ['invalid-image','planner-owner','planner-app']) {
    test(`${runner}: ${mode} refuses drift before corpus loading`,{timeout:10000},async t=>{
      const run = start(t,runner,mode);
      assert.deepEqual(await run.closed,[1,null]);
      assert.match(run.stderr(),mode==='invalid-image'?/Invalid image identity/:/Frozen planner defaults mismatch/);
      assert.equal(run.calls().some(args=>args[0]==='cp' || args[0]==='unexpected-load'),false);
      if(mode==='invalid-image') assert.equal(run.calls().some(args=>args[0]==='run'),false);
      else assertCleanup(run.calls());
      const status = JSON.parse(readFileSync(join(run.out,'run-status.json'),'utf8'));
      assert.equal(status.valid,false);
      assert.equal(status.manifestHash,manifestHash);
      assert.equal(existsSync(join(run.out,'finished.json')),false);
      assert.equal(existsSync(join(run.out,'summary.json')),false);
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
