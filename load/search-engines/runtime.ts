// Keep signal handling outside the synchronous SQL worker, including hung clients.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const timeouts = { docker:120_000, build:900_000, psql:900_000, benchmark:900_000, cleanup:10_000 };
export const ownedContainer = () => process.env.SEARCH_OWNED_CONTAINER ?? '';
export const ownedVolume = () => process.env.SEARCH_OWNED_VOLUME ?? '';

export function cleanup(container: string, volume: string, timeout = timeouts.cleanup) {
  const failures: string[] = [];
  const call = (args: string[], absent = false) => {
    const r = spawnSync('docker',args,{encoding:'utf8',timeout,killSignal:'SIGKILL'});
    if (r.error || (r.status!==0 && !(absent && /No such (container|volume)/i.test(r.stderr)))) {
      failures.push(`docker ${args[0]} cleanup failed or timed out`);
    }
    return r;
  };
  call(['rm','-fv',container],true);
  call(['volume','rm','-f',volume],true);
  for (const [kind,name] of [['container',container],['volume',volume]]) {
    const r = call([kind,'ls','-q','--filter',`name=${name}`]);
    if (r.stdout?.trim()) failures.push(`${kind} cleanup verification found an owned resource`);
  }
  if (failures.length) throw new Error(failures.join('; '));
}

export async function supervise(entry: string, out: string) {
  if (process.env.SEARCH_WORKER === '1') return;
  const token = randomUUID();
  const container = `fukulow-search-153-${token}`;
  const volume = `${container}-data`;
  let interrupted = 0;
  const child = spawn(process.execPath,[fileURLToPath(entry)],{stdio:'inherit',detached:true,
    env:{...process.env,SEARCH_WORKER:'1',SEARCH_OWNED_CONTAINER:container,SEARCH_OWNED_VOLUME:volume}});
  const stop = (code: number) => {
    interrupted = code;
    // Kill the worker and its Docker CLI descendants before removing resources.
    if (child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch { /* already exited */ } }
  };
  const sigint = () => stop(130), sigterm = () => stop(143);
  process.on('SIGINT',sigint); process.on('SIGTERM',sigterm);
  let code = await new Promise<number>(resolve=>{
    child.on('error',()=>resolve(1));
    child.on('close',status=>resolve(status ?? 1));
  });
  let cleanupVerified = false;
  try { cleanup(container,volume); cleanupVerified=true; }
  catch (error) { console.error(String(error)); code=1; }
  try { writeFileSync(`${out}/run-status.json`,JSON.stringify({valid:code===0 && !interrupted && cleanupVerified,cleanupVerified,exitCode:interrupted || code})+'\n'); }
  catch { console.error('Could not record run validity'); code=1; }
  process.removeListener('SIGINT',sigint); process.removeListener('SIGTERM',sigterm);
  process.exit(interrupted || code);
}
