import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { corpus, classes, queries as qualityQueries } from './quality/dataset.ts';
import { modes } from './quality/modes.ts';
import { queries } from './queries.ts';
import { seed, epoch } from './seed.ts';
import { timeouts } from './runtime.ts';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
export const settings: Record<string,string> = {
  shared_buffers:'8192',work_mem:'4096',maintenance_work_mem:'65536',effective_cache_size:'524288',
  random_page_cost:'4',max_connections:'100',max_worker_processes:'16',jit:'on',fsync:'on',
  synchronous_commit:'on',wal_level:'replica',max_wal_size:'1024',checkpoint_timeout:'300',server_encoding:'UTF8',
  shared_preload_libraries:'pgroonga_wal_resource_manager,pgroonga_crash_safer',
  'pgroonga.enable_wal_resource_manager':'on','pgroonga.enable_crash_safe':'on',
};
export const extensions = {pg_trgm:'1.6',pg_bigm:'1.2',pgroonga:'4.1.0'};
export const packages = {
  'postgresql-18':'18.6-1.pgdg13+2','postgresql-client-18':'18.6-1.pgdg13+2',
  'postgresql-server-dev-18':'18.6-1.pgdg13+2','postgresql-18-pgdg-pgroonga':'4.1.0-1','libgroonga0':'16.1.3-1',
};
export function snapshot() {
  const files = ['.node-version','load/package-lock.json',
    ...['load/search-engines','load/search-engines/quality','server/migrations'].flatMap(dir=>
      readdirSync(dir).filter(n=>!n.includes('.test.') && /\.(ts|sql)$/.test(n)).map(n=>`${dir}/${n}`)),
    'load/search-engines/Dockerfile','deploy/db-grants.sql','deploy/db-roles.sql','deploy/db-role-settings.sql'].sort();
  const data = corpus();
  return {version:1,date:'2026-11-15',generator:{version:1,seed,clock:new Date(epoch).toISOString()},
    node:readFileSync('.node-version','utf8').trim(),
    sourceHashes:Object.fromEntries(files.map(p=>[p,hash(readFileSync(p,'utf8'))])),
    quality:{querySet:qualityQueries.map(({gold,...q})=>({...q,relevantKeys:gold.map(id=>data.find(m=>m.id===id)?.key)})),
      relevancePolicy:classes,modes:modes.map(({predicate,score,...mode})=>mode),corpusHash:jsonHash(data),queryHash:jsonHash(qualityQueries.map(({gold,...q})=>q)),
      relevanceHash:jsonHash({classes,labels:qualityQueries.map(q=>({query:q.id,gold:q.gold}))}),
      visibleRows:data.length,totalRows:data.length+3*data.filter(m=>!m.key.startsWith('background')).length,
      queries:qualityQueries.length,classes:Object.keys(classes).length,
      relevantPairs:qualityQueries.reduce((n,q)=>n+q.gold.length,0)},
    performance:{querySet:queries,rows:1_000_000,restoreRows:1000,queryHash:jsonHash(queries),queries:queries.length,
      clients:5,transactions:20,rounds:3,warmupSweeps:1,writeWarmTransactions:10,writeTransactions:200,
      order:[['none','trgm','bigm','pgroonga'],['bigm','pgroonga','none','trgm'],['pgroonga','trgm','bigm','none']]},
    timing:{timeouts,startupAttempts:60,startupPollMs:500,rangeDays:180,qualityTimed:false},
    image:{base:readFileSync('load/search-engines/Dockerfile','utf8').split('\n')[0].slice(5),
      packages,extensions,pgBigmRelease:'v1.2-20250903'},settings,shmBytes:1073741824};
}
export function verifyManifest(document: {sha256:string; frozen:ReturnType<typeof snapshot>}, actual = snapshot()) {
  assert.equal(jsonHash(document.frozen),document.sha256,'Frozen manifest content hash mismatch');
  assert.deepEqual(actual,document.frozen,'Frozen evaluation manifest mismatch; prepare a reviewed new manifest version before running');
  assert.equal(process.version,`v${document.frozen.node}`,'Use frozen Node version');
  for (const [name,value] of [['SEARCH_ROWS',document.frozen.performance.rows],['SEARCH_TRANSACTIONS',document.frozen.performance.transactions]] as const) {
    if (process.env[name] !== undefined) assert.equal(process.env[name],String(value),`${name} differs from frozen conditions`);
  }
  return document.sha256;
}
export function loadManifest() {
  const doc = JSON.parse(readFileSync('load/search-engines/manifest-v1.json','utf8'));
  return {sha256:verifyManifest(doc),frozen:doc.frozen as ReturnType<typeof snapshot>};
}
export function verifyRuntime(sql: (text:string)=>string, docker: (...args:string[])=>string, container: string) {
  assert.equal(sql('SHOW server_version_num;'),'180006','Frozen PostgreSQL version mismatch');
  const actualExtensions = JSON.parse(sql("SELECT json_object_agg(name,default_version) FROM pg_available_extensions WHERE name IN ('pg_trgm','pg_bigm','pgroonga');"));
  assert.deepEqual(actualExtensions,extensions,'Frozen extension versions mismatch');
  const actualSettings = JSON.parse(sql(`SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN (${Object.keys(settings).map(n=>`'${n}'`).join(',')});`));
  assert.deepEqual(actualSettings,settings,'Frozen PostgreSQL settings mismatch');
  const actualPackages = Object.fromEntries(docker('exec',container,'dpkg-query','-W','-f=${Package}|${Version}\\n',...Object.keys(packages))
    .split('\n').map(line=>line.split('|')));
  assert.deepEqual(actualPackages,packages,'Frozen package versions mismatch');
}
