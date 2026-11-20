import assert from 'node:assert/strict';
import { summarize } from './summarize.ts';
import { supervise, ownedContainer, ownedVolume, refuseLeftovers, ownershipLabel } from './runtime.ts';
import { loadManifest, verifyRuntime, resolveImage, verifySession, postgresArguments, runKind, smokeLabel } from './manifest.ts';
// Run from the repository root with the Node version in .node-version.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, totalmem } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmark, CommandTimeoutError, command, docker, save, sql } from './bench.ts';
import { channel, copySql, finishSql, fixtureSql, generate, literal, member, org } from './seed.ts';
import { begin, normalizedQuery, pattern, search, visibility } from './queries.ts';
import { denialCases, probeSql } from './definer.ts';
import { b1Begin, b1Cleanup, b1Denials, b1ForcedDenialPlan, b1Plan, b1Query, b1Role, b1Rows, b1TimingFixture, verifyB1 } from './b1.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'../..');
process.chdir(root);
if (process.version !== `v${readFileSync('.node-version','utf8').trim()}`) throw new Error('Use .node-version exactly');
const manifest = loadManifest();
const kind = runKind();
console.log(kind==='smoke' ? smokeLabel : 'EVALUATION (formal Linux judgement remains separate)');
const requested = resolve(process.env.SEARCH_RESULT_DIR ?? `/private/tmp/fukulow-search-689-${Date.now()}`);
const out = resolve(realpathSync(dirname(requested)),requested.split('/').at(-1) ?? '');
if (out === root || out.startsWith(root+'/')) throw new Error('Artifacts must be outside Git');
if (existsSync(out)) throw new Error('EEXIST: artifact destination already exists');
process.env.SEARCH_RESULT_DIR = out;
if (process.env.SEARCH_WORKER!=='1') refuseLeftovers(docker);
if (await supervise(import.meta.url,out,manifest.sha256,()=>summarize(out,kind))) {
mkdirSync(out);
const container = ownedContainer();
const imageTag = 'fukulow-search-measure-153';
let image = imageTag;
const conditions = kind==='smoke' ? {...manifest.frozen.performance,...manifest.frozen.smoke.performance} : manifest.frozen.performance;
const count = conditions.rows;
const transactions = conditions.transactions;
if (!Number.isSafeInteger(count) || count < 1000 || !Number.isSafeInteger(transactions) || transactions < 1) throw new Error('Invalid measurement size');
const file = (name: string) => readFileSync(`load/search-engines/${name}`,'utf8');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const note = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const owner = (db: string, text: string) => sql(container,db,text);
const app = (db: string,text: string) => sql(container,db,text,'fukulow_app');
const b1 = (db: string,text: string) => sql(container,db,text,b1Role);
const drop = (db: string) => owner('postgres',`DROP DATABASE ${db} WITH (FORCE);`);
let policy: string | undefined;
function checkB1(db: string) {
  const session = verifySession(text=>b1(db,text),'app',manifest.frozen.sessionPolicy.b1Settings);
  const facts = verifyB1(text=>b1(db,text),policy);
  policy ??= facts.policy;
  return {...facts,session};
}
const grants = readFileSync('deploy/db-grants.sql','utf8');
const migrations = manifest.frozen.b1.migrations;
const results: object[] = [];

function create(db: string) {
  owner('postgres',`CREATE DATABASE ${db};`);
  for (const migration of migrations) owner(db,`BEGIN;\n${readFileSync(migration,'utf8')}\nCOMMIT;`);
  verifySession(text=>owner(db,text));
  verifySession(text=>app(db,text),'app');
  owner(db,file('schema.sql'));
  owner(db,grants);
  owner(db,file('b1.sql'));
  checkB1(db);
  owner(db,fixtureSql());
}
function seedDb(db: string, rows: number) {
  const meta = generate(`${out}/messages.tsv`,rows); save(`${out}/${db}-seed.json`,meta);
  docker('cp',`${out}/messages.tsv`,`${container}:/tmp/messages.tsv`);
  owner(db,copySql); owner(db,finishSql); return meta;
}
function index(db: string) {
  // Groonga files must not be copied from a live TEMPLATE database. Install and
  // initialize after cloning, once, before concurrent clients can open them.
  owner(db,"CREATE EXTENSION pgroonga; SELECT pgroonga_command('status');");
  const before = dbBytes(db); const start = performance.now();
  owner(db,file('pgroonga.sql'));
  const buildMs = performance.now()-start;
  const physicalDeltaBytes = dbBytes(db)-before;
  const relationBytes = Number(owner(db,"SELECT pg_relation_size('search_body');"));
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

type Query = {id:string,raw:string,value:string};
const normalized: Query[] = [];
const script = (query: string) => b1Begin(query)+b1Query()+';\nCOMMIT;';

function plan(db: string, query: string, dest: string, prepared = false) {
  return b1Plan(text=>b1(db,text),query,explain=>save(dest,explain),{prepared});
}

function ids(db: string, query: string, role = 'fukulow_app', sequential = false) {
  const settings = sequential ? 'SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL enable_indexonlyscan=off;' : '';
  const output = sql(container,db,begin()+settings+`\n${query};\nCOMMIT;`,role);
  return output.split('\n').filter(s=>s && s!==org(1)).join('\n');
}
function completeness(db: string, dest: string) {
  const report = [];
  for (const q of normalized) {
    const actors = [1,2,3,4,5,6].map(actor=>{
      const reference = ids(db,search(q.value,actor,false,true),'fukulow_app',true);
      const found = b1Rows(b1(db,b1Begin(q.value)+b1Query(member(1,actor),false)+'; COMMIT;'));
      return {actor,equal:found===reference,rows:found ? found.split('\n').length : 0,
        foundSha256:digest(found),referenceSha256:digest(reference)};
    });
    // The original engine-only controls catch tokenizer misses independently of the search plan.
    const ref = owner(db,`SET enable_indexscan=off; SET enable_bitmapscan=off; SET enable_indexonlyscan=off; ${search(q.value,2,false,true)};`);
    const indexed = owner(db,`SET enable_seqscan=off; ${search(q.value,2,false)};`);
    const organizations = [1,2,3].map(org);
    const counts = organizations.map(o=>`count(*) FILTER (WHERE organization_id='${o}')`).join(',');
    const aggregate = `SELECT ${counts},md5(string_agg(id::text,',' ORDER BY id)) FROM messages WHERE `;
    const directRef = owner(db,`SET enable_indexscan=off; SET enable_bitmapscan=off; SET enable_indexonlyscan=off; ${aggregate}strpos(normalized_body,${literal(q.value)})>0;`);
    const direct = owner(db,`SET enable_seqscan=off; ${aggregate}normalized_body LIKE ${literal(pattern(q.value))} ESCAPE chr(92);`);
    const matchCounts = directRef.split('|');
    assert.equal(matchCounts.length,4,'Missing Organization match counts');
    const matchesByOrganization = Object.fromEntries(organizations.map((o,i)=>[o,Number(matchCounts[i])]));
    const referencePage = ids(db,search(q.value,2,true,true),'fukulow_app',true);
    const foundPage = b1Rows(b1(db,script(q.value)));
    report.push({query:q.id,actors,ownerIndexEqual:indexed===ref,directEqual:direct===directRef,
      pageEqual:foundPage===referencePage,matchesByOrganization});
  }
  save(dest,report);
  return report;
}

function restoreDrill() {
  create('small'); seedDb('small',conditions.restoreRows); index('small');
  const checksum = (db: string) => owner(db,"SELECT count(*),md5(string_agg(id::text||body,'|' ORDER BY id)) FROM messages;");
  const before = checksum('small');
  docker('exec',container,'pg_dump','-U','fukulow','-d','small','-Fc','-f','/tmp/drill.dump');
  docker('cp',`${container}:/tmp/drill.dump`,`${out}/pgroonga-small.dump`);
  owner('postgres','CREATE DATABASE restored;');
  const start = performance.now();
  docker('exec',container,'pg_restore','-U','fukulow','-d','restored','--exit-on-error','--no-owner','--no-acl','/tmp/drill.dump');
  const restoreMs = performance.now()-start;
  owner('restored',grants);
  owner('restored',file('b1.sql'));
  const verification = checkB1('restored');
  const after = checksum('restored');
  assert.equal(after,before,'Dump/restore data mismatch');
  const checked = completeness('restored',`${out}/restore-completeness.json`);
  save(`${out}/restore.json`,{before,after,restoreMs,verification,rls:checkRls('restored'),completeness:checked});
  drop('restored'); drop('small');
}

function checkDenials() {
  create('denial'); owner('denial',probeSql); index('denial');
  const verification = checkB1('denial');
  const checks = b1Denials(text=>b1('denial',text));
  // Direct reads isolate the RLS/pattern checks from the query's visibility predicates.
  const rls = b1Cleanup(text=>b1('denial',text));
  save(`${out}/denials.json`,{cases:denialCases.map(c=>c.name),checks,verification,rls});
  assert.ok(checks.every(c=>JSON.stringify(c.found)===JSON.stringify(c.expected)),'B1 denial mismatch; see denials.json');
  b1ForcedDenialPlan(text=>b1('denial',text),explain=>save(`${out}/denial-forced-plan.json`,explain));
  drop('denial');
}

async function timingExposure() {
  const {foreignRowsPerClass} = manifest.frozen.b1.timingProbe;
  const arms = ['few','many'] as const;
  const dest = `${out}/timing`;
  mkdirSync(dest);
  // Identical visible rows, foreign row IDs and foreign row counts in both arms.
  // The large arm varies only foreign bodies; small-arm filler has no query terms.
  const insert = (q: Query, i: number, o: number, rows: number, matches: number) => `INSERT INTO public.messages
    (organization_id,id,channel_id,seq,sender,client_message_id,body,created_at)
    SELECT '${org(o)}',md5('${o}:${i}:'||n)::uuid,'${channel(o,0)}',${i*foreignRowsPerClass}+n,'${member(o,1)}',
      md5('${o}:${i}:'||n)::uuid,CASE WHEN n<=${matches} THEN ${literal(q.value)}
      ELSE repeat('~',octet_length(${literal(q.value)})) END,'2026-11-14'
    FROM generate_series(1,${rows}) n;`;
  create('timing_base');
  owner('timing_base',normalized.map((q,i)=>insert(q,i,1,1,1)).join('\n'));
  for (const arm of arms) {
    const db = `timing_${arm}`;
    owner('postgres',`CREATE DATABASE ${db} TEMPLATE timing_base;`);
    owner(db,normalized.map((q,i)=>insert(q,i,2,foreignRowsPerClass,arm==='few' ? 1 : foreignRowsPerClass)).join('\n'));
    index(db); checkB1(db);
    for (const q of normalized) b1(db,script(q.value));
  }
  drop('timing_base');
  const evidence = [];
  for (const [i,q] of normalized.entries()) {
    const sample = async (arm: typeof arms[number])=>{
      const db = `timing_${arm}`;
      const page = b1Rows(b1(db,script(q.value)));
      const foreignMatches = Number(owner(db,`SELECT count(*) FROM public.messages
        WHERE organization_id='${org(2)}' AND strpos(normalized_body,${literal(q.value)})>0;`));
      const latency = await benchmark(container,db,script(q.value),`${dest}/${q.id}-${arm}`,transactions,conditions.clients,b1Role);
      return {page,foreignMatches,latency};
    };
    const [a,b] = i%2===0 ? arms : ['many','few'] as const;
    const samples = {[a]:await sample(a),[b]:await sample(b)};
    const few = samples.few!, many = samples.many!;
    evidence.push({query:q.id,order:[a,b],equalNonemptyPage:few.page!=='' && few.page===many.page,
      few:{foreignMatches:few.foreignMatches,...few.latency},many:{foreignMatches:many.foreignMatches,...many.latency}});
    save(`${out}/timing.json`,evidence);
  }
  // Collect EXPLAIN and fixture evidence after sampling so these reads cannot warm either arm.
  const pairedPlans = evidence.map((sample,i)=>{
    const q = normalized[i]!;
    const capture = (arm: typeof arms[number]) => plan(`timing_${arm}`,q.value,`${dest}/${q.id}-${arm}-plan.json`,true);
    return {...sample,
      few:{...sample.few,plan:capture('few')},many:{...sample.many,plan:capture('many')}};
  });
  const fixture = b1TimingFixture((arm,text)=>owner(`timing_${arm}`,text),normalized.length,foreignRowsPerClass);
  save(`${dest}/fixture.json`,fixture);
  save(`${out}/timing.json`,pairedPlans);
  for (const arm of arms) drop(`timing_${arm}`);
}

{
  note(`Artifacts: ${out}`);
  if (process.env.SEARCH_SKIP_BUILD !== '1') {
    // Build completes before any timing. No server image/dependency is changed.
    const log = command('docker',['build','-t',image,'load/search-engines']); writeFileSync(`${out}/build.txt`,log);
  }
  const imageRecord = resolveImage(docker,imageTag,process.env.SEARCH_SKIP_BUILD==='1');
  image = imageRecord.id;
  save(`${out}/image.json`,imageRecord);
  docker('volume','create','--label',ownershipLabel,ownedVolume());
  const password = randomUUID();
  command('docker',['run','-d','--label',ownershipLabel,'--name',container,'--shm-size=1g','--mount',`type=volume,source=${ownedVolume()},target=/var/lib/postgresql`,'-e','POSTGRES_PASSWORD','-e','POSTGRES_USER=fukulow','-e','POSTGRES_DB=postgres',image,
    ...postgresArguments],undefined,{...process.env,POSTGRES_PASSWORD:password});
  // The password is passed via environment, never a command argument or artifact.
  let ready = false;
  for (let attempt=0;attempt<60;attempt++) {
    try { docker('exec',container,'pg_isready','-h','127.0.0.1','-U','fukulow','-d','postgres'); if (owner('postgres','SELECT 1;')==='1') { ready=true; break; } } catch (error) { if (error instanceof CommandTimeoutError) throw error; }
    await new Promise(r=>setTimeout(r,500));
  }
  if (!ready) throw new Error('PostgreSQL startup timed out');
  owner('postgres','CREATE EXTENSION pgroonga;');
  const ownerVerification = {runtime:verifyRuntime(text=>owner('postgres',text),docker,container),
    session:verifySession(text=>owner('postgres',text))};
  save(`${out}/manifest.json`,{...manifest,runKind:kind});
  owner('postgres',`BEGIN; SET LOCAL fukulow.app_password=${literal(password)};\n${readFileSync('deploy/db-role-settings.sql','utf8')}\n${readFileSync('deploy/db-roles.sql','utf8')}\nCOMMIT;`);
  save(`${out}/verification.json`,{runKind:kind,image:imageRecord,owner:ownerVerification,
    app:{runtime:verifyRuntime(text=>app('postgres',text),docker,container,text=>owner('postgres',text)),
      session:verifySession(text=>app('postgres',text),'app')}});
  const metadata = {manifestHash:manifest.sha256,runKind:kind,at:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,cpus:cpus().length,memory:totalmem(),arch:arch(),
    os:process.platform,model:cpus()[0]?.model,
    docker:JSON.parse(docker('info','--format','{"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memory":{{.MemTotal}}}')),
    image: imageRecord,source:command('git',['rev-parse','HEAD']),
    hashes:Object.fromEntries([...readdirSync('load/search-engines',{withFileTypes:true}).filter(n=>n.isFile()).map(n=>'load/search-engines/'+n.name),...migrations].map(p=>[p,digest(readFileSync(p,'utf8'))])),
    versions:owner('postgres','SELECT version(); SELECT name,default_version FROM pg_available_extensions WHERE name IN (\'pg_trgm\',\'pg_bigm\',\'pgroonga\');'),
    packages:docker('exec',container,'dpkg-query','-W','postgresql-18','postgresql-client-18','postgresql-server-dev-18','postgresql-18-pgdg-pgroonga','libgroonga0'),
    settings:owner('postgres',"SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','random_page_cost','jit','fsync','synchronous_commit','max_connections','wal_level','max_wal_size','checkpoint_timeout','lc_collate','server_encoding','shared_preload_libraries','max_worker_processes') OR name LIKE 'pgroonga.%';"),
    processStart:command('ps',['-axo','comm,%cpu']),dockerStart:docker('ps','--format','{{.Image}}'),count,transactions};
  save(`${out}/metadata.json`,metadata);
  create('base');
  for (const [id,raw] of manifest.frozen.performance.querySet)
    normalized.push({id,raw,value:owner('base',`SELECT ${normalizedQuery(raw)};`)});
  if (normalized.find(q=>q.id==='nfc')?.value!==normalized.find(q=>q.id==='nfd')?.value
    || normalized.find(q=>q.id==='trim')?.value!=='開発'
    || normalized.find(q=>q.id==='bom')?.value!=='\ufeff開発\ufeff') throw new Error('Normalization/trim mismatch');
  save(`${out}/queries.json`,normalized.map(q=>({...q,scalars:[...q.value].length})));
  restoreDrill();
  checkDenials();
  save(`${out}/dataset.json`,seedDb('base',count)); note(`seeded ${count} Messages`);
  save(`${out}/rls.json`,checkRls('base'));
  for (let round=1;round<=conditions.rounds;round++) {
    const dest = `${out}/round${round}-pgroonga`; mkdirSync(dest);
    owner('postgres','CREATE DATABASE measured TEMPLATE base;');
    const build = index('measured');
    docker('restart',container);
    ready = false;
    for (let attempt=0;attempt<60;attempt++) {
      try { if (owner('measured','SELECT 1;')==='1') { ready=true; break; } } catch (error) { if (error instanceof CommandTimeoutError) throw error; }
      await new Promise(r=>setTimeout(r,500));
    }
    if (!ready) throw new Error('PostgreSQL restart timed out');
    owner('measured',"SELECT pgroonga_command('status');");
    verifySession(text=>owner('measured',text));
    verifySession(text=>app('measured',text),'app');
    const safety = checkB1('measured');
    note(`round ${round} PGroonga, index ${Math.round(build.buildMs)} ms`);
    for (let sweep=0;sweep<conditions.warmupSweeps;sweep++)
      for (const q of normalized) b1('measured',script(q.value));
    const latencies = [];
    for (const q of normalized) {
      const measured = await benchmark(container,'measured',script(q.value),`${dest}/${q.id}`,transactions,conditions.clients,b1Role);
      latencies.push({query:q.id,...measured});
      save(`${dest}/latencies.json`,latencies);
      note(`round ${round} PGroonga ${q.id} p95=${measured.p95.toFixed(3)} ms`);
    }
    const row = {manifestHash:manifest.sha256,runKind:kind,round,engine:'pgroonga',...build,safety,latencies,
      ...(round===1 ? {
        plans:normalized.map(q=>({query:q.id,...plan('measured',q.value,`${dest}/${q.id}-plan.json`)})),
        completeness:completeness('measured',`${dest}/completeness.json`),
      } : {}),
      endSizeBytes:dbBytes('measured')};
    save(`${dest}/result.json`,row); results.push(row); save(`${out}/results.json`,results);
    drop('measured'); note(`round ${round} PGroonga complete`);
  }
  drop('base');
  await timingExposure();
  save(`${out}/completed.json`,{manifestHash:manifest.sha256,runKind:kind,at:new Date().toISOString(),processEnd:command('ps',['-axo','comm,%cpu']),results:results.length});
  note(kind==='smoke' ? smokeLabel+' pipeline completed.' : 'All measurements completed; no formal Linux performance judgement.');
}
}
