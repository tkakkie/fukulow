import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { b1Role, verifyB1 } from '../../search-engines/b1.ts';
import { benchmark, docker, save } from '../../search-engines/bench.ts';
import { channel, literal, member, org } from '../../search-engines/seed.ts';
import { planFacts, ratios, summarize } from './evidence.ts';
import type { Explain } from './evidence.ts';
import {
  context, expectedFull, foreignClasses, foreignRange, foreignRows, foreignSeed, latencyClasses, normalizeSql,
  pairedArms, query, read, reference, seedGram, transaction, variants, visible,
} from './model.ts';
import type { Arm, ForeignClass, Variant } from './model.ts';
import { measureSize, measureWrites } from './writes.ts';

const { values: args } = parseArgs({options:{
  out:{type:'string'}, repetitions:{type:'string', default:'20'}, smoke:{type:'boolean',default:false},
}});
const repetitions = Number(args.repetitions);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0, 'Use a positive --repetitions count');
assert.ok(args.out && !existsSync(args.out), 'Use a new --out directory outside the worktree');
const root = realpathSync.native(fileURLToPath(new URL('../../../',import.meta.url)));
const destination = resolve(args.out);
const out = resolve(realpathSync.native(dirname(destination)), destination.split(sep).at(-1)!);
assert.ok(out !== root && !out.startsWith(root + sep), 'Keep output outside the worktree');
assert.equal(process.version, 'v' + readFileSync(resolve(root,'.node-version'),'utf8').trim());
mkdirSync(out);

const name = 'fk689-poc-pg';
const image = 'fk689-poc-pg:local';
const reader = 'fukulow_probe';
const writer = 'fukulow_probe_writer';
const clients = args.smoke ? 1 : 5;
const primary = 'probe_few';
const b1File = (name: string) => readFileSync(resolve(root,'load/search-engines',name),'utf8');
const saveJson = (name: string, data: unknown) => save(resolve(out,name),data);
const roles = [reader,writer].map(user => `CREATE ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS; ALTER ROLE ${user} SET search_path = pg_catalog, pg_temp;`).join('\n');
const dbSettings = ['-c','jit=off','-c','autovacuum=off','-c','max_parallel_workers_per_gather=0'];
let container: string | undefined;

function sql(db: string, text: string, role = 'postgres') {
  return execFileSync('docker',['exec','-i',name,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U',role,'-d',db],{
    input:text, encoding:'utf8', timeout:180_000, maxBuffer:32*1024*1024,
  }).replace(/\r?\n$/,'');
}
const roleFor = (variant: Variant) => variant === 'b1' ? b1Role : reader;
const begin = (variant: Variant, value: string, orderedWalk = true) =>
  transaction(variant === 'b1' ? value : undefined)
  + (variant === 'd4' && orderedWalk ? 'SET LOCAL enable_bitmapscan=off;\n' : '');
const script = (variant: Variant, value: string, actor = 2, page = true) =>
  begin(variant,value) + query(variant,value,actor,page) + ';\nCOMMIT;\n';
const rows = (db: string, variant: Variant, value: string, actor = 2, page = true) =>
  sql(db,script(variant,value,actor,page),roleFor(variant)).split('\n').slice(1);
const ownerRows = (db: string, value: string, actor: number, page: boolean) => {
  const result = sql(db,reference(value,actor,page)+';');
  return result ? result.split('\n') : [];
};

function checkRole(db: string, role: string, tables: string[]) {
  const asRole = (query: string) => sql(db,query,role);
  const facts = asRole(`SELECT current_user, session_user, rolsuper, rolbypassrls, rolinherit,
    rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user;`);
  assert.equal(facts,`${role}|${role}|f|f|f|f|f|f`);
  assert.equal(asRole(`SELECT count(*) FROM pg_auth_members WHERE member=current_user::regrole
    OR roleid=current_user::regrole;`),'0');
  const rls = asRole(`SELECT relname, relrowsecurity, relforcerowsecurity, row_security_active(oid),
    relowner=current_user::regrole FROM pg_class WHERE oid IN
    (${tables.map(t=>`'public.${t}'::regclass`).join(',')}) ORDER BY relname;`);
  assert.equal(rls,[...tables].sort().map(t=>`${t}|t|t|t|f`).join('\n'));
  // Verify fail-closed context and foreign tenant denial in the actual backend.
  const access = Object.fromEntries(['messages','search_terms'].map(table=>{
    const count = `SELECT count(*) FROM public.${table}`;
    const counts = asRole(`${count};\nBEGIN;\n${context}${count};\n${count}
      WHERE organization_id=${literal(org(2))};\nCOMMIT;\n${count};`).split('\n').map(Number);
    assert.deepEqual([counts[0],counts[2],counts[3]],[0,0,0]);
    assert.ok(counts[1]! > 0);
    return [table,{withoutContext:counts[0],withContext:counts[1],foreign:counts[2],afterCommit:counts[3]}];
  }));
  const policies = sql(db,`SELECT c.relname, string_agg(p.polname || '/' || p.polcmd::text
    || CASE WHEN p.polpermissive THEN '/permissive' ELSE '/restrictive' END, ',' ORDER BY p.polname)
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.oid IN
    (${tables.map(t=>`'public.${t}'::regclass`).join(',')}) GROUP BY c.relname ORDER BY c.relname;`);
  assert.equal(policies,[...tables].sort().map(t=>`${t}|${t==='messages'
    ? 'b1_match/r/restrictive,org_isolation/*/permissive' : 'org_isolation/*/permissive'}`).join('\n'));
  const session = asRole(`SELECT current_setting('plan_cache_mode'),
    (SELECT count(*) FROM pg_prepared_statements), current_setting('row_security');`);
  assert.equal(session,'auto|0|on');
  return {facts,rls,policies,access,session};
}

function capture(db: string, variant: Variant, value: string, file: string, orderedWalk = true) {
  const output = sql(db,begin(variant,value,orderedWalk)
    + `PREPARE probe_read AS ${query(variant,value)};\n`
    + 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) EXECUTE probe_read;\n'
    + "SELECT row_to_json(p) FROM pg_prepared_statements p WHERE name='probe_read';\nCOMMIT;",roleFor(variant))
    .split('\n').slice(1);
  const prepared = JSON.parse(output.pop()!);
  assert.equal(prepared.generic_plans + prepared.custom_plans,1);
  const explain = output.join('\n');
  writeFileSync(resolve(out,file),explain+'\n');
  return {...planFacts(JSON.parse(explain) as Explain),
    prepared:{name:prepared.name,fromSql:prepared.from_sql,parameterTypes:prepared.parameter_types,
      genericPlans:prepared.generic_plans,customPlans:prepared.custom_plans}};
}

function prepareArm(db: string, many?: ForeignClass) {
  sql('postgres',`CREATE DATABASE ${db} TEMPLATE probe_base;`);
  sql(db,foreignClasses.map(c=>foreignSeed(c,c===many ? 'many' : 'few')).join('\n')
    + "\nCREATE EXTENSION pgroonga; SELECT pgroonga_command('status');");
  const oid = sql(db,'SELECT oid FROM pg_database WHERE datname=current_database();');
  assert.match(oid,/^\d+$/);
  const groongaBytes = () => Number(docker('exec',name,'sh','-c',
    `find "$PGDATA/base/${oid}" -maxdepth 1 -name 'pgrn*' -printf '%s\\n' | awk '{s+=\$1} END {print s+0}'`));
  const initial = groongaBytes();
  sql(db,read('d3-index.sql'));
  const d3GroongaFiles = groongaBytes() - initial;
  sql(db,'CREATE INDEX search_channel_recent ON public.messages (organization_id, channel_id, created_at DESC, id DESC);');
  sql(db,b1File('b1.sql')+b1File('pgroonga.sql'));
  sql(db,'VACUUM ANALYZE;');
  return d3GroongaFiles;
}

async function sample(db: string, variant: Variant, value: string, label: string, count: number) {
  const dest = resolve(out,label);
  await benchmark(name,db,script(variant,value),dest,count,clients,roleFor(variant));
  return readdirSync(dest).sort().flatMap(file=>readFileSync(resolve(dest,file),'utf8').trim().split('\n')
    .map(line=>Number(line.trim().split(/\s+/)[2])/1000));
}

function completeness(normalized: Record<string,string>) {
  const results = latencyClasses.map(([label,raw]) => {
    const value = normalized[label]!;
    const full = ownerRows(primary,value,2,false);
    const top = ownerRows(primary,value,2,true);
    assert.equal(full.length > 0,label !== 'miss',label);
    for (const variant of variants) {
      assert.deepEqual(rows(primary,variant,value,2,false),full,`${variant} ${label} full`);
      assert.deepEqual(rows(primary,variant,value),top,`${variant} ${label} top`);
    }
    return {label,raw,value,full,top};
  });
  const full = (label: string) => results.find(result=>result.label===label)!.full;
  assert.deepEqual(full('nfc'),full('nfd'));
  for (const [label,count] of Object.entries(expectedFull)) assert.equal(full(label).length,count,label);
  assert.deepEqual(full('time-window'),['800001','800004']);
  return results;
}

// Superuser count of the foreign scope key through the d3 index, plus per-arm sizes.
function termEvidence(db: string, target: ForeignClass, groongaFileBytes: number) {
  const key = channel(target.org,target.channel) + ':' + seedGram(target.key);
  const lookup = `SELECT count(*) FROM public.search_terms WHERE scope_term = ${literal(key)}`;
  const output = sql(db,`BEGIN;\nSET LOCAL enable_seqscan=off;\nSET LOCAL enable_bitmapscan=off;
    EXPLAIN (ANALYZE, FORMAT JSON) ${lookup};\n${lookup};
    SELECT count(*), pg_table_size('public.search_terms'), pg_relation_size('public.search_terms_exact')
      FROM public.search_terms;\nCOMMIT;`).split('\n');
  const [termRows,termTableBytes,indexRelationBytes] = output.pop()!.split('|').map(Number);
  const foreignKeyRows = Number(output.pop());
  const plan = JSON.stringify(JSON.parse(output.join('\n')));
  assert.match(plan,/"Index Name":"search_terms_exact"/);
  assert.doesNotMatch(plan,/"Seq Scan"/);
  return {key,foreignKeyRows,usedIndex:'search_terms_exact',
    termRows,termTableBytes,indexRelationBytes,groongaFileBytes};
}

async function timingExposure() {
  const evidence = [];
  const verification = {};
  for (const [index,target] of foreignClasses.entries()) {
    console.log(`Timing pair ${target.name}`);
    // Both arms are fresh databases with identical build and warm-up steps.
    const database = {few:`probe_few_${index}`,many:`probe_many_${index}`};
    const groongaFiles = {few:prepareArm(database.few),many:prepareArm(database.many,target)};
    for (const db of Object.values(database)) Object.assign(verification,{[db]:checkRole(db,reader,readTables)});
    const value = target.key;
    const termIndex = {few:termEvidence(database.few,target,groongaFiles.few),
      many:termEvidence(database.many,target,groongaFiles.many)};
    assert.deepEqual([termIndex.few.foreignKeyRows,termIndex.many.foreignKeyRows],[1,foreignRows]);
    assert.equal(termIndex.few.termRows,termIndex.many.termRows);
    const fixture = (db: string) => sql(db,`SELECT count(*), md5(string_agg(
       concat_ws('|',organization_id,channel_id,id,created_at,octet_length(body),
         CASE WHEN ${foreignRange(target)} THEN '' ELSE md5(body) END), ',' ORDER BY id)),
       count(*) FILTER (WHERE ${foreignRange(target)} AND strpos(normalized_body,${literal(value)})>0)
       FROM public.messages;`).split('|');
    const [count,fingerprint,fewMatches] = fixture(database.few);
    const [manyCount,manyFingerprint,manyMatches] = fixture(database.many);
    assert.deepEqual([manyCount,manyFingerprint],[count,fingerprint]);
    assert.deepEqual([Number(fewMatches),Number(manyMatches)],[1,foreignRows]);
    const page = ownerRows(database.few,value,2,true);
    assert.equal(page.length,1);
    assert.deepEqual(ownerRows(database.many,value,2,true),page);
    for (const [v, variant] of (['d3','d4'] as const).entries()) {
      const samples: Record<Arm,number[]> = {few:[],many:[]};
      const orders = [];
      for (const arm of ['few','many'] as const) {
        assert.deepEqual(rows(database[arm],variant,value),page);
        sql(database[arm],script(variant,value).repeat(3),reader);
      }
      // Two contiguous blocks reverse arm order when there are samples for both.
      const blockSizes = [Math.ceil(repetitions/2),Math.floor(repetitions/2)];
      for (const [block,count] of blockSizes.entries()) {
        if (!count) continue;
        const order = pairedArms(block,index+v);
        orders.push(order);
        for (const arm of order) samples[arm].push(...await sample(database[arm],variant,value,
          `pair-${target.name}-${variant}-${arm}-${block+1}`,count));
      }
      const few = summarize(samples.few);
      const many = summarize(samples.many);
      evidence.push({class:target.name,variant,fixture:{count:Number(count),fingerprint,page},termIndex,orders,
        few:{...few,foreignMatches:Number(fewMatches),samplesMs:samples.few},
        many:{...many,foreignMatches:Number(manyMatches),samplesMs:samples.many},
        manyOverFew:ratios(few,many),
        plans:Object.fromEntries((['few','many'] as const).map(arm=>[arm,capture(database[arm],variant,value,
          `pair-${target.name}-${variant}-${arm}-plan.json`)])),
      });
    }
    for (const db of Object.values(database)) sql('postgres',`DROP DATABASE ${db};`);
  }
  return {evidence,verification};
}

const readTables = ['messages','channels','channel_members','users','search_terms'];
function start() {
  assert.equal(docker('ps','-aq','--filter',`name=^/${name}$`),'',`Existing ${name}; choose a free host`);
  const imageDetails = JSON.parse(docker('image','inspect',image))[0];
  const base = b1File('Dockerfile').split('\n')[0]!.slice(5);
  container = docker('run','--detach','--rm','--name',name,'--network','none',
    '-e','POSTGRES_HOST_AUTH_METHOD=trust',image,...dbSettings);
  return {base,imageID:imageDetails.Id,repositoryDigests:imageDetails.RepoDigests,architecture:imageDetails.Architecture};
}
function cleanup() {
  if (!container) return;
  const id = container;
  if (docker('ps','-aq','--no-trunc','--filter',`id=${id}`) === id) docker('rm','-f','-v',id);
  container = undefined;
}
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{
  cleanup();
  process.exit(signal==='SIGINT' ? 130 : 143);
});

async function run() {
  const image = start();
  for (let attempt=0; ; attempt++) {
    // The initialization server uses the same socket but is never PID 1.
    try { docker('exec',name,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -q'); break; }
    catch (error) {
      if (attempt===59) throw error;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  sql('postgres',roles+'\nCREATE DATABASE probe_base;');
  sql('probe_base',read('schema.sql')+read('seed.sql'));
  const d3GroongaFiles = prepareArm(primary);
  const version = sql(primary,"SELECT current_setting('server_version_num'), extversion FROM pg_extension WHERE extname='pgroonga';");
  assert.equal(version,'180006|4.1.0');
  const source = (args:string[]) => execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trimEnd();
  const modulePath = dirname(fileURLToPath(import.meta.url));
  const harnessSha256 = Object.fromEntries(readdirSync(modulePath).filter(file=>/\.(sql|ts)$/.test(file))
    .map(file=>[file,createHash('sha256').update(read(file)).digest('hex')]));
  const metadata = {kind:args.smoke ? 'smoke' : 'measurement', scope:'small-DB only', startedAt:new Date().toISOString(),
    commit:source(['rev-parse','HEAD']), worktreeStatus:source(['status','--short']), harnessSha256,
    image, version, host:{platform:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,cpuCount:cpus().length,node:process.version},
    settings:JSON.parse(sql(primary,"LOAD 'pgroonga';\n"+'SELECT json_object_agg(name,setting || coalesce(unit, \'\')) FROM pg_settings;')),
    clients,repetitionsPerSearchClient:repetitions,planMode:'Auto; pgbench prepared protocol; EXPLAIN records SQL PREPARE state per query',
    d4PlanSetting:'enable_bitmapscan=off, transaction-local; one unforced comparison plan recorded',
    cache:'warm per class and arm (three same-query warmups); timing arms are fresh databases built the same way; shared and OS caches not flushed',
    roles:{d3d4:checkRole(primary,reader,readTables), b1:verifyB1(text=>sql(primary,text,b1Role)),
      writer:checkRole(primary,writer,['messages','search_terms'])},
    visibleScopes:sql(primary,transaction()+visible(2)+' SELECT id FROM visible ORDER BY id;\nCOMMIT;',reader)
      .split('\n').slice(1),
  };
  saveJson('metadata.json',metadata);
  const normalized = Object.fromEntries(latencyClasses.map(([label,raw])=>[label,sql(primary,normalizeSql(raw))]));
  const checks = completeness(normalized);
  saveJson('correctness.json',checks);
  const latency = [];
  console.log('Sampling same-database search latency');
  for (const [index,[label]] of latencyClasses.entries()) {
    const value = normalized[label]!;
    for (const variant of [...variants.slice(index%3),...variants.slice(0,index%3)]) {
      sql(primary,script(variant,value).repeat(3),roleFor(variant));
      const samplesMs = await sample(primary,variant,value,`read-${label}-${variant}`,repetitions);
      latency.push({label,variant,...summarize(samplesMs),samplesMs});
    }
  }
  saveJson('latency.json',{scope:metadata.scope,latency});
  const plans = Object.fromEntries(latencyClasses.map(([label])=>[label,Object.fromEntries(variants.map(variant=>
    [variant,capture(primary,variant,normalized[label]!,`read-${label}-${variant}-plan.json`)]))]));
  saveJson('plans.json',{...plans,unforcedD4:capture(primary,'d4',normalized.frequent!,
    'read-frequent-d4-unforced-plan.json',false)});
  const timing = await timingExposure();
  saveJson('timing.json',timing);
  console.log('Checking changes and measuring d3 writes');
  const inPrimary = (text: string, role?: string) => sql(primary,text,role);
  const size = measureSize(inPrimary,d3GroongaFiles);
  const consistency = checkConsistency();
  saveJson('consistency.json',consistency);
  saveJson('writes.json',{size,operations:measureWrites(inPrimary,writer,repetitions)});
  saveJson('metadata.json',{...metadata,finishedAt:new Date().toISOString(),timingArmRls:timing.verification});
}

function checkConsistency() {
  const db = primary;
  const id = 900001;
  const tenant = literal(org(1));
  const inChannel = (n: number) => literal(channel(1,n));
  const message = `organization_id=${tenant} AND id=${id}`;
  const changeMessage = (statement: string) => sql(db,`BEGIN;\n${context}${statement};\nCOMMIT;`,writer);
  const observations: {name:string;actor:number;value:string;expected:number[];found:Record<string,string[]>}[] = [];
  const check = (name: string, raw: string, expected: number[], actor = 2) => {
    const value = sql(db,normalizeSql(raw));
    const oracle = ownerRows(db,value,actor,false);
    assert.deepEqual(oracle,expected.map(String),name);
    const found = Object.fromEntries(variants.map(variant=>[variant,rows(db,variant,value,actor,false)]));
    for (const variant of variants) assert.deepEqual(found[variant],oracle,`${name} ${variant}`);
    observations.push({name,actor,value,expected,found});
  };
  const send = (scope: number, body: string) => changeMessage(`INSERT INTO public.messages
    VALUES (${tenant},${id},${inChannel(scope)},'2026-11-14',${literal(body)})`);
  const remove = () => changeMessage(`DELETE FROM public.messages WHERE ${message}`);
  const terms = () => sql(db,`SELECT json_build_array(pg_relation_filenode('public.search_terms_exact'),
    count(*),md5(string_agg(scope_term, ',' ORDER BY scope_term))) FROM public.search_terms
    WHERE organization_id=${tenant} AND message_id=${id};`);
  const keys: {name:string;before:unknown;after:unknown}[] = [];
  const matchingTerms = (scope: number, value: string) => Number(sql(db,`SELECT count(*) FROM public.search_terms
    WHERE organization_id=${tenant} AND message_id=${id}
      AND scope_term=${literal(channel(1,scope) + ':' + seedGram(value))};`));
  const termChanges: {name:string;actual:number[]}[] = [];
  const checkTerms = (name: string, actual: number[], expected: number[]) => {
    assert.deepEqual(actual,expected,name);
    termChanges.push({name,actual});
  };
  const withoutTermChanges = (name: string, operation: () => void) => {
    const before = terms();
    operation();
    const after = terms();
    assert.equal(after,before,name);
    keys.push({name,before:JSON.parse(before),after:JSON.parse(after)});
  };
  send(1,'oldeditflag');
  check('send','oldeditflag',[id]);
  changeMessage(`UPDATE public.messages SET body='neweditflag' WHERE ${message}`);
  check('edit removes old term','oldeditflag',[]);
  check('edit finds new term','neweditflag',[id]);
  checkTerms('edit replaces candidate keys',[matchingTerms(1,'oldeditflag'),matchingTerms(1,'neweditflag')],[0,1]);
  changeMessage(`UPDATE public.messages SET channel_id=${inChannel(5)} WHERE ${message}`);
  check('move hides destination from non-member','neweditflag',[]);
  check('move finds destination for granted Member','neweditflag',[id],4);
  checkTerms('move replaces scope key',[matchingTerms(1,'neweditflag'),matchingTerms(5,'neweditflag')],[0,1]);
  // A stale key in a visible public scope must not expose the private Message: d3 rechecks the Channel.
  const staleTerm = literal(channel(1,1) + ':' + seedGram('neweditflag'));
  sql(db,`INSERT INTO public.search_terms (organization_id, message_id, scope_term)
    VALUES (${tenant},${id},${staleTerm});`);
  checkTerms('stale public-scope key present',[matchingTerms(1,'neweditflag')],[1]);
  check('stale public-scope key leaves private Message hidden','neweditflag',[]);
  sql(db,`DELETE FROM public.search_terms
    WHERE organization_id=${tenant} AND message_id=${id} AND scope_term=${staleTerm};`);
  checkTerms('stale public-scope key removed',[matchingTerms(1,'neweditflag')],[0]);
  remove();
  check('delete removes Message','neweditflag',[],4);
  checkTerms('delete removes all candidate keys',[JSON.parse(terms())[1]],[0]);

  send(4,'authflag');
  check('private grant','authflag',[id]);
  withoutTermChanges('private grant removed',()=>{
    sql(db,`DELETE FROM public.channel_members WHERE organization_id=${tenant} AND channel_id=${inChannel(4)}
      AND member_id=${literal(member(1,2))};`);
    check('private grant removed','authflag',[]);
    check('other private Channel grant still usable','authflag',[id],1);
  });
  changeMessage(`UPDATE public.messages SET channel_id=${inChannel(2)} WHERE ${message}`);
  check('Guest with explicit grant','authflag',[id],3);
  changeMessage(`UPDATE public.messages SET channel_id=${inChannel(3)} WHERE ${message}`);
  check('Guest without grant on public Channel','authflag',[],3);
  check('Member before Guest role change','authflag',[id],1);
  withoutTermChanges('role changed to Guest',()=>{
    sql(db,`UPDATE public.users SET role='guest' WHERE organization_id=${tenant} AND id=${literal(member(1,1))};`);
    check('new Guest without grant on public Channel','authflag',[],1);
  });
  check('active Member before deactivation','authflag',[id],4);
  withoutTermChanges('deactivation',()=>{
    sql(db,`UPDATE public.users SET deactivated_at=now() WHERE organization_id=${tenant} AND id=${literal(member(1,4))};`);
    check('deactivated Member','authflag',[],4);
  });
  check('public Channel visible to Member','authflag',[id]);
  withoutTermChanges('public Channel made private',()=>{
    sql(db,`UPDATE public.channels SET visibility='private' WHERE organization_id=${tenant} AND id=${inChannel(3)};`);
    check('Channel made private','authflag',[]);
  });
  remove();
  return {observations,termChanges,unchangedTermSnapshots:keys};
}


try {
  await run();
  console.log(`Completed ${args.smoke ? 'smoke' : 'small-DB measurement'} at ${out}`);
} finally {
  cleanup();
}
