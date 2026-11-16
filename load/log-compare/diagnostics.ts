import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Database } from './database.ts';
interface WalStats { wal_records:number; wal_fpi:number; wal_bytes:number; stats_reset:string }
interface Checkpointer { num_timed:number; num_requested:number; num_done:number; restartpoints_done:number; stats_reset:string }
interface TableStats { schemaname:string; relname:string; autovacuum_count:number; autoanalyze_count:number; last_autovacuum:string|null; last_autoanalyze:string|null }
interface Stats {
  capturedAt:string; wal:WalStats; checkpointer:Checkpointer; tables:TableStats[];
  autovacuumActive:boolean; autovacuumWorkers:unknown[]; vacuumProgress:unknown[];
}
export function statsSnapshot(db:Database):Stats {
  // Each call uses a fresh psql transaction: no cached snapshot and no counter reset.
  return JSON.parse(db.sql(`SELECT json_build_object(
    'capturedAt',clock_timestamp(),
    'wal',(SELECT row_to_json(w) FROM (SELECT wal_records,wal_fpi,wal_bytes,stats_reset FROM pg_stat_wal) w),
    'checkpointer',(SELECT row_to_json(c) FROM (SELECT num_timed,num_requested,num_done,restartpoints_done,stats_reset FROM pg_stat_checkpointer) c),
    'tables',(SELECT COALESCE(json_agg(t),'[]') FROM (SELECT schemaname,relname,autovacuum_count,autoanalyze_count,last_autovacuum,last_autoanalyze FROM pg_stat_user_tables ORDER BY schemaname,relname) t),
    'autovacuumActive',EXISTS(SELECT FROM pg_stat_activity WHERE backend_type='autovacuum worker'),
    'autovacuumWorkers',(SELECT COALESCE(json_agg(a),'[]') FROM (SELECT pid,datname,state,query_start,query FROM pg_stat_activity WHERE backend_type='autovacuum worker') a),
    'vacuumProgress',(SELECT COALESCE(json_agg(v),'[]') FROM pg_stat_progress_vacuum v))`));
}
export function settleFixture(db:Database) {
  // Catalog enumeration covers every fixture arm and its ledger, never scans heap data.
  const tables=JSON.parse(db.sql(`SELECT COALESCE(json_agg(format('%I.%I',schemaname,relname) ORDER BY schemaname,relname),'[]') FROM pg_stat_user_tables`)) as string[];
  if(tables.length)db.sql(`VACUUM (FREEZE, ANALYZE) ${tables.join(', ')};`);
}
export function walEnd(db:Database,start:string):{endLSN:string;walBytes:number} {
  return JSON.parse(db.sql(`WITH endpoint AS MATERIALIZED (SELECT pg_current_wal_lsn() lsn)
    SELECT json_build_object('endLSN',lsn,'walBytes',pg_wal_lsn_diff(lsn,'${start}')) FROM endpoint`));
}
interface WalSize { records:number; recordBytes:number; fpiBytes:number; bytes:number }
export interface WalDumpSummary { byRecord:Record<string,WalSize>; byResourceManager:Record<string,WalSize>; total:WalSize }
export function parseWalDump(raw:string):WalDumpSummary {
  const byRecord:Record<string,WalSize>={},byResourceManager:Record<string,WalSize>={};
  const total:WalSize={records:0,recordBytes:0,fpiBytes:0,bytes:0};
  for(const line of raw.split('\n')) {
    const m=/^(.+?\/.*?)\s+(\d+)\s+\([\d. ]+\)\s+(\d+)\s+\([\d. ]+\)\s+(\d+)\s+\([\d. ]+\)\s+(\d+)\s+\([\d. ]+\)\s*$/.exec(line);
    if(!m)continue;
    const row={records:Number(m[2]),recordBytes:Number(m[3]),fpiBytes:Number(m[4]),bytes:Number(m[5])};
    if(row.recordBytes+row.fpiBytes!==row.bytes)throw new Error('pg_waldump size mismatch');
    const name=m[1].trim(),manager=name.split('/')[0];byRecord[name]=row;
    const sum=byResourceManager[manager]??={records:0,recordBytes:0,fpiBytes:0,bytes:0};
    for(const key of ['records','recordBytes','fpiBytes','bytes'] as const) {sum[key]+=row[key];total[key]+=row[key];}
  }
  const totals=/^Total\s+(\d+)\s+(\d+)\s+\[[\d.]+%\]\s+(\d+)\s+\[[\d.]+%\]\s+(\d+)\s+\[100%\]/m.exec(raw);
  if(!totals || [total.records,total.recordBytes,total.fpiBytes,total.bytes].some((n,i)=>n!==Number(totals[i+1])))throw new Error('incomplete pg_waldump statistics');
  return {byRecord,byResourceManager,total};
}
export type WalDump = {status:'available';rawFile:string;binary:string;summary:WalDumpSummary} | {status:'unavailable';rawFile:string;binary?:string;reason:string};
function dumpCommand(...args:string[]):string {
  const result=spawnSync('docker',args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000});
  if(result.error || result.status!==0)throw Object.assign(new Error(result.error?.message??(result.stderr?.trim()||`docker exited ${result.status}`)),{stdout:result.stdout,stderr:result.stderr});
  return result.stdout+result.stderr;
}
export function captureWalDump(db:Database,start:string,end:string,out:string,command=dumpCommand,save=writeFileSync):WalDump {
  const path=out+'.waldump.txt',rawFile=basename(path);let raw='',binary:string|undefined;
  try {
    binary=command('exec',db.name,'pg_config','--bindir').trim()+'/pg_waldump';
    const data= db.sql('SHOW data_directory');
    raw=command('exec','-e','LC_ALL=C',db.name,binary,'--stats=record','--path',data+'/pg_wal','--start',start,'--end',end);
    save(path,raw);
    return {status:'available',rawFile,binary,summary:parseWalDump(raw)};
  } catch(error) {
    const failure=error as {stdout?:string|Buffer;stderr?:string|Buffer};
    const reason=String(error);
    save(path,raw+'\n'+(failure.stdout??'')+'\n'+(failure.stderr??'')+'\nUNAVAILABLE: '+reason);
    return {status:'unavailable',rawFile,binary,reason};
  }
}
export function walDiagnostics(db:Database,before:Stats,startLSN:string,endLSN:string,out:string) {
  const after=statsSnapshot(db);
  const delta={wal_records:after.wal.wal_records-before.wal.wal_records,wal_fpi:after.wal.wal_fpi-before.wal.wal_fpi,wal_bytes:after.wal.wal_bytes-before.wal.wal_bytes};
  const reset=before.wal.stats_reset!==after.wal.stats_reset || before.checkpointer.stats_reset!==after.checkpointer.stats_reset;
  return {startLSN,endLSN,before,after,pgStatWalDelta:delta,statsResetDetected:reset,
    scope:'Cluster-wide WAL/checkpointer and worker activity; table stats in compare. Snapshots outside timed work bracket the LSN window with SQL/transport skew; cumulative stats may lag, no resets/forced flushes. pg_waldump reads whole records in the LSN range; LSN bytes also include page/segment overhead and possible boundary fragments. No checkpoint/FPI cost is removed from reported WAL or gates.',
    walDump:captureWalDump(db,startLSN,endLSN,out)};
}
