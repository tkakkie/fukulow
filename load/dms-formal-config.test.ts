import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { readConfig, readRunConfig } from './dms-formal-config.ts';
import { checkout, temporary } from './dms-formal-run-fixture.ts';

function env(path:string, extra='') {return `DM_FORMAL_APP=app-alias\nDM_FORMAL_DB=db-alias\nDM_FORMAL_GENERATOR=generator-alias\nDM_FORMAL_SHA=${'a'.repeat(40)}\nDM_FORMAL_OUTPUT=${path}/output\n${extra}`;}
test('private config refuses checkout, symlink, wide mode and existing output',t=>{
  const path=temporary(t), file=`${path}/private.env`;
  writeFileSync(file,env(path),{mode:0o600});
  assert.equal(readConfig(file,checkout).attempts,3);
  assert.equal(readConfig(file,checkout).mode,'formal');
  chmodSync(file,0o640);assert.throws(()=>readConfig(file,checkout),/0600/);chmodSync(file,0o600);
  writeFileSync(file,env(path).replace(`${path}/output`,`${checkout}/output`));assert.throws(()=>readConfig(file,checkout),/outside checkout/);
  writeFileSync(file,env(path));mkdirSync(`${path}/output`);assert.throws(()=>readConfig(file,checkout),/must be new/);
  const inside=`${checkout}/.formal-test-${process.pid}.env`;writeFileSync(inside,env(path),{mode:0o600});t.after(()=>rmSync(inside,{force:true}));
  assert.throws(()=>readConfig(inside,checkout),/outside checkout/);
  symlinkSync(inside,`${path}/linked.env`);assert.throws(()=>readConfig(`${path}/linked.env`,checkout),/outside checkout/);
});
test('config has no ambient env fallback, rejects unsafe aliases, short SHA and too few formal attempts',t=>{
  const path=temporary(t),file=`${path}/private.env`;
  for(const extra of ['DM_FORMAL_ATTEMPTS=1\n','DM_FORMAL_MODE=invalid\n','DM_FORMAL_SCENARIO=unknown\n','DM_FORMAL_UNKNOWN=x\n']) {writeFileSync(file,env(path,extra),{mode:0o600});assert.throws(()=>readConfig(file,checkout));}
  for(const value of [env(path).replace('app-alias','-oProxyCommand=bad'),env(path).replace('a'.repeat(40),'abcd')]) {writeFileSync(file,value);assert.throws(()=>readConfig(file,checkout));}
  writeFileSync(file,env(path,'DM_FORMAL_MODE=smoke\nDM_FORMAL_ATTEMPTS=1\n'));assert.equal(readConfig(file,checkout).attempts,1);
});
test('config validates deadline timezone and raw opt-in',t=>{
  const path=temporary(t),file=path+'/config.env';
  for(const extra of ['DM_FORMAL_DEADLINE=invalid\n','DM_FORMAL_DEADLINE=2000-01-01T00:00:00Z\n','DM_FORMAL_DOWNLOAD_RAW=yes\n']) {
    writeFileSync(file,env(path,extra),{mode:0o600});assert.throws(()=>readConfig(file,checkout));
  }
  const future=new Date(Date.now()+14*3600000).toISOString();
  writeFileSync(file,env(path,'DM_FORMAL_DEADLINE='+future+'\nDM_FORMAL_DOWNLOAD_RAW=1\n'));
  assert.equal(readConfig(file,checkout).deadline,Date.parse(future));assert.equal(readConfig(file,checkout).downloadRaw,true);
});

test('scenario config selects main, held200 and explicit deferred stubs',t=>{
  const path=temporary(t),file=path+'/private.env';
  for(const scenario of ['main','held200','hot-DM','pool-overhead']) {
    writeFileSync(file,env(path,`DM_FORMAL_SCENARIO=${scenario}\n${scenario==='pool-overhead'?'DM_FORMAL_REVIEWED_PATCH_SHA256='+createHash('sha256').update(readFileSync(checkout+'/load/pool-overhead-baseline.patch')).digest('hex')+'\n':''}`),{mode:0o600});
    assert.equal(readConfig(file,checkout).scenario,scenario);
  }
});
test('seed diagnostic CLI accepts only local pool-overhead at pair scale with a formal fixture', t => {
  const path=temporary(t), file=path+'/config.env';
  const patch='DM_FORMAL_REVIEWED_PATCH_SHA256='+'a'.repeat(64)+'\n';
  const overhead='DM_FORMAL_SCENARIO=pool-overhead\n'+patch;
  const local='DM_FORMAL_TARGET=local\n';
  writeFileSync(file,env(path,local+overhead),{mode:0o600});
  assert.equal(readRunConfig([file],checkout).seedDiagnostic,undefined);
  assert.equal(readRunConfig([file,'--pilot'],checkout).pilot,true);
  const diagnostic=readRunConfig([file,'--seed-diagnostic'],checkout);
  assert.equal(diagnostic.seedDiagnostic,true);
  assert.equal(diagnostic.pilot,false);
  assert.equal(diagnostic.loadScale,'1/25');
  assert.throws(()=>readRunConfig([file,'--pilot','--seed-diagnostic'],checkout),/Expected/);
  // The baseline arm is the same seed diagnostic run with the instrumentation off.
  const baselineArm=readRunConfig([file,'--seed-diagnostic-baseline'],checkout);
  assert.deepEqual([baselineArm.seedDiagnostic,baselineArm.seedBaseline,baselineArm.loadScale,baselineArm.pilot],[true,true,'1/25',false]);
  assert.equal(diagnostic.seedBaseline,undefined);
  for (const extra of [overhead,local+'DM_FORMAL_SCENARIO=smoke\nDM_FORMAL_MODE=smoke\n',
    local+overhead+'DM_FORMAL_LOAD_SCALE=1/10\n',local+overhead+'DM_FORMAL_MODE=smoke\n']) {
    writeFileSync(file,env(path,extra));
    assert.throws(()=>readRunConfig([file,'--seed-diagnostic'],checkout),/requires/);
  }
});

test('the rehearsal options mark the same seed diagnostic arms; the full-size arms keep their current config', t => {
  const path=temporary(t), file=path+'/config.env', patch='a'.repeat(64);
  const overhead=`DM_FORMAL_SCENARIO=pool-overhead\nDM_FORMAL_REVIEWED_PATCH_SHA256=${patch}\n`, local='DM_FORMAL_TARGET=local\n';
  writeFileSync(file,env(path,local+overhead),{mode:0o600});
  // Pinned from the config reader at a17fc978: the full-size instrumented and baseline arms.
  const full={seedDiagnostic:true,pilotImage:undefined,target:'local',loadScale:'1/25',
    limits:{appCpu:2,appMemory:'2g',dbCpu:2,dbMemory:'4g',generatorCpu:1,generatorMemory:'1g'},pilot:false,pilotSeconds:60,
    reviewedPatchSha256:patch,app:'app',db:'db',generator:'generator',sha:'a'.repeat(40),output:realpathSync(path)+'/output',
    mode:'formal',scenario:'pool-overhead',attempts:3,deadline:undefined,downloadRaw:false};
  assert.deepEqual(readRunConfig([file,'--seed-diagnostic'],checkout),full);
  assert.deepEqual(readRunConfig([file,'--seed-diagnostic-baseline'],checkout),{...full,seedBaseline:true});
  assert.deepEqual(readRunConfig([file,'--seed-diagnostic-rehearsal'],checkout),{...full,seedRehearsal:true});
  assert.deepEqual(readRunConfig([file,'--seed-diagnostic-baseline-rehearsal'],checkout),{...full,seedBaseline:true,seedRehearsal:true});
  assert.throws(()=>readRunConfig([file,'--rehearsal'],checkout),/Expected .*1 Organization, 5 Message batches \(125000 Messages\)/);
  assert.throws(()=>readRunConfig([file,'--seed-diagnostic','--seed-diagnostic-rehearsal'],checkout),/Expected/);
  // The rehearsal has the seed diagnostic's own conditions: local pool-overhead, a formal fixture and load scale 1/25.
  for (const extra of [overhead,local+'DM_FORMAL_SCENARIO=smoke\nDM_FORMAL_MODE=smoke\n',local+overhead+'DM_FORMAL_LOAD_SCALE=1/10\n',local+overhead+'DM_FORMAL_MODE=smoke\n']) {
    writeFileSync(file,env(path,extra));
    for(const option of ['--seed-diagnostic-rehearsal','--seed-diagnostic-baseline-rehearsal'])assert.throws(()=>readRunConfig([file,option],checkout),/requires/);
  }
});
