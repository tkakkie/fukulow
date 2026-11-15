// Remote Linux worker. This file is transported with the existing harness, not installed globally.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { lines, parseSend } from './dms-formal-results.ts';
import { currentGroup, stopRecordedGroups } from './dms-formal-groups.ts';
import { checked, execute } from './dms-formal-exec.ts';
import { quote } from './dms-formal-config.ts';
import { statSync, renameSync } from 'node:fs';
import { copyVolume, removeCopy } from './dms-formal-copy.ts';
import { requireHeadroom, directoryBytes, GiB, summaryLimit } from './dms-formal-storage.ts';
import { histogramsSql } from './dms-formal-histograms.ts';
import { reportAttempt } from './dms-formal-results.ts';
export type HostState = { id: string; sha: string; role: 'app' | 'db' | 'generator'; mode: 'formal' | 'smoke'; appAddress: string; dbAddress: string; dbPassword: string; appPassword: string; setupToken: string; k6: string; postgres: string; caddy: string; nodeVersion: string; generatorTarget:string; attempts:number };
const root = resolve(import.meta.dirname,'../..');
const statePath = `${root}/state.json`;
let cleaning = false;
const docker = (args: string[], input?: string, timeout = 120000) => {
  if (!cleaning && existsSync(`${root}/stopping`)) throw new Error('Run has been stopped');
  return checked(execute, { program: 'docker', args, input, timeout });
};
const command = (program: string, args: string[], timeout = 120000) => checked(execute, { program,args,timeout });
const save = (path: string, value: unknown) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value,null,2), { mode: 0o600 });
function state(): HostState { return JSON.parse(readFileSync(statePath,'utf8')); }
const image = (s: HostState) => `${s.id}:release`;
const compose = (s: HostState) => ['compose','--env-file',`${root}/compose.env`,'-p',s.id,'-f',`${root}/source/load/compose.yml`,'-f',`${root}/db.json`];
const sql = (s: HostState, input: string) => docker(['exec','-i',`${s.id}-db-1`,'psql','-X','-U','fukulow','-d','fukulow','-v','ON_ERROR_STOP=1','-At'], input, 600000);
const countsSql = "SELECT json_build_object('organizations',(SELECT count(*) FROM organizations),'members',(SELECT count(*) FROM users),'dms',(SELECT count(*) FROM channels WHERE kind='dm'),'grants',(SELECT count(*) FROM channel_members WHERE dm_created_at IS NOT NULL),'messages',(SELECT count(*) FROM messages),'discovery',(SELECT count(*) FROM dm_discovery),'counters',(SELECT count(*) FROM dm_discovery_counters));";
async function preflight(s: HostState) {
  const info = JSON.parse(await docker(['info','--format','{{json .}}']));
  const machine = await command('cat',['/etc/machine-id']);
  const memory = Number((await command('cat',['/proc/meminfo'])).match(/MemTotal:\s+(\d+)/)?.[1])*1024;
  const diskRoot=s.role==='db'?info.DockerRootDir:root;
  requireHeadroom(diskRoot,s.mode==='smoke'?2*GiB:(s.role==='generator'?(100+100*s.attempts):s.role==='db'?400:10)*GiB);
  const disk = await command('df',['-B1','--output=size,avail',diskRoot]);
  const diskNumbers = disk.trim().split('\n').at(-1)!.trim().split(/\s+/).map(Number);
  const fs = await command('findmnt',['-J','-T',diskRoot,'-o','SOURCE,FSTYPE,OPTIONS']);
  const source=JSON.parse(fs).filesystems[0].source.split('[')[0];
  const blocks = await command('lsblk',['-J','-o','NAME,TYPE,ROTA,SIZE,MOUNTPOINTS',...(source.startsWith('/dev/') ? ['-s',source] : [])]);
  const clock = await command('timedatectl',['show','--property=NTPSynchronized','--value']);
  const limits = await command('sh',['-c','ulimit -Hn; cat /proc/sys/fs/file-max /proc/sys/net/ipv4/ip_local_port_range']);
  const cpu = await command('lscpu',['-J']);
  const node = await command('node',['--version']);
  const running = await docker(['ps','-q']);
  const record = { machine, memory, disk, fs:JSON.parse(fs), blocks:JSON.parse(blocks), clock, limits, cpu:JSON.parse(cpu), kernel:await command('uname',['-a']), docker:info, compose:await docker(['compose','version']), node, running };
  save(`${root}/preflight.json`,record);
  if(s.role!=='generator')await command('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes',s.generatorTarget,'true']);
  if (process.platform !== 'linux' || node !== `v${s.nodeVersion}` || clock !== 'yes') throw new Error('Linux, exact Node version and synchronized NTP required');
  if (running) throw new Error('Dedicated hosts must have no running Docker containers');
  if (info.Warnings?.some((value:string)=>/No (memory|cpu|cpuset)|No swap limit/.test(value))) throw new Error('Docker resource enforcement unavailable');
  if (info.SecurityOptions?.some((value: string) => value.includes('rootless')) || !info.CgroupVersion || info.NCPU < (s.mode === 'smoke' ? 1 : 8)) throw new Error('Docker CPU/cgroup enforcement required');
  if (Number(limits.split('\n')[0]) < 65536) throw new Error('Hard nofile limit below 65536');
  if (s.mode !== 'smoke') {
    const minRam = s.role === 'db' ? 32 : s.role === 'generator' ? 16 : 4;
    if (memory < minRam*1024**3 || info.MemTotal < minRam*1024**3) throw new Error('Insufficient host/Docker RAM');
    if (s.role === 'db' && (diskNumbers[0] < 500*1024**3 || diskNumbers[1] < 400*1024**3)) throw new Error('DB needs local SSD >=500 GiB and >=400 GiB free for seed and snapshot');
    if (s.role === 'db' && (!source.startsWith('/dev/') || /"rota":\s*true/.test(blocks) || !/"rota":\s*false/.test(blocks) || /nfs|cifs|overlay/.test(fs))) throw new Error('DB storage must be a local SSD filesystem');
  }
  return record;
}
async function clone(s: HostState) {
  await command('git',['clone','--no-checkout','https://github.com/tkakkie/fukulow.git',`${root}/source`],600000);
  await command('git',['-C',`${root}/source`,'checkout','--detach',s.sha],120000);
  if (await command('git',['-C',`${root}/source`,'rev-parse','HEAD']) !== s.sha) throw new Error('Source SHA mismatch');
  if(readFileSync(`${root}/source/.node-version`,'utf8').trim()!==s.nodeVersion)throw new Error('Source/operator Node pins differ');
  save(`${root}/source-toolchains.json`,{sha:s.sha,node:readFileSync(`${root}/source/.node-version`,'utf8').trim(),rust:readFileSync(`${root}/source/rust-toolchain.toml`,'utf8'),dockerfile:readFileSync(`${root}/source/Dockerfile`,'utf8')});
}
async function database(s: HostState) {
  save(`${root}/image.json`,await docker(['image','inspect',image(s)]));
  await clone(s);
  if (!readFileSync(`${root}/source/load/compose.yml`,'utf8').includes(s.postgres)) throw new Error('PostgreSQL pin differs from requested SHA');
  save(`${root}/compose.env`, `LOAD_PROJECT=${s.id}\nLOAD_APP_IMAGE=${image(s)}\nLOAD_DB_PASSWORD=${s.dbPassword}\nLOAD_APP_PASSWORD=${s.appPassword}\nLOAD_SETUP_TOKEN=${s.setupToken}\nLOAD_PORT=18151\n`);
  const memory = s.mode === 'smoke' ? '2g' : '32g';
  save(`${root}/db.json`,{ services:{ db:{ cpus:s.mode === 'smoke' ? 1 : 8, mem_limit:memory, ports:['5432:5432'], volumes:[`${s.id}-data:/var/lib/postgresql`], command:['postgres','-c','shared_preload_libraries=pg_stat_statements','-c','pg_stat_statements.track=all','-c','max_connections=64'] } }, volumes:{ [`${s.id}-data`]:{name:`${s.id}-data`,labels:{'dm-formal':s.id}} } });
  await docker([...compose(s),'up','-d','--no-build','--wait','db'],undefined,180000);
  await docker([...compose(s),'run','--rm','migrate'],undefined,600000);
  await sql(s,'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
  save(`${root}/base-images.json`, await docker(['image','inspect',s.postgres]));
  const guards = await sql(s,"SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname='fukulow_app'; SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('accounts','account_sessions','_sqlx_migrations') AND NOT rowsecurity;");
  if (guards !== 't\n0') throw new Error('Restricted app role/RLS check failed');
  save(`${root}/db-guards.txt`,guards);
  save(`${root}/db-caps.json`,await docker(['inspect',`${s.id}-db-1`]));
}
async function app(s: HostState) {
  await docker(['network','create','--label',`dm-formal=${s.id}`,`${s.id}-edge`]);
  save(`${root}/app.env`, `DATABASE_URL=postgres://fukulow_app:${s.appPassword}@${s.dbAddress}:5432/fukulow\nFUKULOW_DB_MAX_CONNECTIONS=32\nFUKULOW_COOKIE_SECURE=true\nFUKULOW_ADDR=0.0.0.0:8080\nFUKULOW_SETUP_TOKEN=${s.setupToken}\nFUKULOW_TRUSTED_PROXIES=${s.id}-caddy\nFUKULOW_CLIENT_IP_HEADER=x-forwarded-for\n`);
  // Resolve the proxy's address first, preserving production trusted-proxy semantics.
  const caddyfile = readFileSync(`${root}/harness/deploy/Caddyfile`,'utf8').replace('\n\t@static', '\n\ttls internal\n\t@static');
  save(`${root}/Caddyfile`,caddyfile);
  await docker(['volume','create','--label',`dm-formal=${s.id}`,`${s.id}-caddy-data`]);
  await docker(['run','-d','--log-driver','json-file','--log-opt','max-size=10m','--log-opt','max-file=3','--name',`${s.id}-caddy`,'--label',`dm-formal=${s.id}`,'--network',`${s.id}-edge`,'-p','443:443','-e',`FUKULOW_DOMAIN=${s.appAddress}`,'-v',`${root}/Caddyfile:/etc/caddy/Caddyfile:ro`,'-v',`${s.id}-caddy-data:/data`,s.caddy]);
  const proxy = await docker(['inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',`${s.id}-caddy`]);
  const env = readFileSync(`${root}/app.env`,'utf8').replace(`${s.id}-caddy`,proxy);
  save(`${root}/app.env`,env);
  await docker(['run','-d','--log-driver','json-file','--log-opt','max-size=10m','--log-opt','max-file=3','--name',`${s.id}-app-1`,'--label',`dm-formal=${s.id}`,'--network',`${s.id}-edge`,'--network-alias','app','--cpus',s.mode === 'smoke' ? '1' : '8','--memory',s.mode === 'smoke' ? '1g' : '4g','--ulimit','nofile=65536:65536','--env-file',`${root}/app.env`,image(s)]);
  for (let i=0;i<60;i++) {
    const probe = await execute({program:'docker',args:['exec',`${s.id}-app-1`,'fukulow-server','probe'],timeout:5000});
    if (probe.code === 0) break;
    if (i === 59) throw new Error('App readiness timeout');
    await delay(1000);
  }
  await docker(['cp',`${s.id}-caddy:/data/caddy/pki/authorities/local/root.crt`,`${root}/ca.crt`]);
  save(`${root}/app-caps.json`,await docker(['inspect',`${s.id}-app-1`]));
}
async function seed(s: HostState) {
  const started = Date.now();
  const env = { ...process.env, DM_DB_CONTAINER:`${s.id}-db-1`, DM_FORMAL_SEED:'1', DM_FORMAL_SMOKE:s.mode === 'smoke' ? '1' : '0', DM_FORMAL_OUT:`${root}/formal`, DM_SEED_OUT:`${root}/deep.json`, DM_OUTPUT:root, BASE_URL:`https://${s.appAddress}`, NODE_EXTRA_CA_CERTS:`${root}/ca.crt`, DM_QUERY_SOURCE:`${root}/source`, DM_PROBE_SAMPLES:'1', DM_SEND_PROBE_SAMPLES:'1' };
  const run = async (script: string) => {
    // Spawned seed/probe children inherit only this private configuration; their output is private.
    const old = process.env; process.env = env;
    try { await checked(execute,{program:process.execPath,args:[`${root}/harness/load/${script}.ts`],timeout:24*60*60*1000,log:`${root}/${script}.log`}); } finally { process.env = old; }
  };
  await run('dms-formal-seed'); await run('dms-seed'); await run('dms-probe');
  const checks=[];
  for(let o=0;o<(s.mode==='smoke'?1:10);o++) {
    const fixture=JSON.parse(readFileSync(`${root}/formal/org-${o}.json`,'utf8'));
    const request=async(index:number,path:string,expected:number,body?:unknown)=>{
      const response=await fetch(`https://${s.appAddress}/api/v1/orgs/${fixture.organization}${path}`,{method:body?'POST':'GET',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${fixture.members[index].token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      await response.text();if(response.status!==expected)throw new Error('Fixture permission/renewal check failed');
    };
    await request(0,'/dms',200);await request(900,'/dms',200);
    await request(900,'/dms',403,{member_id:fixture.members[901].id});
    await request(900,`/channels/${fixture.members[900].channel}/messages`,201,{client_message_id:randomUUID(),body:'x'.repeat(1024)});
    const renewal=fixture.renewals.at(-1);
    await request(renewal.caller,`/channels/${renewal.channel}/messages`,409,{client_message_id:randomUUID(),body:'x'.repeat(1024)});
    await request(renewal.caller,'/dms',200,{member_id:fixture.members[renewal.peer].id,renew:true});
    await request(renewal.caller,`/channels/${renewal.channel}/messages`,201,{client_message_id:randomUUID(),body:'x'.repeat(1024)});
    checks.push({organization:o,memberList:200,guestList:200,guestOpen:403,guestSend:201,lapsedPeerSend:409,actualRenewal:200,afterRenewalSend:201,renewalPool:fixture.renewals.length});
  }
  save(`${root}/fixture-checks.json`,checks);
  save(`${root}/fixture-histograms.json`,await sql(s,histogramsSql));
  await sql(s,'VACUUM(ANALYZE);');
  const seeded=await sql(s,countsSql), actual=JSON.parse(seeded), orgs=s.mode==='smoke'?1:10;
  const expected={organizations:orgs+1,members:orgs*1000+10000,dms:orgs*150000+14999,grants:orgs*300000+29998,messages:orgs*(s.mode==='smoke'?50000:5000000)+3*orgs+2};
  save(`${root}/fixture-count-check.json`,{actual,expected});
  if(Object.entries(expected).some(([key,value])=>actual[key]!==value))throw new Error('Seed row counts differ from the explicit fixture/probe additions');
  save(`${root}/seed-counts.json`,seeded);
  save(`${root}/seed-duration.json`,{ms:Date.now()-started});
  await docker([...compose(s),'stop','db']);
  await docker(['volume','create','--label',`dm-formal=${s.id}`,`${s.id}-snapshot`]);
  await copyVolume(execute,s.id,0,s.id+'-data',s.id+'-snapshot',s.postgres,false);
}
async function restore(s: HostState, attempt: number) {
  const start = Date.now();
  await docker([...compose(s),'stop','db']);
  requireHeadroom((JSON.parse(await docker(['info','--format','{{json .}}']))).DockerRootDir,s.mode==='smoke'?2*GiB:100*GiB);
  await copyVolume(execute,s.id,attempt,s.id+'-snapshot',s.id+'-data',s.postgres,true);
  await docker([...compose(s),'up','-d','--no-build','--wait','db']);
  const counts = await sql(s,countsSql);
  save(`${root}/restore-${attempt}.json`,{ms:Date.now()-start,counts:JSON.parse(counts)});
  if (counts !== readFileSync(`${root}/seed-counts.json`,'utf8')) throw new Error('Restored row counts differ');
  save(`${root}/histograms-before-${attempt}.json`,await sql(s,histogramsSql));
  await sql(s,'SELECT pg_stat_statements_reset();');
}
async function observe(s: HostState, attempt: number, until: number) {
  const directory = `${root}/attempt-${attempt}`; mkdirSync(directory,{recursive:true,mode:0o700});
  const name = `${s.id}-${s.role}-1`;
  let previous: { at:number; usage:number } | undefined;
  let next = Date.now();
  while (Date.now()<until) {
    const start = Date.now();
    try {
      const raw = await docker(['exec',name,'sh','-c','cat /sys/fs/cgroup/cpu.stat /proc/1/status']);
      const usage = Number(raw.match(/usage_usec (\d+)/)?.[1]), rss = Number(raw.match(/VmRSS:\s+(\d+)/)?.[1]);
      const row = { at:start, intervalMs:previous ? start-previous.at : null, cpu:previous ? (usage-previous.usage)/((start-previous.at)*1000) : null, rssKiB:Number.isFinite(rss) ? rss : null };
      appendFileSync(`${directory}/resources-${s.role}.jsonl`,JSON.stringify(row)+'\n',{mode:0o600});
      previous = {at:start,usage};
      if(s.role==='db') appendFileSync(`${directory}/db-activity.jsonl`, JSON.stringify({at:start,activity:JSON.parse(await sql(s,"SELECT json_build_object('connections',count(*),'active',count(*) FILTER(WHERE state='active'),'lockWaiters',count(*) FILTER(WHERE wait_event_type='Lock')) FROM pg_stat_activity WHERE usename='fukulow_app';"))})+'\n',{mode:0o600});
    } catch { appendFileSync(`${directory}/resource-errors-${s.role}.jsonl`,JSON.stringify({at:start})+'\n',{mode:0o600}); }
    next += 1000; await delay(Math.max(0,next-Date.now()));
  }
  if (s.role === 'app') save(`${directory}/app.log`,await docker(['logs','--timestamps',`${s.id}-app-1`],undefined,120000));
  else save(`${directory}/sql-after.json`,await sql(s,"SELECT coalesce(json_agg(t),'[]') FROM (SELECT query,toplevel,calls,total_exec_time,rows FROM pg_stat_statements ORDER BY calls DESC) t;"));
}
async function generators(s: HostState, attempt: number, epoch: number) {
  const directory = `${root}/attempt-${attempt}`; mkdirSync(directory,{recursive:true,mode:0o700});
  const smoke = s.mode === 'smoke', orgs = smoke ? 1 : 10;
  const starts = Array<number>(11).fill(epoch);
  save(`${directory}/window-starts.json`,starts);
  requireHeadroom(root,s.mode==='smoke'?2*GiB:100*GiB);
  let storageFault=false;
  const monitor=setInterval(()=>{
    try {requireHeadroom(root,s.mode==='smoke'?GiB:20*GiB);if(directoryBytes(directory)>100*GiB)throw new Error('Attempt exceeds 100 GiB raw evidence budget');}
    catch { storageFault=true;void docker(['ps','-q','--filter',`label=dm-formal=${s.id}`]).then(ids=>ids?docker(['stop','--time','1',...ids.split(/\s+/)]):undefined).catch(()=>{}); }
  },5000);
  let results:{shard:number;code:number}[];
  try { results = await Promise.all(Array.from({length:orgs+1},async(_,index) => {
    const browser = index === orgs, shard = browser ? 10 : index;
    const out = `${directory}/shard-${shard}`; mkdirSync(out,{recursive:true,mode:0o700});
    const settings = { BASE_URL:`https://${s.appAddress}`, DM_FORMAL:'1', DM_EPOCH:String(epoch), DM_SOCKETS:smoke ? '20' : '1000', DM_SENDERS:smoke ? '10' : '200', DM_OFFSET:'0', DM_SHARD:'0', DM_RATE:browser ? '0' : smoke ? '2' : '200', DM_OPEN_RATE:browser ? '0' : smoke ? '1' : '2', DM_BROWSE_RATE:browser ? smoke ? '2' : '100' : '0', DM_LEDGER:'1', DM_BROWSER_ONLY:browser ? '1' : '0', DM_CONNECT_INTERVAL_MS:smoke ? '1000' : '30000', DM_SEND_START:smoke ? '30' : '300', DM_SECONDS:smoke ? '95' : '2345', SSL_CERT_FILE:'/ca.crt', DM_SMOKE:smoke ? '1' : '0' };
    const args = ['run','--rm','--name',`${s.id}-k6-${shard}`,'--label',`dm-formal=${s.id}`,'--user',`${process.getuid?.()}:${process.getgid?.()}`,'--ulimit','nofile=65536:65536','--sysctl','net.ipv4.ip_local_port_range=1024 65535','-v',`${root}/harness:/work:ro`,'-v',`${browser ? root+'/deep.json' : root+`/formal/org-${index}.json`}:/seed.json:ro`,'-v',`${out}:/output`,'-v',`${root}/ca.crt:/ca.crt:ro`,...Object.entries(settings).flatMap(([key,value])=>['-e',`${key}=${value}`]),s.k6,'run','--log-format','raw','--out','json=/output/metrics.json','/work/load/dms.ts'];
    const result = await execute({program:'docker',args,timeout:(smoke ? 360 : 3000)*1000,log:`${out}/run.log`}).catch(() => ({code:124,stdout:''}));
    save(`${out}/exit.json`,{code:result.code}); return {shard,code:result.code};
  }));
  } finally {clearInterval(monitor);}
  save(`${directory}/exits.json`,results);
  if(storageFault) {save(`${directory}/storage-failure.json`,{failed:true,operation:'generator-storage-monitor'});throw new Error('Generator storage budget/headroom failed');}
  const drained = { attempted:0, succeeded:0, failed:0 };
  for (const {shard} of results) {
    if (shard === 10) continue;
    const seed = JSON.parse(readFileSync(`${root}/formal/org-${shard}.json`,'utf8')) as {members:{id:string;token:string}[]};
    const tokens = new Map(seed.members.map(member=>[member.id,member.token]));
    const pending = new Set<Promise<void>>();
    for await (const line of lines(`${directory}/shard-${shard}/run.log`)) {
      const row = parseSend(line); if (!row || row.status === 201) continue;
      drained.attempted++;
      const task = (async()=>{
        try {
          const response = await fetch(`https://${s.appAddress}/api/v1/orgs/${row.organization}/channels/${row.channel}/messages`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${tokens.get(row.member)}`,'Content-Type':'application/json'},body:JSON.stringify({client_message_id:row.client_message_id,body:JSON.stringify({sent:row.started,phase:'mixed',text:'x'.repeat(976)})})});
          await response.text(); if(response.status===201)drained.succeeded++;else drained.failed++;
        }catch{drained.failed++;}
      })();
      pending.add(task);void task.finally(()=>pending.delete(task));
      if(pending.size>=32)await Promise.race(pending);
    }
    await Promise.all(pending);
  }
  save(`${directory}/drain.json`,drained);
}
async function durable(s: HostState, attempt: number) {
  const directory = `${root}/attempt-${attempt}`; mkdirSync(directory,{recursive:true,mode:0o700});
  // Seed bodies have no mixed timestamp; include every workload row, not just acknowledged ids.
  await checked(execute,{program:'docker',args:['exec','-i',`${s.id}-db-1`,'psql','-X','-U','fukulow','-d','fukulow','-v','ON_ERROR_STOP=1','-At'],input:"SELECT json_build_object('organization',organization_id,'member',sender,'channel',channel_id,'client_message_id',client_message_id,'id',id,'seq',seq) FROM messages WHERE body LIKE '{\"sent\":%\"phase\":\"mixed\"%';",timeout:600000,log:`${directory}/durable.jsonl`});
  save(`${directory}/counts-after.json`,await sql(s,countsSql));
  save(`${directory}/histograms-after.json`,await sql(s,histogramsSql));
}
async function cleanup(s: HostState) {
  cleaning = true; save(`${root}/stopping`,'stopped');
  await stopRecordedGroups(root);
  // Enumerate only exact run-owned labels plus the known Compose project label.
  for (const filter of [`label=dm-formal=${s.id}`,`label=com.docker.compose.project=${s.id}`]) {
    const ids = (await docker(['ps','-aq','--filter',filter])).split(/\s+/).filter(Boolean);
    if (ids.length) await docker(['rm','-fv',...ids]);
  }
  for (const kind of ['network','volume']) for (const filter of [`label=dm-formal=${s.id}`,`label=com.docker.compose.project=${s.id}`]) {
    const ids = (await docker([kind,'ls','-q','--filter',filter])).split(/\s+/).filter(Boolean);
    if (ids.length) await docker([kind,'rm',...ids]);
  }
  const images=await docker(['image','ls','-q',image(s)]);
  if(images)await docker(['image','rm',image(s)]);
  save(`${root}/cleanup-retained.json`,{privateScratch:root,sharedBaseImagesAndBuildCache:true,rawEvidence:'retained on generator until operator deletion'});
  // Pinned shared base images/build cache are deliberately retained.
}
async function main() {
  const s = state(), phase = process.argv[2], attempt = Number(process.argv[3]), epoch = Number(process.argv[4]);
  if (!/^dm-formal-[a-f0-9-]+$/.test(s.id)) throw new Error('Invalid run identity');
  // GNU timeout owns this group. Persist it before any command can start.
  const pidFile=`${root}/worker-${process.pid}.pid`;save(pidFile,String(currentGroup()));
  // Keep ownership records after exit for independent cleanup.
  switch(phase) {
    case 'preflight': console.log(JSON.stringify(await preflight(s))); break;
    case 'rtt': {
      const target = s.role === 'app' ? s.dbAddress : s.appAddress;
      const raw = await command('ping',['-n','-c','20','-i','0.1','-W','2',target]);
      save(`${root}/rtt.txt`,raw);
      const values = /(?:rtt|round-trip)[^=]+=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(raw);
      if (!values || !/\b0% packet loss/.test(raw) || (s.mode !== 'smoke' && Number(values[3])>1)) throw new Error('RTT must be <=1 ms with no loss');
      break;
    }
    case 'build': await clone(s); await docker(['build','--label',`dm-formal=${s.id}`,'--label',`org.opencontainers.image.revision=${s.sha}`,'-t',image(s),`${root}/source`],undefined,7200000); save(`${root}/image.json`,await docker(['image','inspect',image(s)])); break;
    case 'stop-generators': { const ids=(await docker(['ps','-aq','--filter',`label=dm-formal=${s.id}`])).split(/\s+/).filter(Boolean); if(ids.length)await docker(['rm','-f',...ids]); break; }
    case 'prepare-generator': await docker(['pull',s.k6],undefined,600000); save(`${root}/k6-image.json`,await docker(['image','inspect',s.k6])); break;
    case 'database': await database(s); break;
    case 'app': await app(s); save(`${root}/image.json`,await docker(['image','inspect',image(s)])); break;
    case 'seed': await seed(s); break;
    case 'stop-workers': await stopRecordedGroups(root); break;
    case 'stop-copy': await removeCopy(execute,`${s.id}-copy-${attempt}`); break;
    case 'ship': {
      const directory=`${root}/attempt-${attempt}`;
      if(s.role==='db') {
        await command('gzip',['-f',directory+'/durable.jsonl'],900000);
        await command('scp',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',directory+'/durable.jsonl.gz',s.generatorTarget+':'+directory+'/durable.jsonl.gz'],900000);
      }
      for(const file of readdirSync(directory).filter(file=>!file.startsWith('durable')))await command('scp',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',directory+'/'+file,s.generatorTarget+':'+directory+'/'+file],120000);
      break;
    }
    case 'reduce': {
      const directory=`${root}/attempt-${attempt}`;
      requireHeadroom(root,directoryBytes(directory)+(s.mode==='smoke'?GiB:20*GiB));
      await command('gzip',['-df',directory+'/durable.jsonl.gz'],900000);
      await reportAttempt(directory,s.mode,execute);
      rmSync(directory+'/ledger-buckets',{recursive:true,force:true});
      await command('tar',['-czf',`${root}/raw-${attempt}.tgz.tmp`,'-C',directory,...readdirSync(directory).filter(file=>file!=='extended' && !file.startsWith('organization-'))],1800000);
      renameSync(`${root}/raw-${attempt}.tgz.tmp`,`${root}/raw-${attempt}.tgz`);
      const archive=`${root}/raw-${attempt}.tgz`;
      const hash=await command('sha256sum',[archive],600000);
      save(directory+'/manifest.json',{reductionHost:s.generatorTarget,rawPath:archive,rawBytes:statSync(archive).size,sha256:hash.split(' ')[0],retention:'Until operator deletes VM; raw download opt-in'});
      await command('tar',['-czf',`${root}/summary-${attempt}.tgz`,'-C',directory,...['judgment.json','judgment.md','manifest.json','combined.json'].filter(file=>existsSync(directory+'/'+file))],120000);
      if(statSync(`${root}/summary-${attempt}.tgz`).size>summaryLimit)throw new Error('Summary exceeds 32 MiB transfer budget');
      rmSync(directory,{recursive:true,force:true});
      break;
    }
    case 'restore': await restore(s,attempt); break;
    case 'retain-raw': {
      const directory=`${root}/attempt-${attempt}`,archive=`${root}/raw-${attempt}.tgz`;
      if(existsSync(directory) && !existsSync(archive)) {
        requireHeadroom(root,directoryBytes(directory)+GiB);
        await command('tar',['-czf',archive+'.tmp','-C',directory,'.'],1800000);
        renameSync(archive+'.tmp',archive);
        save(`${root}/raw-${attempt}-manifest.json`,{rawPath:archive,rawBytes:statSync(archive).size,sha256:(await command('sha256sum',[archive],600000)).split(' ')[0],incompleteAttempt:true});
        rmSync(directory,{recursive:true,force:true});
      }
      break;
    }
    case 'stop-app': await docker(['stop','--time','75',`${s.id}-app-1`]); break;
    case 'start-app': await docker(['start',`${s.id}-app-1`]); await delay(5000); break;
    case 'observe': await observe(s,attempt,epoch); break;
    case 'generators': await generators(s,attempt,epoch); break;
    case 'durable': await durable(s,attempt); break;
    case 'cleanup': await cleanup(s); break;
    case 'erase': rmSync(root,{recursive:true,force:true}); break;
    default: throw new Error('Unknown phase');
  }
}
if (process.argv[1] === import.meta.filename) main().catch(() => { console.error('Remote phase failed; private artifacts retained until collection'); process.exitCode=1; });
