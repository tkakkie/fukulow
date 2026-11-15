import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Database, docker, image } from './database.ts';
import { alternating, arms, gates, repetition, type Sample, type Conditions } from './model.ts';
import { setup, bench, scenarios, fixtureSize, replay, migration } from './measure.ts';
const help=`Issue #160 DB log comparison (no production server or migrations).
Usage: node load/log-compare/run.ts --smoke --out /private/tmp/i160-smoke
       node load/log-compare/run.ts --full --out /private/tmp/i160-full
Options: --rates 50,250,1000   fixed offered ops/s (default full: 50,250,1000)
         --seconds 30        fixed-rate seconds per arm (default full: 30)
         --max-seconds 15    unthrottled maximum-throughput step per arm
         --clients 16        pgbench connections (default full: 16)
         --rounds 3          alternating rounds, minimum 3
         --help              show this procedure
Full: 12 workloads (1/200 Channels x 17-byte/4000-scalar bodies x creation/90-5-3-2/
50-20-20-10), five arms including both payload policies, 3 alternating rounds
at every offered rate; separate fresh data for each maximum step. Seed 160,
100k Messages in the hot Channel or 1k per each of 200 Channels. New Topics
(10%) and Replies (20%, inheriting parent Topic); maximum body is 16000 UTF-8
bytes. Creates reply to a separate root, so Move stays bounded at 8 Messages.
Replay: 50-entry recent/deep pages at 100k and 1M logical positions, creation/
mixed/deleted ranges, PG-cold then warm; raw EXPLAIN ANALYZE BUFFERS JSON.
Migration: 1M baseline Messages -> each candidate, three alternating rounds,
blocking SHARE lock with an observed concurrent candidate-aware writer wait.
Smoke: 1 second fixed at 20/s + 1 second max, 2 clients, 4 representative
workloads, 1/100 hot/replay/backfill scale; many-Channel seeds have a 200-row
floor to exercise all shapes. Smoke does not establish any performance gate.
No pg dependency: use bundled pgbench/psql in the image pinned in load/compose.yml.
Own container/volume, no published port, no shared DB, cleanup in finally/signals.
Artifacts: metadata, source hashes/patch, per-arm transaction logs, relation
sizes, WAL, replay plans, migration lock waits, and reported gates in results.json.
Label MAC-RELATIVE. Absolute budgets NOT EVALUATED (#431). No policy adopted.
Correctness: zero missing/out-of-order positions, resurrected bodies or retry/
rollback positions. Invalid: errors, skipped/dropped work, latency-limit overruns,
unmatched conditions, fewer than 3 rounds, or spread (max-min)/median >10%.
At the highest valid common offered rate: throughput >=90%, p95 <=110% baseline.
Creation WAL and total storage <=2x baseline. Every rate/gate is still reported.
Cold means PostgreSQL shared buffers cleared by restart; OS/VM cache may be warm.
The harness omits auth/RLS/Unread/Mentions, WebSockets and client migration.
Expected full duration: roughly 6-12 hours plus machine-dependent seed/I/O time;
full measurements must run alone. Only run --smoke alongside other work.
Exit 0 = procedure finished; gates are reported, never converted into a policy.
Fatal harness/setup errors exit nonzero and preserve partial artifacts.
`;
if(process.argv.includes('--help')) { console.log(help); process.exit(0); }
const args=process.argv.slice(2);
const smoke=args.includes('--smoke'),full=args.includes('--full');
if(smoke===full) throw new Error('choose exactly --smoke or --full (see --help)');
const option=(name:string,fallback:string)=>{const i=args.indexOf(name);if(i<0)return fallback;if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`missing ${name}`);return args[i+1];};
const integer=(name:string,fallback:number,min=1)=>{const n=Number(option(name,String(fallback)));if(!Number.isSafeInteger(n)||n<min)throw new Error(`invalid ${name}`);return n;};
const known=new Set(['--smoke','--full','--out','--rates','--seconds','--max-seconds','--clients','--rounds']);
for(let i=0;i<args.length;i++) {if(!known.has(args[i]))throw new Error(`unknown option ${args[i]}`);if(!['--smoke','--full'].includes(args[i]))i++;}
if(smoke && args.some(a=>['--rates','--seconds','--max-seconds','--clients','--rounds'].includes(a)))throw new Error('smoke parameters are bounded; use --full for overrides');
const rounds=integer('--rounds',3,3),seconds=integer('--seconds',smoke?1:30),maxSeconds=integer('--max-seconds',smoke?1:15),clients=integer('--clients',smoke?2:16);
if(clients>32)throw new Error('clients must be <=32');
const rates=option('--rates',smoke?'20':'50,250,1000').split(',').map(Number);
if(rates.some(n=>!Number.isSafeInteger(n)||n<=0)||new Set(rates).size!==rates.length)throw new Error('invalid rates');
rates.sort((a,b)=>a-b);
const out=resolve(option('--out',`/private/tmp/fukulow-i160-${Date.now()}`));
if(out===process.cwd() || out.startsWith(process.cwd()+'/'))throw new Error('artifacts must be outside checkout');
mkdirSync(out,{recursive:true});
const save=(name:string,value:unknown)=>writeFileSync(`${out}/${name}`,JSON.stringify(value,null,2));
const command=(file:string,...argv:string[])=>execFileSync(file,argv,{encoding:'utf8'}).trim();
const db=new Database();
let interrupted=false;
const signal=()=>{interrupted=true;};
process.on('SIGINT',signal);process.on('SIGTERM',signal);
const check=()=>{if(interrupted)throw new Error('measurement interrupted');};
const samples:Sample[]=[],maxima:Awaited<ReturnType<typeof bench>>[]=[],
  replays:(Awaited<ReturnType<typeof replay>> & {round:number})[]=[],
  migrations:(Awaited<ReturnType<typeof migration>> & {round:number})[]=[];
const results:Record<string,unknown>={label:'MAC-RELATIVE',absoluteBudgets:'NOT EVALUATED (#431)',smoke,complete:false,
  samples,maxima,replays,migrations};
try {
  console.log(`MAC-RELATIVE ${smoke?'SMOKE':'FULL'} artifacts: ${out}; container: ${db.name}`);
  db.start();await db.ready();db.reset();
  const config=db.sql(`SELECT json_object_agg(name,setting ORDER BY name) FROM pg_settings WHERE name NOT IN
    ('data_directory','config_file','hba_file','ident_file','external_pid_file','unix_socket_directories','log_directory')`);
  const machine={platform:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,cpus:cpus().length,memory:totalmem(),
    docker:JSON.parse(docker('info','--format','{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory":{{json .MemTotal}}}'))};
  const sourceFiles=readdirSync(new URL('.',import.meta.url)).filter(n=>/\.(ts|sql)$/.test(n)).sort();
  const metadata={sourceSHA:command('git','rev-parse','HEAD'),dirty:command('git','status','--short'),hostNode:process.version,
    expectedNode:readFileSync('.node-version','utf8').trim(),machine,image,
    imageID:docker('inspect','--format','{{.Image}}',db.name),
    imageDigests:docker('image','inspect','--format','{{json .RepoDigests}}',image!),config:JSON.parse(config),
    pgbench:docker('exec',db.name,'pgbench','--version'),startedAt:new Date().toISOString(),
    competingContainers:docker('ps','--format','{{.Names}}\t{{.Image}}\t{{.Status}}'),
    sourceHashes:Object.fromEntries(sourceFiles.map(n=>[n,createHash('sha256').update(readFileSync(new URL(n,import.meta.url))).digest('hex')])),
    configOptions:{rates,rounds,seconds,maxSeconds,clients,seed:160},
    limits:'DB-only owner-role synthetic shapes; PG-cold does not evict filesystem cache; no WebSocket/client or absolute-budget claim'};
  save('metadata.json',metadata);writeFileSync(`${out}/source.patch`,command('git','diff','HEAD'));
  const selected=smoke ? scenarios.filter(s=>['create-1-17','create-200-4000','mixed90-200-4000','mixed50-1-17'].includes(s.name)) : scenarios;
  const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  for(const scenario of selected) {
    const groups:ReturnType<typeof gates>[]=[];
    for(const rate of rates) {
      const group:Sample[]=[];
      for(let round=0;round<rounds;round++) for(const arm of alternating(round)) {
        check();const count=fixtureSize(scenario,smoke);
        await setup(db,arm,scenario.channels,count);
        const conditions:Conditions={scenario:scenario.name,rate,seconds,clients,seed:160,
          image:metadata.imageID,config:hash(metadata.config),machine:hash(machine)};
        const sample=await bench(db,arm,scenario,conditions,round,`${out}/${scenario.name}-${rate}-${round}-${arm}`);
        group.push(sample);samples.push(sample);
        console.log(`${scenario.name} rate=${rate} round=${round+1} ${arm}: ${sample.tps.toFixed(1)}/s p95=${sample.p95.toFixed(3)}ms correctness=${JSON.stringify(sample.correctness)}`);
        save('results.json',results);
      }
      const verdict=gates(group,scenario.mix[0]===100);groups.push(verdict);
      save(`${scenario.name}-${rate}-gates.json`,verdict);
    }
    const matched=groups.map((g,i)=>({rate:rates[i],...g})).filter(g=>g.valid).at(-1);
    results[scenario.name]={rates:groups,matchedSustainable:matched??'NONE: no valid common sustainable rate',
      interpretation:smoke?'SMOKE ONLY; no performance conclusion':'reported only; no policy adoption'};
    for(let round=0;round<rounds;round++)for(const arm of alternating(round)) {
      check();await setup(db,arm,scenario.channels,fixtureSize(scenario,smoke));
      maxima.push(await bench(db,arm,scenario,{scenario:scenario.name,rate:0,seconds:maxSeconds,clients,seed:160,
        image:metadata.imageID,config:hash(metadata.config),machine:hash(machine)},round,
        `${out}/${scenario.name}-max-${round}-${arm}`,true));
    }
  }
  for(const positions of (smoke?[10000]:[100000,1000000])) for(const range of ['creation','mixed','deleted'] as const)
    for(let round=0;round<(smoke?1:rounds);round++)for(const arm of alternating(round)) {
      check();console.log(`Replay ${arm} ${positions} ${range} round=${round+1}`);
      replays.push({round,...await replay(db,arm,positions,range,`${out}/replay-${positions}-${range}-${round}-${arm}.json`)});
      save('results.json',results);
    }
  for(let round=0;round<(smoke?1:rounds);round++) for(const arm of alternating(round).filter(a=>a!=='baseline')) {
    check();console.log(`Migration ${arm} round=${round+1}`);
    migrations.push({round,...await migration(db,arm,smoke?10000:1000000,`${out}/migration-${round}-${arm}.json`)});save('results.json',results);
  }
  results.maximumSpread=selected.flatMap(scenario=>arms.map(arm=>({scenario:scenario.name,arm,
    tps:repetition(maxima.filter(m=>m.arm===arm && m.conditions.scenario===scenario.name).map(m=>m.tps)),
    p95:repetition(maxima.filter(m=>m.arm===arm && m.conditions.scenario===scenario.name).map(m=>m.p95))})));
  results.migrationSpread=arms.filter(a=>a!=='baseline').map(arm=>({arm,
    duration:repetition(migrations.filter(m=>m.arm===arm).map(m=>m.durationMs)),
    wal:repetition(migrations.filter(m=>m.arm===arm).map(m=>m.walBytes)),
    blocking:repetition(migrations.filter(m=>m.arm===arm).map(m=>m.blockingMs))}));
  results.replaySpread=replays.filter(r=>r.round===0).map(first=>({arm:first.arm,positions:first.positions,range:first.range,
    pages:['recent','deep'].flatMap(depth=>['cold','warm'].map(cache=>({depth,cache,
      execution:repetition(replays.filter(r=>r.arm===first.arm && r.positions===first.positions && r.range===first.range)
        .flatMap(r=>r.rows as {depth:string;cache:string;executionMs:number}[])
        .filter(r=>r.depth===depth && r.cache===cache).map(r=>r.executionMs))})))}));
  results.complete=true;results.finishedAt=new Date().toISOString();save('results.json',results);
  console.log(`Completed ${samples.length} fixed-rate arms, ${maxima.length} maximum steps, ${replays.length} replay fixtures, ${migrations.length} migrations. Gates reported only. ${out}`);
} catch(error) {
  results.error=String(error);save('results.json',results);throw error;
} finally {
  process.off('SIGINT',signal);process.off('SIGTERM',signal);
  db.cleanup();
}
