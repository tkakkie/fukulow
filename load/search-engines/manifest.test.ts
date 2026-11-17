import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hash, snapshot, verifyManifest, verifyRuntime, extensions, packages, settings, resolveImage, postgresArguments, verifySession, sessionSettings, appSessionSettings, runKind, manifestFile } from './manifest.ts';
import { boundedCommand } from './bench.ts';

const frozen = snapshot();
const document = {sha256:hash(JSON.stringify(frozen)),frozen};
const recorded = (version: number) => JSON.parse(readFileSync(new URL(`./manifest-v${version}.json`,import.meta.url),'utf8'));
test('checked-in current manifest matches the evaluation inputs',()=>{
  assert.equal(manifestFile,'load/search-engines/manifest-v2.json');
  assert.equal(verifyManifest(recorded(2)),document.sha256);
});
test('manifest v1 stays as recorded for the 2026-11-17 results',()=>{
  const v1 = recorded(1);
  assert.equal(v1.sha256,'19927163c604379ea19f48402e9a7f5d67263472159bc3e0a1f2a53c60f4537b');
  assert.equal(hash(JSON.stringify(v1.frozen)),v1.sha256);
});
test('v2 changes only the query path and sources; performance conditions equal v1',()=>{
  const strip = ({version,date,sourceHashes,queryPath,...rest}: Record<string,unknown>) => rest;
  assert.deepEqual(strip(frozen),strip(recorded(1).frozen));
  assert.deepEqual([frozen.version,frozen.date],[2,'2026-11-17']);
  assert.ok(frozen.sourceHashes.some(s=>s.path==='load/search-engines/definer.sql'));
});
test('queryPath carries no planner or executor setting beyond the query-path need',()=>{
  assert.deepEqual(Object.keys(frozen.queryPath.functionSettings).sort(),['plan_cache_mode','search_path']);
  // Every key is reviewed: a new field (e.g. settings:{jit:'off'}) fails here.
  const keys = (value: unknown, prefix = ''): string[] => value && typeof value==='object'
    ? Object.entries(value).flatMap(([k,v])=>[prefix+k,...keys(v,prefix+k+'.')]) : [];
  assert.deepEqual(keys(frozen.queryPath).sort(),['caller','completeness','emptyQuery','function','functionSettings',
    'functionSettings.plan_cache_mode','functionSettings.search_path','kind','organization','owner','pageSize','planCacheReason',
    'plans','plans.app','plans.body','plans.direct','plans.owner','plans.ownerV1','source']);
  const names = Object.keys(settings).concat(['jit','work_mem','statement_timeout','random_page_cost']);
  for (const value of Object.values(frozen.queryPath).filter(v=>typeof v==='string') as string[])
    for (const name of names) assert.doesNotMatch(value,new RegExp(`\\b${name}\\s*=`),`${name} in queryPath`);
});
test('LF attributes cover exactly the frozen inputs and manifests',()=>{
  const attributes = readFileSync(new URL('../../.gitattributes',import.meta.url),'utf8')
    .split('\n').filter(line=>line && !line.startsWith('#'));
  assert.deepEqual(attributes,[...frozen.sourceHashes.map(source=>source.path),
    'load/search-engines/manifest-v1.json','load/search-engines/manifest-v2.json']
    .sort().map(path=>`/${path} text eol=lf`));
});
test('manifest content tampering is refused',()=>{
  assert.throws(()=>verifyManifest({...document,sha256:'changed'}),/content hash mismatch/);
});
for (const field of ['generator','sourceHashes','quality','performance','timing','image','sessionPolicy','settings','shmBytes','smoke','queryPath'] as const) {
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

for (const reused of [false,true]) {
  test(`different image identity with matching runtime passes and is recorded (reused=${reused})`,()=>{
    const id = 'sha256:'+'b'.repeat(64);
    const record = resolveImage(()=>id,'mutable-tag',reused);
    assert.notEqual(record.id,frozen.image.historicalId);
    assert.deepEqual(JSON.parse(JSON.stringify(record)),{id,reused});
    const sql = (text:string)=>text.includes('server_version_num') ? '180006' :
      JSON.stringify(text.includes('pg_available_extensions') ? extensions : settings);
    const docker = ()=>Object.entries(packages).map(p=>p.join('|')).join('\n');
    verifyRuntime(sql,docker,'disposable');
    assert.throws(()=>verifyRuntime(()=> '180005',docker,'disposable'),/PostgreSQL version mismatch/);
  });
}
test('both runners launch the recorded settings, compared in pg_settings units',()=>{
  // pg_settings: buffers/cache use 8kB, work memory kB, WAL MB, timeout seconds.
  const units: Record<string,number> = {shared_buffers:8192,effective_cache_size:8192,
    work_mem:1024,maintenance_work_mem:1024,max_wal_size:1024*1024,checkpoint_timeout:1};
  const scales: Record<string,number> = {MB:1024*1024,GB:1024**3,min:60};
  const launched = Object.fromEntries(postgresArguments.slice(1).filter((_,i)=>i%2===1).map(arg=>{
    const [name,value] = arg.split('=') as [string,string];
    const match = /^(\d+)(MB|GB|min)$/.exec(value);
    return [name,match ? String(Number(match[1])*scales[match[2]!]!/units[name]!) : value];
  }));
  assert.deepEqual({...launched,server_encoding:'UTF8'},frozen.settings);
  assert.deepEqual(Object.fromEntries(Object.keys(units).map(name=>[name,launched[name]])),{
    shared_buffers:'16384',effective_cache_size:'524288',work_mem:'4096',
    maintenance_work_mem:'65536',max_wal_size:'1024',checkpoint_timeout:'300',
  });
  for (const runner of ['run.ts','quality/run.ts']) {
    const source = readFileSync(new URL(runner,import.meta.url),'utf8');
    assert.match(source,/image,\s*\.\.\.postgresArguments\]/);
    const launch = source.slice(source.indexOf("command('docker',['run'"),source.indexOf('POSTGRES_PASSWORD:password}'));
    assert.doesNotMatch(launch,/'-c'/,'runner must not override common launch settings');
  }
});
for (const role of ['owner','app']) {
  test(`${role}: inherited PGOPTIONS disabling bitmap scans is refused`,()=>{
    const effective = [{name:'enable_bitmapscan',setting:'off',boot_val:'on',category:'Query Tuning / Planner Method Configuration'}];
    const sql = (text: string)=>{
      if (!text.includes('count(*)')) return JSON.stringify(sessionSettings);
      assert.match(text,/category LIKE 'Query Tuning%'/);
      assert.match(text,/setting IS DISTINCT FROM boot_val/);
      return String(effective.filter(s=>s.category.startsWith('Query Tuning') && s.setting!==s.boot_val).length);
    };
    assert.throws(()=>verifySession(sql),/planner defaults mismatch/);
  });
  test(`${role}: frozen planner and session defaults pass`,()=>{
    verifySession(text=>text.includes('count(*)') ? '0' : JSON.stringify(sessionSettings));
    assert.throws(()=>verifySession(()=>JSON.stringify({...sessionSettings,row_security:'off'})),/session settings mismatch/);
  });
}

test('runtime GUC verification loads PGroonga and reads typed values in the same backend',()=>{
  let initialized = false;
  verifyRuntime(text=>{
    if (text.includes('server_version_num')) return '180006';
    if (text.includes('pg_available_extensions')) return JSON.stringify(extensions);
    assert.match(text,/DO \$\$ BEGIN PERFORM pgroonga_command\('status'\); END \$\$; SELECT json_object_agg/);
    initialized = true;
    return JSON.stringify(settings);
  },()=>Object.entries(packages).map(p=>p.join('|')).join('\n'),'test');
  assert.equal(initialized,true);
});
test('a planner override passes only when fixed in that role\'s session settings',()=>{
  // Shape of the pending #196 role default (jit=off): listing it in the frozen
  // app settings both requires the value and excludes it from the override count.
  const fixed = {...appSessionSettings,jit:'off'};
  const sql = (text: string)=>text.includes('count(*)') ? (text.includes("'jit'") ? '0' : '1')
    : JSON.stringify(text.includes("'jit'") ? fixed : appSessionSettings);
  verifySession(sql,'app',fixed);
  assert.throws(()=>verifySession(sql,'app'),/planner defaults mismatch/);
});
test('app sessions require 10s statement_timeout; owner setup keeps no SQL timeout',()=>{
  assert.equal(appSessionSettings.statement_timeout,'10000');
  assert.equal(sessionSettings.statement_timeout,'0');
  verifySession(text=>text.includes('count(*)')?'0':JSON.stringify(appSessionSettings),'app');
  assert.throws(()=>verifySession(text=>text.includes('count(*)')?'0':JSON.stringify(sessionSettings),'app'),/session settings mismatch/);
});
test('smoke mode is explicit, fixed, and cannot authorize formal overrides',t=>{
  const before = process.env.SEARCH_SMOKE;
  t.after(()=>{if(before===undefined) delete process.env.SEARCH_SMOKE; else process.env.SEARCH_SMOKE=before;});
  process.env.SEARCH_SMOKE='1';
  assert.equal(runKind(),'smoke');
  assert.equal(snapshot().performance.rows,1_000_000);
  assert.equal(snapshot().smoke.performance.rows,1000);
  process.env.SEARCH_SMOKE='0';
  assert.throws(()=>runKind(),/SEARCH_SMOKE must be/);
});

test('app runtime verifies hidden server preload settings via owner and still rejects drift',()=>{
  const visible = {...settings};
  delete visible.shared_preload_libraries;
  const sql = (text:string)=>text.includes('server_version_num')?'180006':
    JSON.stringify(text.includes('pg_available_extensions')?extensions:visible);
  const docker = ()=>Object.entries(packages).map(p=>p.join('|')).join('\n');
  verifyRuntime(sql,docker,'test',()=>settings.shared_preload_libraries!);
  assert.throws(()=>verifyRuntime(sql,docker,'test',()=>''),/preloaded libraries mismatch/);
  assert.throws(()=>verifyRuntime(sql,docker,'test'),/settings mismatch/);
  visible['pgroonga.enable_wal_resource_manager']='off';
  assert.throws(()=>verifyRuntime(sql,docker,'test',()=>settings.shared_preload_libraries!),/settings mismatch/);
});
