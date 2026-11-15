import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const image=/image: (postgres:[^\s]+)/.exec(readFileSync(new URL('../compose.yml',import.meta.url),'utf8'))?.[1];
if(!image)throw new Error('missing pinned image');
export const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:128*1024*1024}).trim();
export class Session {
  child:ReturnType<typeof spawn>; buffer=''; stderr='';
  pending?:{marker:string;resolve:(s:string)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>};
  constructor(container:string,db:string,user='fukulow_app') {
    this.child=spawn('docker',['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U',user,'-d',db],{stdio:['pipe','pipe','pipe']});
    this.child.stdout?.on('data',v=>{this.buffer+=String(v);this.flush();});
    this.child.stderr?.on('data',v=>{this.stderr+=String(v);});
    this.child.on('error',e=>this.fail(e));this.child.on('close',code=>this.fail(new Error(`psql exited ${code}: ${this.stderr}`)));
  }
  fail(e:Error){if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(e);this.pending=undefined;}}
  flush(){if(!this.pending)return;const at=this.buffer.indexOf(this.pending.marker+'\n');if(at<0)return;
    const p=this.pending;this.pending=undefined;clearTimeout(p.timer);const value=this.buffer.slice(0,at).trim();this.buffer=this.buffer.slice(at+p.marker.length+1);p.resolve(value);}
  query(sql:string):Promise<string>{
    if(this.pending)throw new Error('session busy');
    if(this.child.exitCode!==null)throw new Error('session closed');
    const marker='end_'+randomUUID().replaceAll('-','');
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.fail(new Error('query timeout (900s)'));this.child.kill();},900000);
      this.pending={marker,resolve,reject,timer};this.child.stdin?.write(sql+'\n\\echo '+marker+'\n');this.flush();});
  }
  async close(){if(this.child.exitCode!==null||this.child.signalCode!==null)return;const done=new Promise<void>(r=>this.child.once('close',()=>r()));this.child.stdin?.end();await done;}
}
export class Database {
  name=`fukulow-unread-init-${process.pid}-${randomUUID().slice(0,8)}`; created=false;
  start(){this.created=true;docker('run','-d','--name',this.name,'-p','127.0.0.1::5432','-e','POSTGRES_HOST_AUTH_METHOD=trust',image!,
    '-c','shared_buffers=128MB','-c','work_mem=4MB','-c','max_connections=30');}
  async ready(){for(let i=0;i<120;i++){try{docker('exec',this.name,'pg_isready','-U','postgres');return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('Postgres readiness timeout');}
  sql(sql:string,db='postgres'){return execFileSync('docker',['exec','-i',this.name,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],{input:sql,encoding:'utf8',maxBuffer:128*1024*1024}).trim();}
  migrate(){
    this.sql('CREATE DATABASE base;');
    const port=docker('port',this.name,'5432/tcp').split(':').at(-1);
    execFileSync('sqlx',['--no-dotenv','migrate','run','--source','server/migrations','--database-url',`postgres://postgres@127.0.0.1:${port}/base`],{stdio:['ignore','pipe','pipe']});
    this.sql(`BEGIN; SET LOCAL fukulow.app_password='unread-init-throwaway';\n${readFileSync('deploy/db-roles.sql','utf8')}\n${readFileSync('deploy/db-grants.sql','utf8')}\nCOMMIT;`,'base');
  }
  clone(name:string,from:string){this.sql(`CREATE DATABASE ${name} TEMPLATE ${from};`);}
  drop(name:string){this.sql(`DROP DATABASE ${name} WITH (FORCE);`);}
  cleanup(){if(this.created)docker('rm','-fv',this.name);}
}
