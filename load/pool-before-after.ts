import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, arch, release, hostname } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { outsideCheckout } from './proxy-target.ts';
import { plan, pairs, settings, scenarios, scope, timeoutNote, judgeAll, validity, type Run, type Scenario, type Arm, type Counts } from './pool-before-after-summary.ts';
import type { NativeSessionResponse, SetupRequest, Channel, CreateChannelRequest } from '../web/src/api-schema.d.ts';
const exec=promisify(execFile);
if(process.argv.includes('--help')) {
  console.log(`${scope}\nUsage: node load/pool-before-after.ts --out /absolute/new/external/directory [--smoke]\nFull: 12 fresh runs, sends and mixed; three B/A, A/B, B/A pairs per scenario.\nSmoke: B only, sends only, 50/s for 10 s; never comparison evidence.`);
  process.exit(0);
}
const args=process.argv.slice(2);
const outIndex=args.indexOf('--out');
if(outIndex<0||!args[outIndex+1]||args.some((arg,i)=>i!==outIndex+1&&!['--out','--smoke'].includes(arg))) throw new Error('Use --out /absolute/new/external/directory [--smoke]');
const output=outsideCheckout(args[outIndex+1]);
if(existsSync(output)) throw new Error('Output directory already exists');
if(process.version!=='v26.13.1') throw new Error('Use Node 26.13.1');
const smoke=args.includes('--smoke');
mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(`${tmpdir()}/pool196-`);
const project=`pool196-${Date.now()}-${randomUUID().slice(0,8)}`;
const command=(file:string,args:string[],input?:string,env=process.env)=>execFileSync(file,args,{input,env,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
const docker=(...args:string[])=>command('docker',args);
const save=(path:string,data:unknown)=>writeFileSync(path,JSON.stringify(data,null,2));
const commits={B:command('git',['rev-parse','956f91e^{commit}']),A:command('git',['rev-parse','7e3762a^{commit}'])};
const images:Partial<Record<Arm,string>>={};
const runs:Run[]=[];
const cleanupErrors:string[]=[];
let activeCompose:string[]|undefined;
let activeEnv:NodeJS.ProcessEnv|undefined;
let generator:ChildProcess|undefined;
let generatorName:string|undefined;
let interrupted=false;
const stop=()=>{interrupted=true;generator?.kill('SIGTERM'); if(generatorName) {try{docker('rm','-f',generatorName);}catch{/* finally retries */}}};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
const check=()=>{if(interrupted)throw new Error('Interrupted');};
const summary=(complete=false)=>({scope,timeoutNote,poolAcquireTimeouts:'NOT EVALUATED',smoke,runs,
  judgement:judgeAll(runs,complete&&!smoke),cleanupErrors});
let failed=false;
try {
  const harnessFiles=['load/pool-before-after.ts','load/pool-before-after-load.ts','load/pool-before-after-summary.ts','load/throughput-summary.ts','load/seed.ts','load/compose.yml','deploy/init-db-roles.sh','deploy/db-roles.sql','deploy/db-role-settings.sql','deploy/db-grants.sql'];
  save(`${output}/metadata.json`,{scope,timeoutNote,commits,settings,smoke,scenarios:{send:'sends only',mixed:'sends + 500 Channel-list reads/s + 20 correct sign-ins/s'},
    memberArithmetic:'4000 Members; max 2000 sends/s / 4000 = 0.5 sends/s/Member; round robin returns every 2 s; default bucket burst 10, refill 1/s unchanged.',
    poolTimeouts:'Both: SQLx PoolTimedOut -> ApiError::from -> HTTP 500, ErrorBody.error="internal error"; stderr database operation failed: pool timed out while waiting for an open connection. Logs have no request ID, include background/late failures: per-request counts NOT EVALUATED. No server patches.',
    workload:'THROUGHPUT_SCENARIO=many equivalent: 200 public Channels, index % 200; Member index % 4000; no subscribers. Open arrival k6, each send step 60 s, 11 s drains; reader 2/s continuous including drains. Success latency includes drain, successful requests only.',
    generator:'k6 send preallocated/max VUs 100/2000; reads 50/1000; sign-in and reader 10/100. Any drops invalidate; offered fraction >=95% (existing delivery tolerance).',
    sampling:'1 s /proc/1/stat CPU ticks (100 Hz, 100%=one core), /proc/1/status RSS; pg_stat_activity app-role client connections including idle and active separately; sampler excluded. Gaps >2.5 s or sampling errors invalidate.',
    node:process.version,machine:{platform:platform(),arch:arch(),release:release(),hostname:hostname(),cpus:cpus(),memory:totalmem()},
    docker:JSON.parse(docker('info','--format','{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory":{{json .MemTotal}}}')),
    harnessCommit:command('git',['rev-parse','HEAD']),dirty:command('git',['status','--porcelain']),
    harnessHashes:Object.fromEntries(harnessFiles.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))});
  writeFileSync(`${output}/harness.patch`,command('git',['diff','HEAD']));
  for(const arm of (smoke?['B']:['B','A']) as Arm[]) {
    check();
    const source=`${scratch}/${arm}`;
    mkdirSync(source);
    command('git',['archive','--format=tar',`--output=${scratch}/${arm}.tar`,commits[arm]]);
    command('tar',['-xf',`${scratch}/${arm}.tar`,'-C',source]);
    const tag=`${project}-${arm.toLowerCase()}`;
    console.log(`${scope}: building ${arm} ${commits[arm]}`);
    // Child output stays in an external file; no server source is changed.
    try {
      const log=await exec('docker',['build','--label',`org.opencontainers.image.revision=${commits[arm]}`,'-t',tag,source],{maxBuffer:64*1024*1024});
      writeFileSync(`${output}/build-${arm}.log`,log.stdout+log.stderr);
    } catch(error) {
      const log=error as {stdout?:string;stderr?:string};
      writeFileSync(`${output}/build-${arm}.log`,(log.stdout??'')+(log.stderr??''));
      throw new Error('Image build failed');
    }
    images[arm]=docker('image','inspect','--format','{{.Id}}',tag);
  }
  const k6=command('make',['-s','load-image']);
  docker('pull',k6);
  const k6Id=docker('image','inspect','--format','{{.Id}}',k6);
  save(`${output}/images.json`,{scope,commits,images,k6,k6Id});
  const sequence=smoke?[{scenario:'send' as Scenario,pair:1,arm:'B' as Arm}]:scenarios.flatMap(scenario=>pairs().flatMap((arms,i)=>arms.map(arm=>({scenario,pair:i+1,arm}))));
  for(const cell of sequence) {
    check();
    const id=`${cell.scenario}-${cell.pair}-${cell.arm}`;
    const dir=`${output}/${id}`;mkdirSync(dir);
    const privateDir=`${scratch}/${id}`;mkdirSync(privateDir,{mode:0o700});
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONTEXT:process.env.DOCKER_CONTEXT,
      LOAD_PROJECT:`${project}-${id.toLowerCase()}`,LOAD_PORT:'18196',LOAD_DB_PASSWORD:randomUUID(),LOAD_APP_PASSWORD:randomUUID(),
      LOAD_SETUP_TOKEN:randomUUID(),LOAD_APP_IMAGE:images[cell.arm],LOAD_SERVER_SOURCE:`${scratch}/${cell.arm}`,LOAD_SEND_BURST:'10',LOAD_SEND_REFILL_PER_SECOND:'1'};
    const override=`${privateDir}/compose.json`;
    save(override,{services:{app:{environment:{FUKULOW_CLIENT_IP_HEADER:'x-load-client-ip',FUKULOW_TRUSTED_PROXIES:'0.0.0.0/0,::/0'}}}});
    const compose=['compose','--env-file','/dev/null','-p',env.LOAD_PROJECT!,'-f',resolve('load/compose.yml'),'-f',override];
    activeCompose=compose;activeEnv=env;
    const dc=(...args:string[])=>command('docker',[...compose,...args],undefined,env);
    const sql=(query:string)=>command('docker',[...compose,'exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','fukulow','-d','fukulow','-At'],query,env);
    let timer:ReturnType<typeof setInterval>|undefined;
    let pending:Promise<void>|undefined;
    const samples:{at:number;cpuTicks:number;rssKiB:number;connections:number;active:number;cpuPercent:number|null}[]=[];
    // Failed samples are counted per step by time; a sample skipped while the previous one runs only widens the gap, which validity bounds.
    const sampleErrorTimes:number[]=[];
    let startMs:number|undefined;
    let result:(Omit<Run,'pair'|'arm'|'scenario'|'smoke'|'reader'> & {lanes:unknown[];continuousReaderComplete:boolean;runMetrics:Record<string,Counts>})|undefined;
    try {
      console.log(`${scope}: starting ${id}`);
      dc('up','-d','--no-build','--wait');check();
      const app=dc('ps','-q','app'),db=dc('ps','-q','db');
      const base='http://127.0.0.1:18196';
      const password=randomUUID();
      async function post(path:string,body:unknown,expected:number,token?:string) {
        const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
          body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
        if(response.status!==expected)throw new Error(`Seed ${path} status ${response.status}`);
        return response.json();
      }
      const setup:SetupRequest={email:'seed@example.invalid',password,name:'Load Owner',organization_name:'Organization A',setup_token:env.LOAD_SETUP_TOKEN!};
      await post('/api/v1/setup',setup,201);
      const owner=await post('/api/v1/native/session',{email:'seed@example.invalid',password},200) as NativeSessionResponse;
      const organization=owner.identity.organizations[0].organization_id;
      const tokens=Array.from({length:settings.members},()=>randomBytes(32).toString('hex'));
      // Disposable fixture only: copy one genuine Argon2 hash, seed distinct Members/sessions.
      sql(`BEGIN;
        INSERT INTO accounts(id,email,password_hash) SELECT gen_random_uuid(),'member-'||n||'@example.invalid',password_hash FROM accounts CROSS JOIN generate_series(0,3999) n WHERE email='seed@example.invalid';
        INSERT INTO users(organization_id,id,account_id,name,role) SELECT '${organization}',gen_random_uuid(),id,'Load Member','member' FROM accounts WHERE email LIKE 'member-%';
        INSERT INTO account_sessions(token_hash,account_id) VALUES ${tokens.map((t,i)=>`(sha256(convert_to('${t}','UTF8')),(SELECT id FROM accounts WHERE email='member-${i}@example.invalid'))`).join(',')};
        INSERT INTO organizations(organization_id,name) VALUES(gen_random_uuid(),'Organization B');
        INSERT INTO accounts(id,email,password_hash) SELECT gen_random_uuid(),'reader@example.invalid',password_hash FROM accounts WHERE email='seed@example.invalid';
        INSERT INTO users(organization_id,id,account_id,name,role) SELECT o.organization_id,gen_random_uuid(),a.id,'Reader','owner' FROM accounts a CROSS JOIN organizations o WHERE a.email='reader@example.invalid' AND o.name='Organization B'; COMMIT;`);
      const reader=await post('/api/v1/native/session',{email:'reader@example.invalid',password},200) as NativeSessionResponse;
      const otherOrganization=reader.identity.organizations[0].organization_id;
      const channels:string[]=[];
      for(let i=0;i<settings.channels;i++) {
        const body:CreateChannelRequest={name:`load-${i}`,visibility:'public'};
        channels.push((await post(`/api/v1/orgs/${organization}/channels`,body,201,owner.token) as Channel).id);
      }
      for(const [org,token] of [[organization,tokens[0]],[otherOrganization,reader.token]]) {
        const r=await fetch(`${base}/api/v1/orgs/${org}/channels`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
        if(r.status!==200)throw new Error('Fixture preflight failed');await r.arrayBuffer();
      }
      save(`${privateDir}/data.json`,{organization,otherOrganization,reader:reader.token,channels,password});
      save(`${privateDir}/tokens.json`,tokens);
      save(`${dir}/metadata.json`,{scope,...cell,commit:commits[cell.arm],appImage:docker('inspect','--format','{{.Image}}',app),dbImage:docker('inspect','--format','{{.Image}}',db),settings,smoke,
        dbSettings:sql("SELECT name||'='||setting FROM pg_settings WHERE name IN ('max_connections','shared_buffers','statement_timeout','lock_timeout') ORDER BY name"),
        roleSettings:sql("SELECT rolname,rolconfig FROM pg_roles WHERE rolname IN ('fukulow','fukulow_app')"),started:new Date().toISOString()});
      const sample=()=> {
        if(pending) return;
        const at=Date.now();
        pending=Promise.all([
          exec('docker',['exec',app,'cat','/proc/1/stat','/proc/1/status'],{env}),
          exec('docker',['exec',db,'psql','-X','-U','fukulow','-d','fukulow','-Atc',"SELECT count(*),count(*) FILTER (WHERE state='active') FROM pg_stat_activity WHERE datname=current_database() AND usename='fukulow_app' AND backend_type='client backend' AND pid<>pg_backend_pid()"],{env}),
        ]).then(([proc,pg])=> {
          const fields=proc.stdout.slice(proc.stdout.indexOf(')')+2).split(/\s+/);
          const cpuTicks=Number(fields[11])+Number(fields[12]);
          const rssKiB=Number(proc.stdout.match(/^VmRSS:\s+(\d+)/m)?.[1]);
          const [connections,active]=pg.stdout.trim().split('|').map(Number);
          if(![cpuTicks,rssKiB,connections,active].every(Number.isFinite))throw new Error('Invalid sample');
          const previous=samples.at(-1);
          samples.push({at,cpuTicks,rssKiB,connections,active,cpuPercent:previous?(cpuTicks-previous.cpuTicks)*1000/(at-previous.at):null});
        }).catch(()=>{sampleErrorTimes.push(at);}).finally(()=>{pending=undefined;});
      };
      sample();timer=setInterval(sample,1000);
      generatorName=`${project}-generator`;
      generator=spawn('docker',['run','--rm','--name',generatorName,'--network',`${env.LOAD_PROJECT}_default`,
        '-v',`${resolve('.') }:/work:ro`,'-v',`${privateDir}:/fixture:ro`,'-w','/work',
        '-e','BASE_URL=http://app:8080','-e',`POOL_SMOKE=${smoke?'1':'0'}`,'-e',`POOL_SCENARIO=${cell.scenario}`,k6Id,'run','load/pool-before-after-load.ts'],{env,stdio:['ignore','pipe','pipe']});
      // POOL_RESULT is parsed from stdout alone so stderr chunks can never split it.
      let stdout='',stderr='';
      generator.stdout!.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();});generator.stderr!.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
      const code=await new Promise<number>((done,reject)=>{generator!.on('error',reject);generator!.on('close',c=>done(c??1));});
      clearInterval(timer);timer=undefined;await pending;
      writeFileSync(`${dir}/generator.log`,stderr);writeFileSync(`${dir}/generator.stdout.log`,stdout);
      const marker=(stderr+'\n'+stdout).match(/POOL_START (\d+)/);startMs=marker?Number(marker[1]):undefined;
      const line=stdout.split('\n').find(l=>l.startsWith('POOL_RESULT '));
      if(line)result=JSON.parse(line.slice(12));
      if(code!==0||!result||!startMs)throw new Error('Missing/failed generator evidence');
      check();
      const metric=(values:number[])=>({mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,peak:values.length?Math.max(...values):null});
      const resources=(from:number,to:number)=> {
        const selected=samples.filter(s=>s.at>=from&&s.at<to);
        const times=[from,...selected.map(s=>s.at),to];
        const maxSampleGapMs=Math.max(...times.slice(1).map((t,i)=>t-times[i]));
        return {samples:selected.length,maxSampleGapMs,cpuPercent:metric(selected.flatMap(s=>s.cpuPercent===null?[]:[s.cpuPercent])),rssKiB:metric(selected.map(s=>s.rssKiB)),
          dbConnectionsInUse:metric(selected.map(s=>s.connections)),dbActive:metric(selected.map(s=>s.active))};
      };
      const steps=result.steps.map((r,i)=>{
        const step=plan(smoke)[i];
        const stats=resources(startMs!+step.startSeconds*1000,startMs!+(step.startSeconds+step.seconds)*1000);
        return {...r,resources:stats,evidence:{complete:result!.continuousReaderComplete,samples:stats.samples,maxSampleGapMs:stats.maxSampleGapMs,samplingErrors:sampleErrorTimes.filter(t=>t>=startMs!+step.startSeconds*1000&&t<startMs!+(step.startSeconds+step.seconds)*1000).length}};
      });
      const last=plan(smoke).at(-1)!;
      const run:Run={scope,...cell,smoke,steps,reader:{...result.runMetrics.reader,rate:2,seconds:last.startSeconds+last.seconds+11}};
      const logs=dc('logs','--no-color','--timestamps','app');
      // Only this exact SQLx Display text is counted. Never infer from HTTP statuses.
      const events=logs.split('\n').filter(l=>/database operation failed: pool timed out while waiting for an open connection\s*$/.test(l)).map(l=>Date.parse(l.match(/\d{4}-\d\d-\d\dT\S+/)?.[0]??'')).filter(Number.isFinite);
      save(`${dir}/results.json`,{...run,timeoutNote,poolAcquireTimeouts:'NOT EVALUATED',
        observedPoolTimeoutLogEvents:{total:events.length,byStep:plan(smoke).map(s=>({rate:s.rate,count:events.filter(t=>t>=startMs!+s.startSeconds*1000&&t<startMs!+(s.startSeconds+s.seconds)*1000).length})),note:'emission time only; no request attribution; late/background failures and unlogged cancellation preclude total timeout counts'},
        lanes:result.lanes,runMetrics:result.runMetrics,resources:resources(startMs,Date.now()),samples,
        validity:steps.map(r=>{const reasons=validity(r);return {rate:r.rate,status:reasons.length?'INVALID':'VALID',reasons};})});
      runs.push(run);
    } finally {
      if(timer)clearInterval(timer);await pending;
      if(generatorName){try{docker('rm','-f',generatorName);}catch{/* --rm may already have removed it */}generatorName=undefined;}
      try{dc('down','--volumes','--remove-orphans');activeCompose=undefined;activeEnv=undefined;}catch{cleanupErrors.push(`${id}: Compose cleanup failed`);}
      rmSync(privateDir,{recursive:true,force:true});
    }
    save(`${output}/summary.json`,summary());
    if(cleanupErrors.length)throw new Error('Cleanup failed');
  }
} catch(error) {
  failed=true;
  // Child-process errors may contain seed SQL and credentials. Never serialize them.
  console.error(`${scope}: runner failed (${error instanceof Error&&error.message==='Interrupted'?'interrupted':'details suppressed'}); inspect completed external artifacts.`);
} finally {
  if(generatorName){try{docker('rm','-f',generatorName);}catch{cleanupErrors.push('Generator cleanup failed');}}
  if(activeCompose){try{command('docker',[...activeCompose,'down','--volumes','--remove-orphans'],undefined,activeEnv);}catch{cleanupErrors.push('Final Compose cleanup failed');}}
  for(const arm of ['B','A']) {try{const tag=`${project}-${arm.toLowerCase()}`;if(docker('image','ls','-q',tag))docker('image','rm',tag);}catch{cleanupErrors.push(`${arm}: image cleanup failed`);}}
  rmSync(scratch,{recursive:true,force:true});
  const complete=!failed&&!interrupted&&!cleanupErrors.length&&(smoke||runs.length===scenarios.length*pairs().length*2);
  save(`${output}/summary.json`,{...summary(complete),complete});
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
console.log(`${scope}: artifacts ${output}`);
process.exitCode=failed||interrupted||cleanupErrors.length?1:0;
