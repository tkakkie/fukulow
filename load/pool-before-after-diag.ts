import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, arch, release, hostname, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { outsideCheckout } from './proxy-target.ts';
import { allowanceSeconds, diagnosticComposeOverride, diagnosticConfig, diagnosticLogBufferBytes, generatorConfig } from './pool-before-after-config.ts';
import { activitySql, explainFixture, parseActivity, psqlArgs, scheduleExplain, topStatementsSql, untrackedSqlArgs } from './pool-before-after-db.ts';
import { activityWindow, generatorProbe, generatorStats, generatorWindow, k6Address, processStats, sampler, sampleWindow } from './pool-before-after-sampling.ts';
import { appFailures, classifyPair, diagnosticAppEvidence, diagnosticRule, diagnosticValidity, hasAppFailure, poolStatsCapability, settleHostLoad, validityResult } from './pool-before-after-diagnostic-results.ts';
import { pairs, settings, timeoutNote, type Run, type Arm, type Counts } from './pool-before-after-summary.ts';
import type { NativeSessionResponse, SetupRequest, Channel, ChannelList, CreateChannelRequest } from '../web/src/api-schema.d.ts';
const exec=promisify(execFile);
if(process.argv.includes('--help')) {
  console.log('DIAGNOSTIC #519\nUsage: DIAG_B=<commit> DIAG_A=<commit> node load/pool-before-after.ts --out /absolute/new/external/directory [--smoke]\nOptional: DIAG_PAIRS=1..3 (default 1), DIAG_GEN_B=old|new, DIAG_GEN_A=old|new (both default new), DIAG_RATES=250,500,1000,2000 (default 250).\nClassification requires only the 250/s step. Smoke: B only, mixed at 50 sends/s for 10 s.');
  process.exit(0);
}
const args=process.argv.slice(2);
const outIndex=args.indexOf('--out');
if(outIndex<0||!args[outIndex+1]||args.some((arg,i)=>i!==outIndex+1&&!['--out','--smoke'].includes(arg))) throw new Error('Use --out /absolute/new/external/directory [--smoke]');
const output=outsideCheckout(args[outIndex+1]);
if(existsSync(output)) throw new Error('Output directory already exists');
if(process.version!=='v26.13.1') throw new Error('Use Node 26.13.1');
const smoke=args.includes('--smoke');
const diagnostic=diagnosticConfig(process.env);
const diagPairs=Number(process.env.DIAG_PAIRS??'1');
if(!Number.isInteger(diagPairs)||diagPairs<1||diagPairs>pairs().length)throw new Error('DIAG_PAIRS must be 1, 2 or 3');
if(!process.env.DIAG_B||!process.env.DIAG_A)throw new Error('Set DIAG_B and DIAG_A to local commits');
const command=(file:string,args:string[],input?:string,env=process.env,maxBuffer=64*1024*1024)=>execFileSync(file,args,{input,env,encoding:'utf8',maxBuffer,stdio:['pipe','pipe','pipe']}).trim();
const docker=(...args:string[])=>command('docker',args);
const save=(path:string,data:unknown)=>writeFileSync(path,JSON.stringify(data,null,2));
const commits={B:command('git',['rev-parse','--verify','--end-of-options',`${process.env.DIAG_B}^{commit}`]),A:command('git',['rev-parse','--verify','--end-of-options',`${process.env.DIAG_A}^{commit}`])};
const appCapabilities={B:poolStatsCapability(commits.B),A:poolStatsCapability(commits.A)};
const scope='DIAGNOSTIC #519';
const configs={B:generatorConfig(smoke,true,diagnostic.generators.B,diagnostic.rates),A:generatorConfig(smoke,true,diagnostic.generators.A,diagnostic.rates)};
const diagnosticSettings={...diagnostic,pairs:diagPairs,effectiveSendRates:configs.B.steps.map(s=>s.rate),
  k6Scenarios:{B:configs.B.scenarios,A:configs.A.scenarios},
  samplingIntervalMs:1000,
  sampling:'CPU ticks and RSS for app and k6 PID 1, k6 instance-wide vus (active) and vus_max (allocated) gauges, and pg_stat_activity for fukulow_app. The VU cap comes from the scenario configuration. Transaction ages are sampled in ms and means weight each observed backend equally.',
  database:{pgStatStatements:'Reset before generator launch. Top 25 by total execution time after k6 and its drains finish. Diagnostic SQL is excluded.',
    explain:'Run the arm’s LIST_COUNTS_SQL at the end of 250/s, using member-0 and the Channels returned by fixture preflight. Read-only repeatable-read transaction, app role and Organization setting, rolled back.'}};
mkdirSync(output,{recursive:true});
const scratch=mkdtempSync(`${tmpdir()}/pool196-`);
const project=`pool196-${Date.now()}-${randomUUID().slice(0,8)}`;
const images:Partial<Record<Arm,string>>={};
const sequence=pairs().slice(0,smoke?1:diagPairs).flatMap((arms,i)=>
  (smoke?(['B'] as const):arms).map(arm=>({scenario:'mixed' as const,pair:i+1,arm})));
const runs=new Map<string, Parameters<typeof classifyPair>[0]>();
const pairStarts=new Map<number, { at: number; hostLoad: number; settleWaitSeconds: number }>();
const missingArm=(arm:Arm,reason='missing arm-run evidence')=>({...appCapabilities[arm],validity:validityResult([reason]),sendP95Ms:null,hasAppFailure:false});
const pairResults=()=>Array.from({length:smoke?1:diagPairs},(_,index)=>{
  const pair=index+1;
  const arms={B:runs.get(`mixed-${pair}-B`)??missingArm('B'),A:runs.get(`mixed-${pair}-A`)??missingArm('A')};
  return {scope,pair,commits,pairStart:pairStarts.get(pair)??null,arms,...classifyPair(arms.B,arms.A)};
});
const cleanupErrors:string[]=[];
let activeCompose:string[]|undefined;
let activeEnv:NodeJS.ProcessEnv|undefined;
let generator:ChildProcess|undefined;
let generatorName:string|undefined;
let interrupted=false;
const stop=()=>{interrupted=true;generator?.kill('SIGTERM'); if(generatorName) {try{docker('rm','-f',generatorName);}catch{/* finally retries */}}};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
const check=()=>{if(interrupted)throw new Error('Interrupted');};
function saveResults(complete=false) {
  const comparisons=pairResults();
  for(const pair of comparisons) save(`${output}/mixed-${pair.pair}-results.json`,pair);
  save(`${output}/summary.json`,{scope,timeoutNote,smoke,commits,appCapabilities,diagnostics:diagnosticSettings,
    rule:diagnosticRule,pairs:comparisons,cleanupErrors,complete});
}
let failed=false;
try {
  const diagnosticFiles=['load/pool-before-after-diag.ts','load/pool-before-after-diagnostic-results.ts','load/pool-before-after-db.ts','load/pool-before-after-sampling.ts'];
  const harnessFiles=['load/pool-before-after.ts','load/pool-before-after-load.ts','load/pool-before-after-config.ts','load/pool-before-after-summary.ts',...diagnosticFiles,'load/app-evidence.ts','load/throughput-summary.ts','load/seed.ts','load/compose.yml','deploy/init-db-roles.sh','deploy/db-roles.sql','deploy/db-role-settings.sql','deploy/db-grants.sql'];
  const tracked=command('git',['ls-tree','--name-only','HEAD','--',...diagnosticFiles]).split('\n');
  const additions=diagnosticFiles.filter(path=>!tracked.includes(path)).map(path=>{
    const diff=spawnSync('git',['diff','--no-index','--','/dev/null',path],{encoding:'utf8'});
    if(diff.status!==1)throw new Error('Unable to record diagnostic file diff');
    return diff.stdout;
  });
  const changed=execFileSync('git',['diff','HEAD','--',...harnessFiles.filter(path=>!diagnosticFiles.includes(path)||tracked.includes(path)),'load/pool-before-after-config.test.ts'],{encoding:'utf8'});
  writeFileSync(`${output}/harness.patch`,[changed,...additions].join(''));
  const dockerHost=JSON.parse(docker('info','--format','{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory":{{json .MemTotal}}}'));
  const generatorCpuLimit=Number(dockerHost.cpus);
  if(!Number.isSafeInteger(generatorCpuLimit)||generatorCpuLimit<=0)throw new Error('Missing Docker CPU capacity');
  save(`${output}/metadata.json`,{scope,timeoutNote,commits,appCapabilities,settings,smoke,diagnostics:diagnosticSettings,scenarios:{mixed:'sends + 500 Channel-list reads/s + 20 correct sign-ins/s'},
    memberArithmetic:'4000 Members; max 2000 sends/s / 4000 = 0.5 sends/s/Member; round robin returns every 2 s; default bucket burst 10, refill 1/s unchanged.',
    databaseFailures:'Counts structured database_failure events by kind during the arm, including the drain.',
    workload:'200 public Channels, index % 200; Member index % 4000; no subscribers. Open arrival k6, 11 s drains; reader 2/s continuous including drains. Success latency includes drain, successful requests only.',
    generator:{allowanceSeconds,cpuLimit:generatorCpuLimit,note:'old: send 100, reads 50, others 10. new: min(maxVUs, max(old, ceil(rate * allowanceSeconds))). Runtime growth is possible below caps. No warm-up.'},
    rule:diagnosticRule,
    node:process.version,machine:{platform:platform(),arch:arch(),release:release(),hostname:hostname(),cpus:cpus(),memory:totalmem()},
    docker:dockerHost,
    harnessCommit:command('git',['rev-parse','HEAD']),dirty:command('git',['status','--porcelain']),
    harnessHashes:Object.fromEntries(harnessFiles.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))});
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
  for(const cell of sequence) {
    check();
    if(!pairStarts.has(cell.pair)) {
      const settleWaitSeconds=await settleHostLoad(()=>loadavg()[0],delay);
      pairStarts.set(cell.pair,{at:Date.now(),hostLoad:loadavg()[0],settleWaitSeconds});
    }
    const id=`${cell.scenario}-${cell.pair}-${cell.arm}`;
    const config=configs[cell.arm];
    const vusLimit=config.lanes.reduce((sum,lane)=>sum+config.scenarios[lane.name].maxVUs,0);
    const appCapability=appCapabilities[cell.arm];
    const generatorVersion=diagnostic.generators[cell.arm];
    const dir=`${output}/${id}`;mkdirSync(dir);
    const privateDir=`${scratch}/${id}`;mkdirSync(privateDir,{mode:0o700});
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONTEXT:process.env.DOCKER_CONTEXT,
      LOAD_PROJECT:`${project}-${id.toLowerCase()}`,LOAD_PORT:'18196',LOAD_DB_PASSWORD:randomUUID(),LOAD_APP_PASSWORD:randomUUID(),
      LOAD_SETUP_TOKEN:randomUUID(),LOAD_APP_IMAGE:images[cell.arm],LOAD_SERVER_SOURCE:`${scratch}/${cell.arm}`,LOAD_SEND_BURST:'10',LOAD_SEND_REFILL_PER_SECOND:'1'};
    const override=`${privateDir}/compose.json`;
    save(override,diagnosticComposeOverride);
    const compose=['compose','--env-file','/dev/null','-p',env.LOAD_PROJECT!,'-f',resolve('load/compose.yml'),'-f',override];
    activeCompose=compose;activeEnv=env;
    const dc=(...args:string[])=>command('docker',[...compose,...args],undefined,env);
    const sql=(query:string)=>command('docker',[...compose,'exec','-T',...untrackedSqlArgs,'db',...psqlArgs],query,env);
    let stopSampling:(()=>Promise<unknown>)|undefined;
    let stopExplain:ReturnType<typeof scheduleExplain>|undefined;
    const explainPath=`${dir}/channel-list-explain-250.json`;
    let startMs:number|undefined;
    let appLog:ReturnType<typeof diagnosticAppEvidence>|undefined;
    let result:(Pick<Run,'steps'> & {lanes:(Counts & {name:string})[];continuousReaderComplete:boolean;runMetrics:Record<string,Counts>;
      diagnosticMetrics?:{http5xx?:number;droppedIterations?:number;vusPeak?:number}})|undefined;
    try {
      console.log(`${scope}: starting ${id} (${commits[cell.arm]}, ${generatorVersion} generator)`);
      dc('up','-d','--no-build','--wait');check();
      const app=dc('ps','-q','app'),db=dc('ps','-q','db');
      sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
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
      const explainStep=config.steps.find(s=>s.rate===250);
      let visibleChannels:string[]=[];
      for(const [org,token] of [[organization,tokens[0]],[otherOrganization,reader.token]]) {
        const r=await fetch(`${base}/api/v1/orgs/${org}/channels`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
        if(r.status!==200)throw new Error('Fixture preflight failed');
        if(explainStep && org===organization)visibleChannels=((await r.json()) as ChannelList).channels.map(c=>c.id);
        else await r.arrayBuffer();
      }
      let explain:ReturnType<typeof explainFixture>|undefined;
      if(explainStep) {
        try { explain=explainFixture(`${scratch}/${cell.arm}`,sql,organization,visibleChannels); }
        catch { save(explainPath,{status:'NOT CAPTURED',reason:'EXPLAIN fixture unavailable in arm'}); }
      }
      save(`${privateDir}/data.json`,{organization,otherOrganization,reader:reader.token,channels,password});
      save(`${privateDir}/tokens.json`,tokens);
      const runDiagnostics={generatorVersion,k6Scenarios:config.scenarios,effectiveSendRates:config.steps.map(s=>s.rate),
        samples:'results.json',database:{pgStatStatements:'pg-stat-statements.json',channelListExplain:explain?'channel-list-explain-250.json':null,explainBindings:explain?.bindings}};
      save(`${dir}/metadata.json`,{scope,...cell,commit:commits[cell.arm],appImage:docker('inspect','--format','{{.Image}}',app),dbImage:docker('inspect','--format','{{.Image}}',db),settings,smoke,diagnostics:runDiagnostics,
        dbSettings:sql("SELECT name||'='||setting FROM pg_settings WHERE name IN ('max_connections','shared_buffers','statement_timeout','lock_timeout','shared_preload_libraries','pg_stat_statements.track') ORDER BY name"),
        roleSettings:sql("SELECT rolname,rolconfig FROM pg_roles WHERE rolname IN ('fukulow','fukulow_app')"),started:new Date().toISOString()});
      sql('SELECT pg_stat_statements_reset();');
      const pgStatsResetAt=Date.now();
      const appSampler=sampler(async ()=>{
        const [proc,pg]=await Promise.all([
          exec('docker',['exec',app,'cat','/proc/1/stat','/proc/1/status'],{env,timeout:2500}),
          exec('docker',['exec',...untrackedSqlArgs,db,...psqlArgs,'-c',activitySql],{env,timeout:2500}),
        ]);
        return {...processStats(proc.stdout),...parseActivity(pg.stdout)};
      });
      stopSampling=appSampler.stop;
      const name=`${project}-generator`;
      generatorName=name;
      generator=spawn('docker',['run','--rm','--name',name,'--network',`${env.LOAD_PROJECT}_default`,
        '--cpus',String(generatorCpuLimit),'--user','0:0',
        '-v',`${resolve('.') }:/work:ro`,'-v',`${privateDir}:/fixture:ro`,'-w','/work',
        '-e','BASE_URL=http://app:8080','-e','POOL_DIAGNOSTIC=1','-e',`POOL_SMOKE=${smoke?'1':'0'}`,'-e',`POOL_SCENARIO=${cell.scenario}`,
        '-e',`POOL_GENERATOR=${generatorVersion}`,'-e',`DIAG_RATES=${diagnostic.rates.join(',')}`,
        k6Id,'run','--address',k6Address,'load/pool-before-after-load.ts'],{env,stdio:['ignore','pipe','pipe']});
      const k6Sampler=sampler(async ()=>generatorStats((await exec('docker',['exec',name,'sh','-c',generatorProbe],{env,timeout:2500})).stdout));
      stopSampling=()=>Promise.all([appSampler.stop(),k6Sampler.stop()]);
      if(explain)save(explainPath,{status:'NOT CAPTURED',reason:'250/s boundary not observed',bindings:explain.bindings});
      const observeStart=(log:string)=>{
        if(startMs!==undefined)return;
        const marker=log.match(/POOL_START (\d{13})(?!\d)/);
        if(!marker)return;
        startMs=Number(marker[1]);
        if(!explainStep||!explain)return;
        const boundary=startMs+(explainStep.startSeconds+explainStep.seconds)*1000;
        stopExplain=scheduleExplain(boundary,explain,async (query,timeout)=>{
          const child=exec('docker',['exec','-i',...untrackedSqlArgs,db,...psqlArgs],{env,timeout});
          child.child.stdin!.on('error',()=>{}).end(query);
          return (await child).stdout;
        });
      };
      // POOL_RESULT is parsed from stdout alone so stderr chunks can never split it.
      let stdout='',stderr='';
      generator.stdout!.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();observeStart(stdout);});
      generator.stderr!.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();observeStart(stderr);});
      const code=await new Promise<number>((done,reject)=>{generator!.on('error',reject);generator!.on('close',c=>done(c??1));});
      const endedAt=Date.now();
      const explainCapture=stopExplain?.();
      const samplingStopped=stopSampling();
      writeFileSync(`${dir}/generator.log`,stderr);writeFileSync(`${dir}/generator.stdout.log`,stdout);
      const pgStatsReadAt=Date.now();
      let statements:unknown;
      try { statements=JSON.parse(sql(topStatementsSql)); } catch { /* missing evidence */ }
      save(`${dir}/pg-stat-statements.json`,{resetAt:pgStatsResetAt,readAt:pgStatsReadAt,statements:statements??null});
      await samplingStopped;stopSampling=undefined;
      const explainResult=await explainCapture;
      stopExplain=undefined;
      if(explainResult)save(explainPath,explainResult);
      if(appCapability.emitsPoolStats) {
        // appEvidence needs the next one-second pool_stats tick to bracket the end.
        await delay(Math.max(0, endedAt+1100-Date.now()));
        let logs='',logError:string|undefined;
        try {
          logs=command('docker',[...compose,'logs','--no-color','--no-log-prefix','app'],undefined,env,diagnosticLogBufferBytes);
        } catch { logError='app log read failed'; }
        if(startMs!==undefined)appLog=diagnosticAppEvidence(logs,startMs,endedAt,logError);
      } else if(startMs!==undefined) {
        const startedAt=Date.now();
        const logs=spawnSync('docker',['logs','--timestamps',app],{env,encoding:'utf8',maxBuffer:diagnosticLogBufferBytes});
        const logError=logs.status===0?undefined:'app log read failed';
        let uninterrupted=false;
        try {
          const [running,restarts,started]=command('docker',['inspect','--format','{{.State.Running}} {{.RestartCount}} {{.State.StartedAt}}',app],undefined,env).split(' ');
          uninterrupted=running==='true'&&restarts==='0'&&Date.parse(started)<=startMs;
        } catch { /* Cannot prove coverage. */ }
        appLog=diagnosticAppEvidence(logError?'':`${logs.stdout}\n${logs.stderr}`,startMs,endedAt,logError,{startedAt,uninterrupted});
      }
      const line=stdout.split('\n').find(l=>l.startsWith('POOL_RESULT '));
      if(line)result=JSON.parse(line.slice(12));
      if(!result||startMs===undefined||!appLog)throw new Error('Missing generator evidence');
      if(result.steps.length!==config.steps.length||result.steps.some((step,i)=>step.rate!==config.steps[i].rate||step.seconds!==config.steps[i].seconds))
        throw new Error('Unexpected generator schedule');
      check();
      const resources=(from:number,to:number)=> {
        const {records,...appResources}=sampleWindow(appSampler,from,to);
        const {dbConnectionsInUse,dbActive,...dbActivity}=activityWindow(records);
        return {...appResources,dbConnectionsInUse,dbActive,dbActivity,generator:generatorWindow(k6Sampler,from,to,vusLimit)};
      };
      const steps=result.steps.map((r,i)=>{
        const step=config.steps[i];
        const stats=resources(startMs!+step.startSeconds*1000,startMs!+(step.startSeconds+step.seconds)*1000);
        return {...r,resources:stats,evidence:{complete:result!.continuousReaderComplete,samples:stats.samples,maxSampleGapMs:stats.maxSampleGapMs,samplingErrors:stats.samplingErrors}};
      });
      const run={scope,...cell,commit:commits[cell.arm],smoke,steps,reader:{...result.runMetrics.reader,rate:2,seconds:config.duration},
        diagnostics:{...runDiagnostics,startMs,endedAt,pgStatsResetAt,pgStatsReadAt,explainStatus:explainResult?.status??(explainStep?'NOT CAPTURED':null)}};
      const metrics=result.diagnosticMetrics;
      const failures=appFailures(result.lanes,metrics?.http5xx,appLog);
      const send=steps[0].send;
      const approvedSchedule=steps.length===1&&steps[0].rate===diagnosticRule.sendRate&&steps[0].seconds===diagnosticRule.seconds;
      const scheduledEnd=startMs+config.duration*1000;
      const stats=resources(startMs,scheduledEnd);
      const generatorRun=generatorWindow(k6Sampler,startMs,Math.max(scheduledEnd,endedAt),vusLimit);
      const pairStart=pairStarts.get(cell.pair);
      const scheduledSendAttempts=steps[0].rate*steps[0].seconds;
      const validity=diagnosticValidity({hostLoad:pairStart?.hostLoad,approvedSchedule,scheduledSendAttempts,
        send,lanes:result.lanes,expectedLanes:config.lanes.map(lane=>lane.name),
        resources:{...stats,complete:endedAt>=scheduledEnd},generator:stats.generator,
        cpuLimit:generatorCpuLimit,vusLimit,vusPeak:metrics?.vusPeak,droppedIterations:metrics?.droppedIterations,generatorExitCode:code,
        http5xx:metrics?.http5xx,app:appLog,statementsCaptured:Array.isArray(statements)&&statements.length>0,
        generatorRun});
      const armResult={...appCapability,validity,sendP95Ms:send.p95,hasAppFailure:hasAppFailure(failures),failures,
        sendSchedule:{attempted:send.attempted,droppedIterations:send.droppedIterations,scheduledSendAttempts}};
      save(`${dir}/results.json`,{...run,...armResult,timeoutNote,pairStart,appEvidence:appLog,scheduledSendAttempts,generatorCpuLimit,vusLimit,generatorExitCode:code,
        lanes:result.lanes,runMetrics:result.runMetrics,diagnosticMetrics:metrics,resources:stats,samples:appSampler.samples,
        generatorRun,generatorSamples:k6Sampler.samples,generatorSamplingErrorTimes:k6Sampler.errors});
      runs.set(id,armResult);
      if(code!==0)failed=true;
    } catch {
      failed=true;
      const reason=interrupted?'interrupted':'failed before evidence was collected';
      const armResult=missingArm(cell.arm,`arm-run ${reason}`);
      runs.set(id,armResult);
      save(`${dir}/results.json`,{scope,...cell,...armResult,appEvidence:appLog});
      console.error(`${scope}: ${id} ${reason}`);
    } finally {
      const explainCapture=stopExplain?.();
      await stopSampling?.();
      const explainResult=await explainCapture;
      if(explainResult)save(explainPath,explainResult);
      if(generatorName){try{docker('rm','-f',generatorName);}catch{/* --rm may already have removed it */}generatorName=undefined;}
      try{dc('down','--volumes','--remove-orphans');activeCompose=undefined;activeEnv=undefined;}catch{cleanupErrors.push(`${id}: Compose cleanup failed`);}
      rmSync(privateDir,{recursive:true,force:true});
    }
    saveResults();
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
  const complete=!failed&&!interrupted&&!cleanupErrors.length&&runs.size===sequence.length;
  saveResults(complete);
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
console.log(`${scope}: artifacts ${output}`);
process.exitCode=failed||interrupted||cleanupErrors.length?1:0;
