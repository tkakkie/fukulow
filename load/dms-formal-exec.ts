import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
export type Command = { program: string; args: string[]; input?: string; timeout?: number; log?: string; signal?: AbortSignal };
export type Result = { code: number; stdout: string };
export type Executor = (command: Command) => Promise<Result>;
// Each command owns a POSIX process group. Reap the leader via exit, then bound
// inherited pipe/log teardown independently of descendant close events.
export const execute: Executor = async ({ program, args, input, timeout = 120_000, log, signal }) => new Promise((resolveRun, reject) => {
  const child = spawn(program, args, { detached:true, stdio:['pipe','pipe','pipe'] });
  const stream = log ? createWriteStream(log,{mode:0o600}) : undefined;
  let stdout='', failure:string|undefined, settled=false;
  let teardown:ReturnType<typeof setTimeout>|undefined;
  const kill = () => { if(child.pid)try { process.kill(-child.pid,'SIGKILL'); } catch { /* Group already reaped. */ } };
  const finish = (code:number) => {
    if(settled)return; settled=true;clearTimeout(timer);clearTimeout(teardown);
    signal?.removeEventListener('abort',abort); kill();
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    stream?.destroy();
    if(failure)reject(new Error(`${program} ${failure}`));else resolveRun({code,stdout});
  };
  const stop = (reason:string) => { failure=reason;kill(); teardown ??= setTimeout(()=>finish(124),250); };
  const abort = () => stop('aborted');
  const timer=setTimeout(()=>stop('timeout/output limit'),timeout);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  stream?.on('error',()=>stop('private log write failed'));
  child.stdout.on('data',(data:Buffer)=>{
    if(stream) { if(!stream.write(data)) {child.stdout.pause();stream.once('drain',()=>child.stdout.resume());} }
    else { stdout+=data.toString();if(stdout.length>64*1024*1024)stop('timeout/output limit'); }
  });
  child.stderr.on('data',(data:Buffer)=>{if(stream && !stream.write(data)){child.stderr.pause();stream.once('drain',()=>child.stderr.resume());}});
  child.on('error',error=>{failure=`could not execute: ${error.name}`;finish(128);});
  child.on('exit',()=>{kill();teardown ??= setTimeout(()=>{failure ??= 'pipe teardown timeout';finish(124);},250);});
  child.on('close',code=>{
    if(stream)stream.end(()=>finish(code??128));else finish(code??128);
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
