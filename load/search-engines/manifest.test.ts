import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hash, snapshot, verifyManifest, verifyRuntime, extensions, packages, settings } from './manifest.ts';
import { boundedCommand } from './bench.ts';

const frozen = snapshot();
const document = {sha256:hash(JSON.stringify(frozen)),frozen};
test('checked-in manifest matches the evaluation inputs',()=>{
  assert.equal(verifyManifest(JSON.parse(readFileSync('load/search-engines/manifest-v1.json','utf8'))),document.sha256);
});
test('manifest content tampering is refused',()=>{
  assert.throws(()=>verifyManifest({...document,sha256:'changed'}),/content hash mismatch/);
});
for (const field of ['generator','sourceHashes','quality','performance','timing','image','settings','shmBytes'] as const) {
  test(`changed ${field} is refused before a run`,()=>{
    const actual = structuredClone(frozen);
    Object.assign(actual,{[field]:'changed'});
    assert.throws(()=>verifyManifest(document,actual),/manifest mismatch/);
  });
}
for (const [name,value] of [['SEARCH_ROWS','1000'],['SEARCH_TRANSACTIONS','1']]) {
  test(`${name} override is refused`,t=>{
    const before = process.env[name]; process.env[name]=value;
    t.after(()=>{if (before===undefined) delete process.env[name]; else process.env[name]=before;});
    assert.throws(()=>verifyManifest(document),/differs from frozen/);
  });
}
for (const mismatch of ['none','postgres','extensions','settings','packages']) {
  test(`runtime ${mismatch} verification`,()=>{
    const sql = (text: string)=>text.includes('server_version_num') ? (mismatch==='postgres'?'180005':'180006') :
      JSON.stringify(text.includes('pg_available_extensions') ? (mismatch==='extensions'?{}:extensions) : (mismatch==='settings'?{}:settings));
    const docker = ()=>mismatch==='packages'?'changed|version':Object.entries(packages).map(p=>p.join('|')).join('\n');
    if (mismatch==='none') verifyRuntime(sql,docker,'disposable');
    else assert.throws(()=>verifyRuntime(sql,docker,'disposable'),/Frozen/);
  });
}
test('a hung client is killed with a bounded, redacted error',()=>{
  const start = Date.now();
  assert.throws(()=>boundedCommand(process.execPath,['-e','setInterval(()=>{},1000)'],50),/timed out \(50 ms limit\)/);
  assert.ok(Date.now()-start<3000);
});
test('client exceptions omit stdout, stderr and input',()=>{
  assert.throws(()=>boundedCommand(process.execPath,['-e',"console.error('private-value');process.exit(1)"],1000,'private-input'),error=>{
    assert.doesNotMatch(String(error),/private-value|private-input/);return true;
  });
});

test('an unavailable command fails without leaking the input',()=>{
  assert.throws(()=>boundedCommand('/nonexistent-search-test-command',[],50,'private-input'),/failed/);
});
