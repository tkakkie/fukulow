import { checked, type Executor } from './dms-formal-exec.ts';
// The daemon container outlives a failed CLI. Always stop, wait and remove the
// exact attempt-owned container before another restore can mutate the volume.
export async function removeCopy(exec:Executor,name:string) {
  const found=await checked(exec,{program:'docker',args:['ps','-aq','--filter',`name=^/${name}$`],timeout:10000});
  if(!found)return;
  await checked(exec,{program:'docker',args:['stop','--time','1',name],timeout:15000});
  await checked(exec,{program:'docker',args:['wait',name],timeout:15000});
  await checked(exec,{program:'docker',args:['rm','-f',name],timeout:15000});
}
export async function copyVolume(exec:Executor,id:string,attempt:number,from:string,to:string,image:string,reset:boolean,pullNever=false,onFailure?:(error:unknown)=>void) {
  const name=`${id}-copy-${attempt}`;
  try {
    await checked(exec,{program:'docker',args:['run',...(pullNever?['--pull=never']:[]),'--name',name,'--label',`dm-formal=${id}`,'-v',`${from}:/from:ro`,'-v',`${to}:/to`,image,'sh','-ec',(reset?'find /to -mindepth 1 -maxdepth 1 -exec rm -rf {} +; ':'')+'cp -a /from/. /to/'],timeout:7200000,captureStderr:!!onFailure});
  } catch(error) {
    onFailure?.(error);
    throw error;
  } finally { await removeCopy(exec,name); }
}
