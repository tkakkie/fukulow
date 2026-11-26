/**
 * #403 runbook — measurement-only; never changes production persistence.
 * Tomorrow, from this worktree root (idle Mac, Docker running):
 *   mise exec node@26.13.1 -- node load/unread-init/run.ts --full --out /private/tmp/fukulow-403-full
 * Today / harness validation only:
 *   mise exec node@26.13.1 -- node load/unread-init/run.ts --pilot --out /private/tmp/fukulow-403-pilot
 * Prerequisites: mise with repo-pinned Node (.node-version), Docker, sqlx CLI supporting --no-dotenv (validated: 0.9.0). No app build, credentials, .env or shared DB required.
 * Uses the exact PostgreSQL digest in load/compose.yml, loopback ephemeral port,
 * own container, migrations via sqlx, production role/grants, fresh DB per repeat.
 * Full defaults: Topics 10,1000,10000; public affected Members 1,100,1000;
 * other operations affect one Member, joining/reactivating across 10 Channels;
 * 3 repeats / side, roughly 30–55 min (printed planning estimate, not a budget).
 * Pilot: Topics 10,1000; Members 1,100; 3 repeats, roughly 2–6 min of wall
 * clock (--estimate prints a conservative 15 min planning allowance).
 * Options: --topics 10,1000 --members 1,100 --repeats 5 --channels 10.
 * --estimate prints the matrix/cost without starting Docker. Large overrides
 * may exceed 60 min. Results JSON + paste-ready summary.md stay outside Git;
 * --out or UNREAD_INIT_OUT selects directory, default mkdtemp under OS tmp.
 * Before full: `uptime`, `ps -axo pid,pcpu,comm` and `docker stats --no-stream`;
 * ensure no cargo builds/tests, load generators or busy app/DB containers, record
 * desktop/other container activity. Wait for idle; do not stop others' containers.
 * Metadata records host/Docker allocation, versions, settings, source hashes and
 * competing containers; inspect them before comparing. Run alone tomorrow.
 * Checks: npm --prefix load run check && npm --prefix load test (both cover unread-init).
 * SQLx is passed --no-dotenv. No secrets or environment files are loaded.
 * SIGINT/SIGTERM stop at the next safe boundary; finally removes only our own
 * container and anonymous volume. On hard kill: docker rm -fv <printed name>.
 * PILOT is not performance evidence and must not enter docs/measurements.md or load/measurements-archive.md.
 */
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,realpathSync } from 'node:fs';
import { resolve,sep } from 'node:path';
import { tmpdir,cpus,arch,platform,release,totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Database,docker,image } from './database.ts';
import { matrix,integers,estimate,equal,oracleDigest,summary,type Sample } from './model.ts';
import { fixture } from './sql.ts';
import { measure, senderBaselineMethod } from './measure.ts';
const argv=process.argv.slice(2);
const flag=(s:string)=>argv.includes(s);
const option=(key:string,fallback:string)=>{const i=argv.indexOf(key);if(i<0)return fallback;if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`missing ${key}`);return argv[i+1];};
const known=new Set(['--full','--pilot','--estimate','--out','--topics','--members','--repeats','--channels']);
for(let i=0;i<argv.length;i++){if(!known.has(argv[i]))throw new Error(`unknown option ${argv[i]}`);if(['--out','--topics','--members','--repeats','--channels'].includes(argv[i]))i++;}
const pilot=flag('--pilot');if(pilot===flag('--full'))throw new Error('choose exactly --pilot or --full');
const topics=integers(option('--topics',pilot?'10,1000':'10,1000,10000'));
const members=integers(option('--members',pilot?'1,100':'1,100,1000'));
const repeats=Number(option('--repeats','3')),channels=Number(option('--channels','10'));
if(pilot&&(topics.some(n=>n>1000)||members.some(n=>n>100)||repeats>3||channels>10))throw new Error('pilot is bounded; use full for larger parameters');
const points=matrix(topics,members),prediction=estimate(points,repeats,channels);
console.log(JSON.stringify({pilot,topics,members,repeats,channels,points:points.length,estimate:prediction}));
if(flag('--estimate'))process.exit(0);
const root=realpathSync(process.cwd());
const out=resolve(flag('--out')?option('--out',''):process.env.UNREAD_INIT_OUT??mkdtempSync(resolve(tmpdir(),'fukulow-403-')));
if(out===root||out.startsWith(root+sep))throw new Error('output must be outside repository');
mkdirSync(out,{recursive:true});const actualOut=realpathSync(out);
if(actualOut===root||actualOut.startsWith(root+sep))throw new Error('output must be outside repository');
const save=(file:string,value:unknown)=>writeFileSync(resolve(out,file),JSON.stringify(value,null,2)+'\n');
// The oracle (full count/projection rows) reaches ~10M Topics at the largest point and overflowed results.json
// (V8 string limit) on the 2026-11-21 rehearsal. Keep each one gzipped in its own file; results.json keeps its digest.
mkdirSync(resolve(out,'oracle'),{recursive:true});
const oracleFile=<T extends {oracle:unknown}>(m:T,label:string)=>{const {text,...digest}=oracleDigest(m.oracle),file=`oracle/${label}.json.gz`;
  writeFileSync(resolve(out,file),gzipSync(text));
  return {...m,oracle:{file,...digest}};};
// Lock samples (pg_locks every 10 ms during the grant) grow with trial length and left ~28% V8 string
// headroom at the 2026-11-22 formal run (#403); keep them per trial like the oracle.
mkdirSync(resolve(out,'locks'),{recursive:true});
const lockFile=<T extends {lockSamples:unknown[]}>(m:T,label:string)=>{const {text,...digest}=oracleDigest(m.lockSamples),file=`locks/${label}.json.gz`;
  writeFileSync(resolve(out,file),gzipSync(text));
  return {...m,lockSamples:{file,count:m.lockSamples.length,...digest}};};
const command=(name:string,...args:string[])=>execFileSync(name,args,{encoding:'utf8'}).trim();
const db=new Database();let interrupted=false;process.on('SIGINT',()=>{interrupted=true;});process.on('SIGTERM',()=>{interrupted=true;});
const check=()=>{if(interrupted)throw new Error('interrupted');};
const samples:Sample[]=[],raw:unknown[]=[];
const result={pilot,complete:false,equalityChecks:0,topics,members,repeats,channels,estimate:prediction,samples,raw};
const started=Date.now();
try {
  console.log(`Artifacts: ${out}; owned container: ${db.name}`);
  db.start();await db.ready();db.migrate();
  const metadata={startedAt:new Date().toISOString(),commit:command('git','rev-parse','HEAD'),dirty:command('git','status','--short'),senderBaselineMethod,
    host:{platform:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,cpus:cpus().length,memory:totalmem()},
    node:process.version,pinnedNode:readFileSync('.node-version','utf8').trim(),sqlx:command('sqlx','--version'),image,
    imageID:docker('inspect','--format','{{.Image}}',db.name),docker:JSON.parse(docker('info','--format','{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory":{{json .MemTotal}}}')),
    uptime:command('uptime'),hostProcesses:command('ps','-axo','pid,pcpu,comm'),containerStats:docker('stats','--no-stream','--format','{{json .}}'),
    competingContainers:docker('ps','--format','{{.Names}}\t{{.Image}}\t{{.Status}}'),
    postgres:db.sql('SELECT version();'),settings:JSON.parse(db.sql(`SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN ('shared_buffers','work_mem','jit','synchronous_commit','fsync','full_page_writes','max_connections','wal_level')`)),
    migrations:JSON.parse(db.sql('SELECT json_agg(t) FROM (SELECT version,encode(checksum,\'hex\') checksum FROM _sqlx_migrations ORDER BY version)t','base')),
    sourceHashes:Object.fromEntries([...readdirSync('load/unread-init').filter(n=>/\.(ts|sql)$/.test(n)).map(n=>'load/unread-init/'+n),...readdirSync('server/migrations').filter(n=>n.endsWith('.sql')).map(n=>'server/migrations/'+n),'server/src/messages/unread.rs','server/src/messages/topics/projection.rs'].map(n=>[n,createHash('sha256').update(readFileSync(n)).digest('hex')]))};
  save('metadata.json',metadata);
  for(let index=0;index<points.length;index++) {
    check();const p=points[index];console.log(`Point ${index+1}/${points.length}: ${JSON.stringify(p)}`);
    db.clone('seed_eager','base');db.sql(fixture(p,channels),'seed_eager');
    db.clone('seed_lazy','seed_eager');db.sql(readFileSync(new URL('lazy.sql',import.meta.url),'utf8'),'seed_lazy');
    try {
      for(let repeat=0;repeat<repeats;repeat++) {
        const pair:Record<string,Awaited<ReturnType<typeof measure>>>={};
        for(const variant of repeat%2?['lazy','eager']:['eager','lazy']) {
          check();db.clone('trial',`seed_${variant}`);
          try{pair[variant]=await measure(db,'trial',p,variant,repeat);const label=`${index+1}-${p.operation}-t${p.topics}-m${p.members}-r${repeat}-${variant}`;raw.push(lockFile(oracleFile(pair[variant],label),label));save('results.json',result);}finally{db.drop('trial');}
        }
        equal(pair.eager.oracle,pair.lazy.oracle,`${JSON.stringify(p)}/repeat ${repeat}`);
        result.equalityChecks++;samples.push(pair.eager.sample,pair.lazy.sample);save('results.json',result);
      }
    }finally {db.drop('seed_eager');db.drop('seed_lazy');}
  }
  check();result.complete=true;save('results.json',result);
  const conditions=`Conditions: ${new Date().toISOString()}, source ${metadata.commit} (dirty state/hashes in metadata.json); ${metadata.host.cpu}, ${metadata.host.cpus} CPUs, ${(metadata.host.memory/2**30).toFixed(1)} GiB, ${metadata.host.platform}/${metadata.host.arch}; Docker ${metadata.docker.version}, ${metadata.docker.cpus} CPUs / ${(metadata.docker.memory/2**30).toFixed(2)} GiB; ${image}; shared_buffers 128MB/work_mem 4MB/default JIT, synchronous commit on. Node ${metadata.node} (repo ${metadata.pinnedNode}); sqlx ${metadata.sqlx}. Topics ${topics}; public affected Members ${members}; ${channels} public Channels for join/reactivate; ${repeats} repeats. Elapsed ${((Date.now()-started)/60000).toFixed(1)} min. Host idle status requires operator assessment of uptime/process/container snapshots recorded in metadata. Equality checks: ${result.equalityChecks}, all passed.`;
  const md=summary(samples,pilot,`${conditions}\n\n${senderBaselineMethod}`);writeFileSync(resolve(out,'summary.md'),md);console.log(md);
} catch(error) {save('failure.json',{error:String(error),elapsedSeconds:(Date.now()-started)/1000});save('results.json',result);throw error;}
finally {db.cleanup();}
