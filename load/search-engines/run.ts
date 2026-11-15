import { supervise, ownedContainer, ownedVolume } from './runtime.ts';
import { loadManifest, verifyRuntime } from './manifest.ts';
// Run from the repository root with the Node version in .node-version.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, totalmem } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmark, CommandTimeoutError, command, docker, save, sql } from './bench.ts';
import { channel, copySql, finishSql, fixtureSql, generate, literal, member, org } from './seed.ts';
import { begin, normalizedQuery, pattern, queries, search, visibility, writeSql } from './queries.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'../..');
process.chdir(root);
if (process.version !== `v${readFileSync('.node-version','utf8').trim()}`) throw new Error('Use .node-version exactly');
const manifest = loadManifest();
const requested = resolve(process.env.SEARCH_RESULT_DIR ?? `/private/tmp/fukulow-search-153-${Date.now()}`);
const out = resolve(realpathSync(dirname(requested)),requested.split('/').at(-1) ?? '');
if (out === root || out.startsWith(root+'/')) throw new Error('Artifacts must be outside Git');
if (existsSync(out)) throw new Error('EEXIST: artifact destination already exists');
process.env.SEARCH_RESULT_DIR = out;
await supervise(import.meta.url,out);
mkdirSync(out);
const container = ownedContainer();
const image = 'fukulow-search-measure-153';
const engines = ['trgm','bigm','pgroonga'] as const;
type Engine = typeof engines[number] | 'none';
const count = Number(process.env.SEARCH_ROWS ?? 1000000);
const transactions = Number(process.env.SEARCH_TRANSACTIONS ?? 20);
if (!Number.isSafeInteger(count) || count < 1000 || !Number.isSafeInteger(transactions) || transactions < 1) throw new Error('Invalid measurement size');
const file = (name: string) => readFileSync(`load/search-engines/${name}`,'utf8');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const note = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const owner = (db: string, text: string) => sql(container,db,text);
const app = (db: string,text: string) => sql(container,db,text,'fukulow_app');
const grants = readFileSync('deploy/db-grants.sql','utf8');
const migrations = readdirSync('server/migrations').filter(s=>s.endsWith('.sql')).sort();
const results: Record<string,unknown>[] = [];

function create(db: string) {
  owner('postgres',`CREATE DATABASE ${db};`);
  for (const migration of migrations) owner(db,`BEGIN;\n${readFileSync(`server/migrations/${migration}`,'utf8')}\nCOMMIT;`);
  owner(db,file('schema.sql')); owner(db,grants); owner(db,fixtureSql());
}
function seedDb(db: string, rows: number) {
  const meta = generate(`${out}/messages.tsv`,rows); save(`${out}/${db}-seed.json`,meta);
  docker('cp',`${out}/messages.tsv`,`${container}:/tmp/messages.tsv`);
  owner(db,copySql); owner(db,finishSql); return meta;
}
function index(db: string, engine: Engine) {
  // Groonga files must not be copied from a live TEMPLATE database. Install and
  // initialize after cloning, once, before concurrent clients can open them.
  owner(db,"CREATE EXTENSION pgroonga; SELECT pgroonga_command('status');");
  const before = dbBytes(db); const start = performance.now();
  if (engine !== 'none') owner(db,file(`${engine}.sql`));
  const buildMs = performance.now()-start;
  const physicalDeltaBytes = dbBytes(db)-before;
  const relationBytes = engine === 'none' ? 0 : Number(owner(db,"SELECT pg_relation_size('search_body');"));
  owner(db,'ANALYZE;'); return {buildMs,relationBytes,physicalDeltaBytes};
}
function dbBytes(db: string) {
  const oid = owner('postgres',`SELECT oid FROM pg_database WHERE datname=${literal(db)};`);
  return Number(docker('exec',container,'sh','-c',`du -sb "$PGDATA/base/${oid}"`).split(/\s/)[0]);
}
function checkRls(db: string) {
  const facts = app(db,"SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user; SELECT count(*) FROM messages; BEGIN; SELECT set_config('fukulow.account_id', '"+member(1,2)+"', true); SELECT count(*) FROM messages; COMMIT; SELECT count(*) FROM messages;");
  if (facts !== `fukulow_app|f|f\n0\n${member(1,2)}\n0\n0`) throw new Error('RLS fail-closed check failed: '+facts);
  const access: Record<string,string> = {};
  for (let actor=1;actor<=6;actor++) {
    access[actor] = app(db,begin()+`${visibility(actor)} SELECT id FROM visible ORDER BY id; COMMIT;`).split('\n').filter(s=>s && s!==org(1)).join(',');
    const expected = Array.from({length:40},(_,c)=>c).filter(c=> actor===6 || actor===4 ? false :
      actor===3 ? c<8 : c%2===0 || (actor===1 && c<20) || (actor===2 && c%5===0)).map(c=>channel(1,c)).join(',');
    if (access[actor]!==expected) throw new Error(`Visibility denial/positive control failed for ${actor}`);
  }
  const cross = app(db,begin(2)+`SELECT count(*) FROM messages WHERE organization_id='${org(1)}'; COMMIT;`);
  if (cross.split('\n').at(-1) !== '0') throw new Error('Cross-Organization leak');
  return {facts,access,cross};
}

const normalized: {id:string,raw:string,value:string}[] = [];
function ids(db: string, query: string, role = 'fukulow_app', sequential = false) {
  const settings = sequential ? 'SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL enable_indexonlyscan=off;' : '';
  const output = sql(container,db,begin()+settings+`\n${query};\nCOMMIT;`,role);
  return output.split('\n').filter(s=>s && s!==org(1)).join('\n');
}
function completeness(db: string, dest: string) {
  const report: Record<string,unknown>[] = [];
  for (const q of normalized) {
    for (const actor of [1,2,3,4,5,6]) {
      const ref = ids(db,search(q.value,actor,false,true),'fukulow_app',true);
      const actual = ids(db,search(q.value,actor,false));
      if (actual !== ref) throw new Error(`Completeness mismatch: app ${q.id} actor ${actor}`);
      report.push({query:q.id,actor,rows:actual ? actual.split('\n').length:0,sha256:digest(actual),equal:true});
    }
    // Separately force the search index as owner: RLS can otherwise mask tokenizer misses.
    const ref = owner(db,`SET enable_indexscan=off; SET enable_bitmapscan=off; SET enable_indexonlyscan=off; ${search(q.value,2,false,true)};`);
    const actual = owner(db,`SET enable_seqscan=off; ${search(q.value,2,false)};`);
    if (actual !== ref) throw new Error(`Completeness mismatch: owner indexed ${q.id}`);
    report.push({query:q.id,actor:'owner-index-diagnostic',rows:actual ? actual.split('\n').length:0,sha256:digest(actual),equal:true});
    // No Channel/order alternative here: exercise the extension access path itself.
    const aggregate = "SELECT count(*),md5(string_agg(id::text,',' ORDER BY id)) FROM messages WHERE ";
    const directRef = owner(db,`SET enable_indexscan=off; SET enable_bitmapscan=off; SET enable_indexonlyscan=off; ${aggregate}strpos(normalized_body,${literal(q.value)})>0;`);
    const direct = owner(db,`SET enable_seqscan=off; ${aggregate}normalized_body LIKE ${literal(pattern(q.value))} ESCAPE E'\\\\';`);
    if (direct!==directRef) throw new Error(`Extension access-path mismatch ${q.id}: ${direct} != ${directRef}`);
    report.push({query:q.id,actor:'owner-direct-index',digest:direct,equal:true});
    // Page order and deterministic tie-breaker must match the reference too.
    if (ids(db,search(q.value)) !== ids(db,search(q.value,2,true,true),'fukulow_app',true)) throw new Error(`Page mismatch ${q.id}`);
  }
  save(dest,report);
  return {cases:report.length,equal:true};
}

async function restoreDrill() {
  create('small'); seedDb('small',1000);
  const report = [];
  for (const engine of engines) {
    owner('postgres',`CREATE DATABASE drill TEMPLATE small;`); index('drill',engine);
    const before = owner('drill',"SELECT count(*),md5(string_agg(id::text||body,'|' ORDER BY id)) FROM messages;");
    docker('exec',container,'pg_dump','-U','fukulow','-d','drill','-Fc','-f','/tmp/drill.dump');
    docker('cp',`${container}:/tmp/drill.dump`,`${out}/${engine}-small.dump`);
    owner('postgres','CREATE DATABASE restored;');
    const start = performance.now();
    docker('exec',container,'pg_restore','-U','fukulow','-d','restored','--exit-on-error','--no-owner','--no-acl','/tmp/drill.dump');
    const restoreMs = performance.now()-start;
    owner('restored',grants);
    const after = owner('restored',"SELECT count(*),md5(string_agg(id::text||body,'|' ORDER BY id)) FROM messages;");
    if (before!==after) throw new Error('Dump/restore data mismatch');
    report.push({engine,before,after,restoreMs,rls:checkRls('restored'),completeness:completeness('restored',`${out}/${engine}-restore-completeness.json`),
      extensions:owner('restored','SELECT extname,extversion FROM pg_extension ORDER BY 1;')});
    owner('postgres','DROP DATABASE restored WITH (FORCE); DROP DATABASE drill WITH (FORCE);');
    note(`dump/restore ${engine} verified`);
  }
  owner('postgres','DROP DATABASE small;'); save(`${out}/restore.json`,report);
}

{
  note(`Artifacts: ${out}`);
  if (process.env.SEARCH_SKIP_BUILD !== '1') {
    // Build completes before any timing. No server image/dependency is changed.
    const log = command('docker',['build','-t',image,'load/search-engines']); writeFileSync(`${out}/build.txt`,log);
  }
  docker('volume','create',ownedVolume());
  const password = randomUUID();
  command('docker',['run','-d','--name',container,'--shm-size=1g','--mount',`type=volume,source=${ownedVolume()},target=/var/lib/postgresql`,'-e','POSTGRES_PASSWORD','-e','POSTGRES_USER=fukulow','-e','POSTGRES_DB=postgres',image,
    'postgres','-c','shared_buffers=128MB','-c','work_mem=4MB','-c','maintenance_work_mem=64MB',
    '-c','max_connections=100','-c','jit=on','-c','fsync=on','-c','synchronous_commit=on',
    '-c','shared_preload_libraries=pgroonga_wal_resource_manager,pgroonga_crash_safer',
    '-c','pgroonga.enable_wal_resource_manager=on','-c','pgroonga.enable_crash_safe=on',
    '-c','max_worker_processes=16'],undefined,{...process.env,POSTGRES_PASSWORD:password});
  // The password is passed via environment, never a command argument or artifact.
  let ready = false;
  for (let attempt=0;attempt<60;attempt++) {
    try { if (owner('postgres','SELECT 1;')==='1') { ready=true; break; } } catch (error) { if (error instanceof CommandTimeoutError) throw error; }
    await new Promise(r=>setTimeout(r,500));
  }
  if (!ready) throw new Error('PostgreSQL startup timed out');
  verifyRuntime(text=>owner('postgres',text),docker,container);
  save(`${out}/manifest.json`,manifest);
  owner('postgres',`BEGIN; SET LOCAL fukulow.app_password=${literal(password)};\n${readFileSync('deploy/db-role-settings.sql','utf8')}\n${readFileSync('deploy/db-roles.sql','utf8')}\nCOMMIT;`);
  const metadata = {manifestHash:manifest.sha256,at:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,cpus:cpus().length,memory:totalmem(),arch:arch(),
    os:command('sw_vers',[]),model:command('sysctl',['-n','hw.model']),
    docker:JSON.parse(docker('info','--format','{"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memory":{{.MemTotal}}}')),
    image:docker('image','inspect',image,'--format','{{.Id}}'),source:command('git',['rev-parse','HEAD']),
    hashes:Object.fromEntries([...readdirSync('load/search-engines',{withFileTypes:true}).filter(n=>n.isFile()).map(n=>'load/search-engines/'+n.name),...migrations.map(n=>'server/migrations/'+n)].map(p=>[p,digest(readFileSync(p,'utf8'))])),
    versions:owner('postgres','SELECT version(); SELECT name,default_version FROM pg_available_extensions WHERE name IN (\'pg_trgm\',\'pg_bigm\',\'pgroonga\');'),
    packages:docker('exec',container,'dpkg-query','-W','postgresql-18','postgresql-client-18','postgresql-server-dev-18','postgresql-18-pgdg-pgroonga','libgroonga0'),
    settings:owner('postgres',"SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','random_page_cost','jit','fsync','synchronous_commit','max_connections','wal_level','max_wal_size','checkpoint_timeout','lc_collate','server_encoding','shared_preload_libraries','max_worker_processes') OR name LIKE 'pgroonga.%';"),
    processStart:command('ps',['-axo','comm,%cpu']),dockerStart:docker('ps','--format','{{.Image}}'),count,transactions};
  save(`${out}/metadata.json`,metadata);
  create('base');
  for (const [id,raw] of queries) normalized.push({id,raw,value:owner('base',`SELECT ${normalizedQuery(raw)};`)});
  if (normalized.find(q=>q.id==='nfc')?.value!==normalized.find(q=>q.id==='nfd')?.value
    || normalized.find(q=>q.id==='trim')?.value!=='開発'
    || normalized.find(q=>q.id==='bom')?.value!=='\ufeff開発\ufeff') throw new Error('Normalization/trim mismatch');
  save(`${out}/queries.json`,normalized.map(q=>({...q,scalars:[...q.value].length})));
  await restoreDrill();
  save(`${out}/dataset.json`,seedDb('base',count)); note(`seeded ${count} Messages`);
  save(`${out}/rls.json`,checkRls('base'));
  for (let round=0;round<3;round++) {
    const order: Engine[] = round===0 ? ['none',...engines] : round===1 ? ['bigm','pgroonga','none','trgm'] : ['pgroonga','trgm','bigm','none'];
    for (const engine of order) {
      const dest = `${out}/round${round+1}-${engine}`; mkdirSync(dest);
      owner('postgres','CREATE DATABASE measured TEMPLATE base;');
      const build = index('measured',engine);
      docker('restart',container);
      // A successful SELECT establishes readiness after each restart.
      for (let attempt=0;attempt<60;attempt++) {
        try { if (owner('measured','SELECT 1;')==='1') break; } catch (error) { if (error instanceof CommandTimeoutError) throw error; }
        await new Promise(r=>setTimeout(r,500));
      }
      owner('measured',"SELECT pgroonga_command('status');");
      note(`round ${round+1} ${engine}, index ${Math.round(build.buildMs)} ms`);
      const row: Record<string,unknown> = {manifestHash:manifest.sha256,round:round+1,engine,...build};
      if (engine!=='none') {
        // Exactly one complete sweep of all queries before latency sampling.
        for (const q of normalized) app('measured',begin()+search(q.value)+'; COMMIT;');
        const latencies = [];
        for (const q of normalized) {
          const measured = await benchmark(container,'measured',begin()+search(q.value)+';\nCOMMIT;',`${dest}/${q.id}`,transactions);
          latencies.push({query:q.id,...measured});
          note(`round ${round+1} ${engine} ${q.id} p95=${measured.p95.toFixed(3)} ms`);
        }
        row.latencies=latencies;
        if (round===0) {
          for (const q of normalized) {
            writeFileSync(`${dest}/${q.id}-app-plan.txt`,app('measured',begin()+`EXPLAIN (ANALYZE,BUFFERS,SETTINGS) ${search(q.value)}; COMMIT;`));
            writeFileSync(`${dest}/${q.id}-owner-plan.txt`,owner('measured',`SET enable_seqscan=off; EXPLAIN (ANALYZE,BUFFERS,SETTINGS) ${search(q.value)};`));
            writeFileSync(`${dest}/${q.id}-direct-plan.txt`,owner('measured',`SET enable_seqscan=off; EXPLAIN (ANALYZE,BUFFERS,SETTINGS) SELECT id FROM messages WHERE normalized_body LIKE ${literal(pattern(q.value))} ESCAPE E'\\\\';`));
          }
          row.completeness=completeness('measured',`${dest}/completeness.json`);
        }
      }
      // Warm the insert path equally; measure 1,000 committed inserts with 5 writers.
      await benchmark(container,'measured',writeSql,`${dest}/write-warm`,10);
      owner('measured','CHECKPOINT;');
      const walBefore = owner('measured','SELECT pg_current_wal_insert_lsn();');
      row.write = await benchmark(container,'measured',writeSql,`${dest}/write`,200);
      row.walBytesPerInsert=Number(owner('measured',`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),${literal(walBefore)})/1000;`));
      row.endSizeBytes=dbBytes('measured');
      save(`${dest}/result.json`,row); results.push(row); save(`${out}/results.json`,results);
      owner('postgres','DROP DATABASE measured WITH (FORCE);'); note(`round ${round+1} ${engine} complete`);
    }
  }
  save(`${out}/finished.json`,{manifestHash:manifest.sha256,at:new Date().toISOString(),processEnd:command('ps',['-axo','comm,%cpu']),results:results.length});
  command(process.execPath,['load/search-engines/summarize.ts',out]);
  note('All measurements completed; no formal Linux performance judgement.');
}
