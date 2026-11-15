// Keep signal handling outside the synchronous SQL worker, including hung clients.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const timeouts = { docker:120_000, build:900_000, psql:900_000, benchmark:900_000, cleanup:10_000 };
export const ownedContainer = () => process.env.SEARCH_OWNED_CONTAINER ?? '';
export const ownedVolume = () => process.env.SEARCH_OWNED_VOLUME ?? '';

export async function cleanup(container: string, volume: string, timeout = timeouts.cleanup) {
  const failures: string[] = [];
  const call = async (args: string[], absent = false) => {
    const r = await new Promise<{code:number|null;stdout:string;stderr:string;failed:boolean}>(resolve=>{
      const child = spawn('docker',args,{stdio:['ignore','pipe','pipe']});
      let stdout='', stderr='', failed=false;
      const timer = setTimeout(()=>{failed=true;child.kill('SIGKILL');},timeout);
      child.stdout.on('data',data=>{stdout+=String(data);});
      child.stderr.on('data',data=>{stderr+=String(data);});
      child.on('error',()=>{failed=true;});
      child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,failed});});
    });
    if (r.failed || (r.code!==0 && !(absent && /No such (container|volume)/i.test(r.stderr)))) {
      failures.push(`docker ${args[0]} cleanup failed or timed out`);
    }
    return r;
  };
  await call(['rm','-fv',container],true);
  await call(['volume','rm','-f',volume],true);
  for (const [kind,name] of [['container',container],['volume',volume]]) {
    const r = await call([kind,'ls',kind==='container'?'-aq':'-q','--filter',`name=${name}`]);
    if (r.stdout.trim()) failures.push(`${kind} cleanup verification found an owned resource`);
  }
  if (failures.length) throw new Error(failures.join('; '));
}

export async function supervise(entry: string, out: string, manifestHash: string, finalize?: () => void) {
  if (process.env.SEARCH_WORKER === '1') return true;
  const token = randomUUID();
  const container = `fukulow-search-153-${token}`;
  const volume = `${container}-data`;
  let interrupted = 0;
  let workerClosed = false;
  let terminal = false;
  const child = spawn(process.execPath,[fileURLToPath(entry)],{stdio:'inherit',detached:true,
    env:{...process.env,SEARCH_WORKER:'1',SEARCH_OWNED_CONTAINER:container,SEARCH_OWNED_VOLUME:volume}});
  const stop = (code: number) => {
    interrupted = code;
    // Kill the worker and its Docker CLI descendants before removing resources.
    if (!workerClosed && child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch { /* already exited */ } }
    if (terminal) {
      discard();
      record();
      process.exitCode = interrupted;
    }
  };
  const sigint = () => stop(130), sigterm = () => stop(143);
  process.on('SIGINT',sigint); process.on('SIGTERM',sigterm);
  let code = await new Promise<number>(resolve=>{
    child.on('error',()=>resolve(1));
    child.on('close',status=>resolve(status ?? 1));
  });
  workerClosed = true;
  let cleanupVerified = false;
  try { await cleanup(container,volume); cleanupVerified=true; }
  catch (error) { console.error(String(error)); code=1; }
  const record = () => writeFileSync(`${out}/run-status.json`,JSON.stringify({manifestHash,
    ...(existsSync(`${out}/image.json`) ? {image:JSON.parse(readFileSync(`${out}/image.json`,'utf8'))} : {}),
    valid:code===0 && !interrupted && cleanupVerified,cleanupVerified,exitCode:interrupted || code})+'\n');
  const discard = () => {
    rmSync(`${out}/finished.json`,{force:true});
    rmSync(`${out}/summary.json`,{force:true});
  };
  const checkpoint = async () => {
    // Poll for signals queued during synchronous reads, writes or finalization.
    await new Promise<void>(resolve=>setTimeout(resolve,0));
    if (interrupted) throw new Error('Run interrupted');
  };
  try {
    await checkpoint();
    if (code===0 && !interrupted && finalize) {
      const completion = JSON.parse(readFileSync(`${out}/completed.json`,'utf8'));
      if (completion.manifestHash!==manifestHash) throw new Error('Completion manifest hash mismatch');
      await checkpoint();
      record();
      await checkpoint();
      writeFileSync(`${out}/finished.json`,JSON.stringify(completion)+'\n');
      await checkpoint();
      finalize();
      await checkpoint();
    }
    record();
    await checkpoint();
  } catch {
    console.error('Could not finalize run'); code=1;
    discard();
    record();
  }
  terminal = true;
  process.exitCode = interrupted || code;
  // Leave handlers installed and let Node drain queued signals before natural exit.
  process.once('beforeExit',()=>{ setTimeout(()=>{},0); });
  return false;
}
