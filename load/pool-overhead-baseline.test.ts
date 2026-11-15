import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { baselinePaths, baselineSource } from './pool-overhead-baseline.ts';
const root=resolve(import.meta.dirname,'..');
test('baseline applies to HEAD and changes only the exact instrumentation hunks',()=>{
  const dir=mkdtempSync('/private/tmp/pool-baseline-test-');
  const git=(args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8'});
  try {
    execFileSync('git',['worktree','add','--detach',dir,'HEAD'],{cwd:root});
    const patch=root+'/load/pool-overhead-baseline.patch';
    git(['apply','--check',patch]);git(['apply',patch]);
    assert.equal(git(['diff','--summary']),'');
    assert.deepEqual(git(['diff','--name-only']).trim().split('\n').sort(),[...baselinePaths].sort());
    for(const path of baselinePaths)assert.equal(readFileSync(dir+'/'+path,'utf8'),baselineSource(path,git(['show','HEAD:'+path])));
    // Exact resulting sources forbid additional SQL, timeout, pool-option, DM or caller changes.
    assert.throws(()=>baselineSource('server/src/database/pool.rs',''),/allowlist/);
  } finally {execFileSync('git',['worktree','remove','--force',dir],{cwd:root});rmSync(dir,{recursive:true,force:true});}
});
