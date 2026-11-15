import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hash } from './manifest.ts';
import { summarize } from './summarize.ts';

for (const mode of ['success','tampered','missing-status','failed-cleanup','invalid-status','wrong-status-hash','missing-completed','missing-finished','wrong-completion-hash']) {
  test(`summary requires verified frozen completion: ${mode}`,t=>{
    const dir = mkdtempSync(join(tmpdir(),'search-summary-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const frozen = {performance:{clients:5}};
    const manifestHash = hash(JSON.stringify(frozen));
    if (mode==='tampered') frozen.performance.clients=99;
    const save = (name: string,value: unknown)=>writeFileSync(join(dir,name+'.json'),JSON.stringify(value));
    save('manifest',{sha256:manifestHash,frozen});
    const runs = [1,2,3].flatMap(round=>['none','trgm','bigm','pgroonga'].map(engine=>({manifestHash,round,engine,
      buildMs:1,relationBytes:1,physicalDeltaBytes:1,walBytesPerInsert:1,write:{p50:1,p95:1,p99:1,tps:1}})));
    save('results',runs);
    if(mode!=='missing-status') save('run-status',{manifestHash:mode==='wrong-status-hash'?'wrong':manifestHash,
      valid:mode!=='invalid-status',cleanupVerified:mode!=='failed-cleanup',exitCode:0});
    for (const name of ['completed','finished']) {
      if(mode!==`missing-${name}`)save(name,{manifestHash:mode==='wrong-completion-hash'?'wrong':manifestHash,results:12});
    }
    if(mode==='success') {
      summarize(dir);
      assert.equal(JSON.parse(readFileSync(join(dir,'summary.json'),'utf8')).length,4);
    } else {
      assert.throws(()=>summarize(dir));
      assert.equal(existsSync(join(dir,'summary.json')),false);
    }
  });
}
