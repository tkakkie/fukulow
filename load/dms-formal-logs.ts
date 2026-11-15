import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

export const appLogLimit=64*1024*1024;
// Keep a live reader across Docker rotation. On overflow, continue draining but
// explicitly disqualify the retained evidence; never silently keep a tail.
export function captureAppLogs(directory:string,args:string[],limit=appLogLimit,program='docker',name='app',stopSignal:NodeJS.Signals='SIGTERM') {
  const path=`${directory}/${name}.log`;
  writeFileSync(path,'',{mode:0o600});
  const startedAt=Date.now();
  const child=spawn(program,args,{stdio:['ignore','ignore','pipe']});
  let bytes=0,truncated=false,reason:string|undefined,stopping=false;
  child.stderr.on('data',(data:Buffer)=>{
    if(bytes+data.length>limit) {truncated=true;return;}
    if(!truncated)try {appendFileSync(path,data);bytes+=data.length;}catch {reason='app log write failed';}
  });
  child.on('error',()=>{reason='app log reader spawn failed';});
  const closed=new Promise<void>(resolve=>child.on('close',(code,signal)=>{
    if(!stopping || (code!==0 && signal!==stopSignal))reason ??= 'app log reader exited unexpectedly';
    resolve();
  }));
  return async()=>{
    // The local Docker CLI handles SIGTERM itself and reports a nonzero exit.
    // An explicitly requested SIGKILL gives an unambiguous terminal signal;
    // close still waits for both pipes to drain before retaining the manifest.
    stopping=true;child.kill(stopSignal);
    const timer=setTimeout(()=>{reason ??= 'app log reader stop timeout';child.kill('SIGKILL');},5000);
    await closed;clearTimeout(timer);
    const record={complete:!truncated && !reason,reason:truncated?'64 MiB app log retention limit exceeded':reason,startedAt,endedAt:Date.now(),bytes,limit};
    writeFileSync(`${directory}/${name}-log-retention.json`,JSON.stringify(record),{mode:0o600});
    return record;
  };
}
