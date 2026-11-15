import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const image = /image: (postgres:[^\s]+)/.exec(readFileSync(new URL('../compose.yml',import.meta.url),'utf8'))?.[1];
if (!image) throw new Error('missing pinned Postgres image');
export const docker = (...args: string[]) => execFileSync('docker', args,
  { encoding:'utf8', maxBuffer:256*1024*1024 }).trim();
export function dockerAsync(...args: string[]): Promise<string> {
  return new Promise((resolve,reject) => {
    const child = spawn('docker',args,{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',v => { stdout+=String(v); }); child.stderr.on('data',v => { stderr+=String(v); });
    child.on('error',reject); child.on('close',code => code===0 ? resolve(stdout+stderr) : reject(new Error(stderr+stdout)));
  });
}
// A single persistent psql session allows deterministic migration/writer barriers.
export class Session {
  child: ReturnType<typeof spawn>;
  pending?: { marker:string; resolve:(value:string)=>void; reject:(error:Error)=>void };
  buffer=''; stderr='';
  constructor(container:string,database:string) {
    this.child=spawn('docker',['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],
      {stdio:['pipe','pipe','pipe']});
    this.child.stdout?.on('data',chunk => { this.buffer+=String(chunk); this.flush(); });
    this.child.stderr?.on('data',chunk => { this.stderr+=String(chunk); });
    this.child.on('error',error => { this.pending?.reject(error); });
    this.child.on('close',code => { this.pending?.reject(new Error(`psql exited ${code}: ${this.stderr}`)); });
  }
  flush() {
    if (!this.pending) return;
    const at=this.buffer.indexOf(this.pending.marker+'\n');
    if (at<0) return;
    const pending=this.pending; this.pending=undefined;
    const output=this.buffer.slice(0,at).trim(); this.buffer=this.buffer.slice(at+pending.marker.length+1);
    pending.resolve(output);
  }
  query(sql:string):Promise<string> {
    if (this.pending) throw new Error('concurrent query on one session');
    const marker=`end_${randomUUID().replaceAll('-','')}`;
    return new Promise((resolve,reject) => {
      this.pending={marker,resolve,reject};
      this.child.stdin?.write(sql+'\n\\echo '+marker+'\n'); this.flush();
    });
  }
  async close() {
    if(this.child.exitCode!==null || this.child.signalCode!==null) return;
    const closed=new Promise<void>(resolve=>this.child.once('close',()=>resolve()));
    this.child.stdin?.end(); await closed;
  }
}
export class Database {
  name=`fukulow-log-compare-${process.pid}-${randomUUID().slice(0,8)}`;
  volume=this.name+'-data';
  created=false; volumeCreated=false;
  start() {
    docker('volume','create',this.volume); this.volumeCreated=true;
    docker('run','-d','--name',this.name,'--mount',`type=volume,source=${this.volume},target=/var/lib/postgresql`,
      '-e','POSTGRES_HOST_AUTH_METHOD=trust',image!,
      '-c','shared_preload_libraries=pg_stat_statements','-c','pg_stat_statements.track=all',
      '-c','shared_buffers=128MB','-c','work_mem=4MB','-c','max_connections=100'); this.created=true;
  }
  sql(sql:string,database='compare'):string {
    return execFileSync('docker',['exec','-i',this.name,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],
      {input:sql,encoding:'utf8',maxBuffer:256*1024*1024}).trim();
  }
  async ready() {
    for(let i=0;i<60;i++) {
      try { docker('exec',this.name,'pg_isready','-h','127.0.0.1','-U','postgres'); return; } catch { /* still initializing */ }
      await new Promise(r=>setTimeout(r,250));
    }
    throw new Error('Postgres readiness timeout');
  }
  reset() {
    this.sql('DROP DATABASE IF EXISTS compare;','postgres');
    this.sql('CREATE DATABASE compare;','postgres');
  }
  copy(text:string,path:string) {
    docker('exec',this.name,'mkdir','-p','/tmp/log-compare');
    execFileSync('docker',['exec','-i',this.name,'tee',path],{input:text,stdio:['pipe','ignore','pipe']});
  }
  async cold() {
    // Flush PostgreSQL shared buffers. Host/VM filesystem cache is deliberately
    // not evicted: global cache eviction would disturb other measurements.
    docker('restart',this.name); await this.ready();
  }
  cleanup() {
    if(this.created) docker('rm','-f',this.name);
    if(this.volumeCreated) docker('volume','rm',this.volume);
  }
}
export interface Sizes { heap:number; index:number; relations:unknown }
export function sizes(db:Database):Sizes {
  const relations=JSON.parse(db.sql(`SELECT json_agg(t) FROM (SELECT relname,
    pg_table_size(oid)::float8 heap,pg_indexes_size(oid)::float8 index FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname) t`)) as {heap:number;index:number}[];
  return {heap:relations.reduce((s,r)=>s+r.heap,0),index:relations.reduce((s,r)=>s+r.index,0),relations};
}
export const lsn = (db:Database) => db.sql('SELECT pg_current_wal_lsn()');
export const walDelta = (db:Database,start:string) => Number(db.sql(`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),'${start}')`));
