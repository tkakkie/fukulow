import { supervise, ownedContainer, ownedVolume, refuseLeftovers, ownershipLabel } from '../runtime.ts';
import { loadManifest, qualityMigrations, verifyRuntime, resolveImage, verifySession, postgresArguments, runKind, smokeLabel } from '../manifest.ts';
// Quality only: full result sets, no timers or performance measurements.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandTimeoutError, command, docker, save, sql } from '../bench.ts';
import { channel, fixtureSql, literal, member, org, trimQuery, uuid } from '../seed.ts';
import { begin, normalizedQuery } from '../queries.ts';
import { classes, corpus, queries } from './dataset.ts';
import { aggregate, score } from './metrics.ts';
import { modes, querySql } from './modes.ts';
import { finalizeQuality } from './summarize.ts';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'../../..'));
process.chdir(root);
if (process.version !== `v${readFileSync('.node-version','utf8').trim()}`) throw new Error('Use .node-version exactly');
const manifest = loadManifest();
const kind = runKind();
console.log(kind==='smoke' ? smokeLabel : 'EVALUATION (formal Linux judgement remains separate)');
const requested = resolve(process.env.SEARCH_QUALITY_DIR ?? `/private/tmp/fukulow-search-quality-153-${Date.now()}`);
const out = resolve(realpathSync(dirname(requested)),requested.split('/').at(-1) ?? '');
if (out===root || out.startsWith(root+'/')) throw new Error('Artifacts must be outside Git');
if (existsSync(out)) throw new Error('EEXIST: artifact destination already exists');
process.env.SEARCH_QUALITY_DIR = out;
if (process.env.SEARCH_WORKER!=='1') refuseLeftovers(docker);
if (await supervise(import.meta.url,out,manifest.sha256,()=>finalizeQuality(out,kind))) {
mkdirSync(out);
const container = ownedContainer();
const imageTag = 'fukulow-search-measure-153';
let image = imageTag;
const owner = (db: string,text: string)=>sql(container,db,text);
const app = (db: string,text: string)=>sql(container,db,text,'fukulow_app');
const read = (p: string)=>readFileSync(p,'utf8');
const hash = (s: string)=>createHash('sha256').update(s).digest('hex');
{
  console.log(`Quality artifacts: ${out}`);
  if (process.env.SEARCH_SKIP_BUILD!=='1') writeFileSync(`${out}/build.txt`,docker('build','-t',image,'load/search-engines'));
  const imageRecord = resolveImage(docker,imageTag,process.env.SEARCH_SKIP_BUILD==='1');
  image = imageRecord.id;
  save(`${out}/image.json`,imageRecord);
  docker('volume','create','--label',ownershipLabel,ownedVolume());
  const password = randomUUID();
  command('docker',['run','-d','--label',ownershipLabel,'--name',container,'--shm-size=1g','--mount',`type=volume,source=${ownedVolume()},target=/var/lib/postgresql`,'-e','POSTGRES_PASSWORD',
    '-e','POSTGRES_USER=fukulow','-e','POSTGRES_DB=postgres',image,...postgresArguments],
    undefined,{...process.env,POSTGRES_PASSWORD:password});
  let ready = false;
  for (let i=0;i<60;i++) {
    try {
      // initdb's temporary server accepts Unix sockets, then shuts down. TCP
      // readiness waits for the final server rather than racing that shutdown.
      docker('exec',container,'pg_isready','-h','127.0.0.1','-U','fukulow','-d','postgres');
      if (owner('postgres','SELECT 1;')==='1') { ready=true; break; }
    } catch (error) { if (error instanceof CommandTimeoutError) throw error; }
    await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(ready,'PostgreSQL startup timed out');
  owner('postgres','CREATE EXTENSION pgroonga;');
  const ownerVerification = {runtime:verifyRuntime(text=>owner('postgres',text),docker,container),
    session:verifySession(text=>owner('postgres',text))};
  save(`${out}/manifest.json`,{...manifest,runKind:kind});
  owner('postgres',`BEGIN; SET LOCAL fukulow.app_password=${literal(password)};
    ${read('deploy/db-role-settings.sql')}\n${read('deploy/db-roles.sql')}\nCOMMIT; CREATE DATABASE quality_base;`);
  save(`${out}/verification.json`,{runKind:kind,image:imageRecord,owner:ownerVerification,
    app:{runtime:verifyRuntime(text=>app('postgres',text),docker,container,text=>owner('postgres',text)),
      session:verifySession(text=>app('postgres',text),'app')}});
  const migrations = qualityMigrations();
  for (const p of migrations) owner('quality_base',`BEGIN; ${read(p)} COMMIT;`);
  owner('quality_base',read('load/search-engines/schema.sql')+read('deploy/db-grants.sql')+fixtureSql());
  verifySession(text=>owner('quality_base',text));
  verifySession(text=>app('quality_base',text),'app');
  const data = corpus();
  const rows: string[] = [];
  let i = 0;
  function insert(id: string,body: string,o: number,c: number,old = false) {
    i++;
    rows.push(`('${org(o)}','${id}','${channel(o,c)}',${i},'${member(o,1)}','${id}',${literal(body)},'${old ? '2026-01-01' : '2026-11-14'}')`);
  }
  for (const m of data) insert(m.id,m.body,1,0);
  // Same semantic text outside scope, private without grant, and outside range.
  for (const [j,m] of data.filter(m=>!m.key.startsWith('background')).entries()) {
    insert(uuid(4000000+j),m.body,2,0);
    insert(uuid(5000000+j),m.body,1,1);
    insert(uuid(6000000+j),m.body,1,0,true);
  }
  owner('quality_base',`INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,created_at) VALUES ${rows.join(',')}; ANALYZE;`);
  const allowedIds = new Set(data.map(m=>m.id));
  const evaluated = queries.map(q=>({...q,trimmed:trimQuery(q.text),normalized:owner('quality_base',`SELECT ${normalizedQuery(q.text)};`)}));
  save(`${out}/dataset.json`,{classes,messages:data,queries:evaluated,totalRows:i,scope:'Org1, Member2, public Channel0, recent; other fixtures denied'});
  save(`${out}/metadata.json`,{manifestHash:manifest.sha256,runKind:kind,at:new Date().toISOString(),node:process.version,os:platform(),arch:arch(),cpu:cpus()[0]?.model,
    source:command('git',['rev-parse','HEAD']),image: imageRecord,
    versions:owner('quality_base','SELECT version(); SELECT extname,extversion FROM pg_extension;'),
    packages:docker('exec',container,'dpkg-query','-W','postgresql-18','postgresql-18-pgdg-pgroonga','libgroonga0'),
    hashes:Object.fromEntries([...migrations,
      ...readdirSync('load/search-engines/quality').map(n=>`load/search-engines/quality/${n}`),
      'load/search-engines/schema.sql','load/search-engines/seed.ts','load/search-engines/queries.ts','load/search-engines/Dockerfile',
      'deploy/db-grants.sql','deploy/db-roles.sql','deploy/db-role-settings.sql'].map(p=>[p,hash(read(p))]))});
  const results = [];
  for (const mode of modes) {
    owner('postgres','CREATE DATABASE quality_mode TEMPLATE quality_base;');
    owner('quality_mode',"CREATE EXTENSION pgroonga; SELECT pgroonga_command('status');"+mode.ddl+' ANALYZE;');
    verifySession(text=>owner('quality_mode',text));
    verifySession(text=>app('quality_mode',text),'app');
    const facts = app('quality_mode',"SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user; SELECT count(*) FROM messages;");
    assert.equal(facts,'fukulow_app|f|f\n0');
    const runQuery = (q: typeof evaluated[number],actor = 2)=>{
      const statement = begin()+mode.settings+'\n'+querySql(mode,q.trimmed,q.normalized,actor)+'\nCOMMIT;';
      const output = app('quality_mode',statement).split('\n').filter(s=>s && s!==org(1));
      const found = output.map(s=>{const [id,value] = s.split('|');return {id,score:Number(value)};});
      assert.ok(found.every(r=>Number.isFinite(r.score)));
      assert.ok(found.every(r=>allowedIds.has(r.id)),`${mode.id}/${q.id}: excluded scope/range result`);
      return {statement,found};
    };
    const scored = evaluated.map(q=>{
      const {statement,found} = runQuery(q);
      for (const actor of [4,6]) assert.deepEqual(runQuery(q,actor).found,[],`${mode.id}/${q.id}: denied actor ${actor}`);
      writeFileSync(`${out}/${mode.id}-${q.id}.sql`,statement);
      return {query:q.id,class:q.class,results:found,...score(q.gold,found.map(r=>r.id),mode.ranked)};
    });
    // Plans diagnose scoring/index behavior only; no ANALYZE/timing claims.
    const probe = evaluated.find(q=>q.id==='width-kana');
    assert.ok(probe);
    writeFileSync(`${out}/${mode.id}-plan.txt`,app('quality_mode',begin()+mode.settings+'EXPLAIN (COSTS OFF) '+querySql(mode,probe.trimmed,probe.normalized)+' COMMIT;'));
    const settings = owner('quality_mode',`DO $$ BEGIN
      PERFORM similarity('a','a'),bigm_similarity('a','a'),pgroonga_command('status');
      END $$; BEGIN; ${mode.settings}
      SELECT name,setting FROM pg_settings WHERE name LIKE 'pg_trgm.%' OR name LIKE 'pg_bigm.%' OR name LIKE 'pgroonga.%'; COMMIT;`);
    const result = {manifestHash:manifest.sha256,runKind:kind,image:imageRecord,mode:mode.id,engine:mode.engine,ddl:mode.ddl,settings,
      extensions:owner('quality_mode','SELECT extname,extversion FROM pg_extension ORDER BY extname;'),ranked:mode.ranked,rls:facts,
      overall:aggregate(scored),classes:Object.fromEntries(Object.keys(classes).map(c=>[c,aggregate(scored.filter(r=>r.class===c))])),queries:scored};
    results.push(result); save(`${out}/pending-summary.json`,results);
    console.log(`${mode.id}: micro F1 ${result.overall.micro.f1.toFixed(4)}, macro F1 ${result.overall.macro.f1.toFixed(4)}`);
    owner('postgres','DROP DATABASE quality_mode WITH (FORCE);');
  }
  save(`${out}/completed.json`,{manifestHash:manifest.sha256,runKind:kind,modes:results.length,queries:queries.length,rows:i});
}
}
