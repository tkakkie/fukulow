import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { readConfig, quote, type Config } from './dms-formal-config.ts';
import { execute, checked, transferImage, type Executor } from './dms-formal-exec.ts';
import { requireHeadroom, GiB, summaryLimit } from './dms-formal-storage.ts';
import { deferredScenarios, judge } from './dms-formal-judgment.ts';
export const sshOptions=['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-o','StrictHostKeyChecking=yes'];
export type Runtime = { exec:Executor; transfer:typeof transferImage; on:(signal:'SIGINT'|'SIGTERM',listener:()=>void)=>void; off:(signal:'SIGINT'|'SIGTERM',listener:()=>void)=>void };
const defaultRuntime:Runtime={exec:execute,transfer:transferImage,on:(s,f)=>process.on(s,f),off:(s,f)=>process.off(s,f)};
export const cleanupReserveMs=10*60*1000;
export const attemptBudgetMs=(mode:'formal'|'smoke')=>mode==='formal'?150*60*1000:30*60*1000;
export const canStartAttempt=(config:Config,now=Date.now())=>config.deadline===undefined || config.deadline-now>=attemptBudgetMs(config.mode)+cleanupReserveMs;
export async function run(config:Config, runtime:Runtime=defaultRuntime) {
  const id=`dm-formal-${randomUUID()}`, root=`/tmp/${id}`, checkout=resolve(import.meta.dirname,'..');
  const json=(name:string,value:unknown)=>{const path=`${config.output}/${name}`,temp=path+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});renameSync(temp,path);};
  let phase='initializing', attempt=0, lastError:string|null=null, interrupted=false;
  const start=new Date().toISOString();
  let operation='initializing',outcome='running',infrastructureFailure=false,statusWriteFailed=false;
  const status=()=>{try {json('status.json',{id,label:config.mode==='smoke'?'NON-ACCEPTANCE':'FORMAL',phase,operation,outcome,attempt:Math.min(attempt,config.attempts),started:start,updated:new Date().toISOString(),lastError});}catch {statusWriteFailed=true;console.error('Status write failed; cleanup remains active');}};
  const abort = new AbortController();
  const bounded=(timeout:number)=>phase==='cleanup'||config.deadline===undefined?timeout:Math.max(1000,Math.min(timeout,config.deadline-Date.now()-cleanupReserveMs));
  const remote=(host:string,command:string,timeout=120000,log?:string)=>checked(runtime.exec,{program:'ssh',args:[...sshOptions,host,command],timeout:bounded(timeout),log,signal:phase==='cleanup' ? undefined : abort.signal});
  const worker=(host:string,op:string,n=attempt,epoch=0,timeout=120000)=>{operation=op;status();const limit=bounded(timeout);return remote(host,`timeout --signal=KILL ${Math.max(1,Math.ceil(limit/1000)-5)}s env NODE_EXTRA_CA_CERTS=${quote(root+'/ca.crt')} node ${quote(root+'/harness/load/dms-formal-host.ts')} ${quote(op)} ${n} ${epoch}`,limit,`${config.output}/host-${hosts.indexOf(host)}-${op}-${n}.log`);};
  const hosts=[config.app,config.db,config.generator];
  let cleanupPromise:Promise<void>|undefined;
  const cleanup=()=>cleanupPromise ??= (async()=>{
    phase='cleanup';status();
    const failures=await Promise.allSettled(hosts.map(host=>remote(host,`if test -f ${quote(root+'/harness/load/dms-formal-host.ts')} && test -f ${quote(root+'/state.json')}; then timeout --signal=KILL 180s env NODE_EXTRA_CA_CERTS=${quote(root+'/ca.crt')} node ${quote(root+'/harness/load/dms-formal-host.ts')} cleanup; else rm -rf ${quote(root)}; fi`,190000,`${config.output}/host-${hosts.indexOf(host)}-cleanup.log`)));
    json('cleanup.json',failures.map((result,index)=>({role:['app','db','generator'][index],ok:result.status==='fulfilled',retained:result.status==='fulfilled'?'Private scratch/raw evidence and shared base images/cache (if bootstrapped)':'Removal failed; inspect host cleanup log'})));
    if (failures.some(result=>result.status==='rejected')) throw new Error('Remote cleanup incomplete; see cleanup.json and private state');
  })();
  const signal=()=>{interrupted=true;abort.abort();lastError='Interrupted by signal';status();void cleanup().catch(()=>{});};
  // Registered before the first remote directory, image, container or volume exists.
  runtime.on('SIGINT',signal);runtime.on('SIGTERM',signal);
  const heartbeat=setInterval(status,15000);
  const deadlineTimer=config.deadline===undefined?undefined:setTimeout(()=>{lastError='Configured deadline cleanup reserve reached';signal();},Math.max(0,config.deadline-Date.now()-cleanupReserveMs));
  const checkpoint=()=>{if(interrupted)throw new Error('Interrupted');};
  const change=(next:string)=>{checkpoint();phase=next;status();console.log(`DM formal: ${phase}${attempt ? ` (attempt ${attempt})` : ''}`);};
  const artifact=async(host:string,path:string,local:string,raw=false)=>{
    operation='transfer:'+path;status();
    if(!raw) { const size=Number(await remote(host,`du -sb ${quote(root+'/'+path)} | cut -f1`,10000));if(!Number.isFinite(size)||size>summaryLimit)throw new Error('Artifact exceeds bounded 32 MiB transfer'); }
    // scp is bounded, uses SSH config aliases, and never interpolates credentials.
    await checked(runtime.exec,{program:'scp',args:[...sshOptions,'-r',`${host}:${root}/${path}`,local],timeout:bounded(raw?3600000:120000),signal:abort.signal,log:`${config.output}/transfer.log`});
  };
  const upload=async(host:string,local:string,dest:string)=>checked(runtime.exec,{program:'scp',args:[...sshOptions,local,`${host}:${root}/${dest}`],timeout:600000,signal:abort.signal,log:`${config.output}/transfer.log`});
  const results:unknown[]=[];
  try {
    mkdirSync(config.output,{mode:0o700});
    requireHeadroom(config.output,2*GiB);
    json('metadata.json',{id,mode:config.mode,label:config.mode==='smoke'?'NON-ACCEPTANCE':'FORMAL',sha:config.sha,acceptance:false});
    change('preflight');
    const address=async(host:string)=>{
      const text=await checked(runtime.exec,{program:'ssh',args:['-G',host],timeout:10000});
      const value=/^hostname (\S+)$/m.exec(text)?.[1];
      if(!value || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value))throw new Error('SSH HostName must be a routable IPv4 address or DNS name');return value;
    };
    const [appAddress,dbAddress]=await Promise.all([address(config.app),address(config.db)]);
    const pin=(file:string,pattern:RegExp)=>{const value=pattern.exec(readFileSync(`${checkout}/${file}`,'utf8'))?.[1];if(!value)throw new Error('Missing repository image pin');return value;};
    const common={id,sha:config.sha,mode:config.mode,appAddress,dbAddress,generatorTarget:config.generator,attempts:config.attempts,dbPassword:randomBytes(32).toString('hex'),appPassword:randomBytes(32).toString('hex'),setupToken:randomBytes(32).toString('hex'),postgres:pin('load/compose.yml',/image: (postgres:\S+)/),k6:pin('Makefile',/K6_IMAGE := (\S+)/),caddy:pin('compose.yml',/image: (caddy:\S+)/),nodeVersion:readFileSync(`${checkout}/.node-version`,'utf8').trim()};
    json('private-state.json',{...common,hosts});
    await checked(runtime.exec,{program:'tar',args:['--exclude=node_modules','-czf',`${config.output}/harness.tgz`,'-C',checkout,'load','web/src','deploy/Caddyfile'],timeout:120000});
    chmodSync(`${config.output}/harness.tgz`,0o600);
    for(const [index,host] of hosts.entries()) {
      checkpoint();
      await remote(host,`umask 077; mkdir ${quote(root)}; mkdir ${quote(root+'/harness')}`);
      await upload(host,`${config.output}/harness.tgz`,'harness.tgz');
      json('host-state.json',{...common,role:['app','db','generator'][index]});
      await upload(host,`${config.output}/host-state.json`,'state.json');
      await remote(host,`tar -xzf ${quote(root+'/harness.tgz')} -C ${quote(root+'/harness')}`);
      await worker(host,'preflight');
      await artifact(host,'preflight.json',`${config.output}/preflight-${index}.json`);
    }
    const identities=hosts.map((_,i)=>JSON.parse(readFileSync(`${config.output}/preflight-${i}.json`,'utf8')).machine);
    if(new Set(identities).size!==3)throw new Error('Hosts are not three separate machines');
    await worker(config.app,'rtt');await worker(config.generator,'rtt');
    change('build');await worker(config.app,'build',0,0,7500000);
    for(const host of [config.db,config.generator]) {
      checkpoint();await runtime.transfer([...sshOptions,config.app,`timeout --signal=KILL 600s docker save ${quote(id+':release')}`],[...sshOptions,host,'timeout --signal=KILL 600s docker load'],600000,abort.signal);
    }
    change('services');await worker(config.generator,'prepare-generator',0,0,720000);await worker(config.db,'database',0,0,900000);await worker(config.app,'app',0,0,300000);
    await artifact(config.app,'image.json',`${config.output}/image.json`);
    const imageId=JSON.parse(readFileSync(`${config.output}/image.json`,'utf8'))[0].Id;
    await artifact(config.db,'image.json',`${config.output}/db-image.json`);
    if(JSON.parse(readFileSync(`${config.output}/db-image.json`,'utf8'))[0].Id!==imageId)throw new Error('Transferred image digest mismatch');
    await artifact(config.app,'ca.crt',`${config.output}/ca.crt`);
    for(const host of [config.db,config.generator])await upload(host,`${config.output}/ca.crt`,'ca.crt');
    change('seed');await worker(config.db,'seed',0,0,90000000);
    await artifact(config.db,'formal',config.output);await artifact(config.db,'deep.json',`${config.output}/deep.json`);
    // Mode 0600 seeds travel only through authenticated SSH; no credentials in commands.
    for(const file of ['deep.json',...Array.from({length:config.mode==='smoke'?1:10},(_,i)=>`formal/org-${i}.json`)]) {
      if(file.startsWith('formal/'))await remote(config.generator,`mkdir -p ${quote(root+'/formal')}`);
      await upload(config.generator,`${config.output}/${file}`,file);
    }
    json('metadata.json',{id,mode:config.mode,label:config.mode==='smoke'?'NON-ACCEPTANCE':'FORMAL',sha:config.sha,harnessSha256:createHash('sha256').update(readFileSync(`${config.output}/harness.tgz`)).digest('hex'),imageDigest:imageId,scenario:config.scenario,attempts:config.attempts,images:{postgres:common.postgres,k6:common.k6,caddy:common.caddy},sampleExtension:config.mode==='formal'?'Minutes 40-44 supplement the fixed minute-10–40 core to exceed 10,000 aggregate create/renew samples at unchanged rates.':'none',tls:'Per-run Caddy internal CA; generator SSL_CERT_FILE=/ca.crt, Node NODE_EXTRA_CA_CERTS. Verification enabled.',deferredScenarios});
    for(attempt=1;attempt<=config.attempts;attempt++) {
      if(!canStartAttempt(config)) {infrastructureFailure=true;lastError='Insufficient time before deadline for next attempt and cleanup';results.push({attempt,status:'not started',operation:'deadline-admission',acceptance:false});break;}
      requireHeadroom(config.output,2*GiB);outcome='running';
      const directory=`${config.output}/attempt-${attempt}`;mkdirSync(directory,{mode:0o700});
      try {
      change('restore');await worker(config.generator,'stop-generators');await worker(config.app,'stop-app');await worker(config.db,'restore',attempt,0,7500000);await worker(config.app,'start-app');
      // Fixed epoch permits exact common minute-10–40 selection; startup misses fail the generators.
      const epoch=Date.now()+60000, end=epoch+(config.mode==='smoke'?270000:2790000);
      json(`attempt-${attempt}/schedule.json`,{epoch,until:end});
      change('timing');
      const runs=await Promise.allSettled([worker(config.app,'observe',attempt,end,end-Date.now()+120000),worker(config.db,'observe',attempt,end,end-Date.now()+120000),worker(config.generator,'generators',attempt,epoch,end-Date.now()+120000)]);
      checkpoint();
      change('collect');await worker(config.db,'durable',attempt,0,900000);
      await worker(config.app,'ship',attempt,0,300000);await worker(config.db,'ship',attempt,0,1200000);
      await worker(config.generator,'reduce',attempt,0,5400000);
      await artifact(config.generator,`summary-${attempt}.tgz`,`${directory}/summary.tgz`);
      await checked(runtime.exec,{program:'tar',args:['-xzf',`${directory}/summary.tgz`,'-C',directory],timeout:30000});
      if(config.downloadRaw)try {await artifact(config.generator,`raw-${attempt}.tgz`,`${directory}/raw.tgz`,true);}catch {infrastructureFailure=true;json(`attempt-${attempt}/raw-download-failure.json`,{remoteArchive:`${root}/raw-${attempt}.tgz`,operation:'raw-download'});}
      if(runs.some(result=>result.status==='rejected')) { json(`attempt-${attempt}/infrastructure-failure.json`,{failed:true});throw new Error('Remote timing/observation failure'); }
      else {
        const report=JSON.parse(readFileSync(`${directory}/judgment.json`,'utf8'));
        if(report.infrastructureFailure)infrastructureFailure=true;
        results.push({attempt,...report});outcome=report.infrastructureFailure?'infrastructure-failed':'evaluated';
      }
      } catch(error) {
        if(interrupted)throw error;
        infrastructureFailure=true;outcome='infrastructure-failed';lastError=error instanceof Error?error.message:'Attempt infrastructure/evidence failure';status();
        const failed={attempt,...judge({},config.mode),operation,error:lastError};
        json(`attempt-${attempt}/judgment.json`,failed);
        writeFileSync(`${directory}/judgment.md`,`${failed.label}\n\nAcceptance: NOT PASSED\n\n| Budget | Limit | Observed | Judgment |\n|---|---:|---:|---|\n${failed.rows.map(row=>`| ${row.budget} | ${row.limit} | ${row.value ?? 'missing'} | ${row.status} |`).join('\n')}\n`,{mode:0o600});
        results.push(failed);
      } finally {
        if(!interrupted) {
          await worker(config.db,'stop-copy',attempt,0,60000);
          const retained=await Promise.allSettled(hosts.map(host=>worker(host,'retain-raw',attempt,0,2400000)));
          if(retained.some(row=>row.status==='rejected')) {infrastructureFailure=true;json(`attempt-${attempt}/raw-retention-failure.json`,{remoteRoot:root,operation:'retain-raw',roles:retained.map((row,i)=>({role:['app','db','generator'][i],ok:row.status==='fulfilled'})),retained:'Uncompressed remote evidence on failed hosts; compression failed'});}
        }
      }
      json('summary.json',{label:config.mode==='smoke'?'NON-ACCEPTANCE':'FORMAL',acceptance:false,attempts:results,deferredScenarios});
    }
    change('retain');
    for(const [host,index] of hosts.map((host,index)=>[host,index] as const)) {
      const destination=`${config.output}/host-${index}`;mkdirSync(destination,{mode:0o700});
      // Avoid copying the huge local DB directories; all SQL/plan/cap/seed evidence is at root.
      await remote(host,`find ${quote(root)} -maxdepth 1 -type f ! -name '*.tgz' -print0 | tar --null -T - -czf ${quote(root+'/evidence.tgz')}`,120000);
      try {await artifact(host,'evidence.tgz',`${destination}/evidence.tgz`);}catch {infrastructureFailure=true;json(`host-${index}/transfer-failure.json`,{operation:'retain',remoteRoot:root});}
    }
    json('summary.json',{label:config.mode==='smoke'?'NON-ACCEPTANCE':'FORMAL',acceptance:false,attempts:results,deferredScenarios,reason:'Acceptance requires all adopted budgets and deferred scenarios; missing evidence is NOT EVALUATED.'});
  } catch(error) {lastError=error instanceof Error?error.message:'Runner failed';json('failure.json',{label:config.mode==='smoke'?'NON-ACCEPTANCE':'FORMAL',phase,attempt,lastError,acceptance:false});throw error;}
  finally {
    try {await cleanup();}catch(error){lastError='Remote cleanup incomplete';throw error;}finally {clearInterval(heartbeat);clearTimeout(deadlineTimer);runtime.off('SIGINT',signal);runtime.off('SIGTERM',signal);phase=lastError?'failed':'complete';outcome=lastError?'infrastructure-failed':'complete';status();}
  }
  return {acceptance:false,infrastructureFailure:infrastructureFailure||statusWriteFailed,attempts:results};
}
if(process.argv[1]===import.meta.filename) {
  try {const config=readConfig(process.argv[2]||'',resolve(import.meta.dirname,'..'));run(config).then(result=>{process.exitCode=result.infrastructureFailure?1:2;}).catch(()=>{console.error('DM formal run failed; inspect private status.json and failure.json');process.exitCode=1;});}
  catch(error){console.error(error instanceof Error?error.message:'Invalid config');process.exitCode=1;}
}
