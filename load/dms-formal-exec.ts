import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';
import { currentGroup, stopGroups } from './dms-formal-groups.ts';
export type Command = { program: string; args: string[]; input?: string; timeout?: number; log?: string; signal?: AbortSignal };
export type Result = { code: number; stdout: string };
export type Executor = (command: Command) => Promise<Result>;
// The outer executor owns the group; nested executors inherit it, including
// seed/reduction workers. A nested timeout cancels the entire owning group.
export const execute: Executor = async ({ program, args, input, timeout = 120_000, log, signal }) => new Promise((resolveRun, reject) => {
  const nested=!!process.env.DM_FORMAL_OWNED_GROUP;
  const owner=nested?currentGroup():undefined;
  const child = spawn(nested?program:'sh', nested?args:['-c','export DM_FORMAL_OWNED_GROUP=$$; exec "$@"','dm-command',program,...args], { detached:!nested, stdio:['pipe','pipe','pipe'] });
  const stream = log ? createWriteStream(log,{mode:0o600}) : undefined;
  let bytes=0,flushed=false;
  const startedAt=Date.now();
  let stdout='', failure:string|undefined, settled=false;
  let teardown:ReturnType<typeof setTimeout>|undefined;
  const kill = () => { if(!nested && child.pid)try { process.kill(-child.pid,'SIGKILL'); } catch { /* Group already reaped. */ } };
  const finish = (code:number) => {
    if(settled)return; settled=true;clearTimeout(timer);clearTimeout(teardown);
    signal?.removeEventListener('abort',abort); kill();
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    stream?.destroy();
    void (async()=>{
      if(!nested && child.pid)await stopGroups([child.pid]);
      if(log)writeFileSync(log+'-retention.json',JSON.stringify({bytes,complete:flushed && !failure,startedAt,endedAt:Date.now()}),{mode:0o600});
      if(failure)throw new Error(`${program} ${failure}`);
      return {code,stdout};
    })().then(resolveRun,reject);
  };
  const stop = (reason:string) => { failure=reason;if(owner)process.kill(-owner,'SIGKILL');kill(); teardown ??= setTimeout(()=>finish(124),250); };
  const abort = () => stop('aborted');
  const timer=setTimeout(()=>stop('timeout/output limit'),timeout);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  stream?.on('error',()=>stop('private log write failed'));
  child.stdout.on('data',(data:Buffer)=>{
    if(stream) { bytes+=data.length;if(!stream.write(data)) {child.stdout.pause();stream.once('drain',()=>child.stdout.resume());} }
    else { stdout+=data.toString();if(stdout.length>64*1024*1024)stop('timeout/output limit'); }
  });
  child.stderr.on('data',(data:Buffer)=>{if(stream){bytes+=data.length;if(!stream.write(data)){child.stderr.pause();stream.once('drain',()=>child.stderr.resume());}}});
  child.on('error',error=>{failure=`could not execute: ${error.name}`;finish(128);});
  child.on('exit',()=>{kill();teardown ??= setTimeout(()=>{failure ??= 'pipe teardown timeout';finish(124);},250);});
  child.on('close',code=>{
    if(stream)stream.end(()=>{flushed=true;finish(code??128);});else finish(code??128);
  });
  child.stdin.on('error',()=>{});child.stdin.end(input);
});
export async function checked(exec:Executor,command:Command):Promise<string> {
  const result=await exec(command);
  if(result.code!==0)throw new Error(`${command.program} failed (exit ${result.code}); see private artifacts`);
  return result.stdout.trim();
}
export async function transferImage(source:string[],target:string[],timeout=600_000,signal?:AbortSignal):Promise<void> {
  // Pipeline runs in one owned group; execute handles descendants and pipe teardown.
  const q=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
  await checked(execute,{program:'bash',args:['-o','pipefail','-c',`ssh ${source.map(q).join(' ')} | ssh ${target.map(q).join(' ')}`],timeout,signal});
}
