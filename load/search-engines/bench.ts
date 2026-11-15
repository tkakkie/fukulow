import { timeouts, appStatementTimeoutMs } from './runtime.ts';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

export const command = (file: string, args: string[], input?: string, env = process.env) => {
  const timeout = args[0]==='build' ? timeouts.build : args.includes('psql') ? timeouts.psql : timeouts.docker;
  return boundedCommand(file,args,timeout,input,env);
};
export class CommandTimeoutError extends Error {}
export class SqlStatementTimeoutError extends Error {}
const statementTimedOut = (output: string) => /ERROR:\s*57014:|canceling statement due to statement timeout/.test(output);
export const appSessionArguments = ['-e',`PGOPTIONS=-c statement_timeout=${appStatementTimeoutMs}`];
export function boundedCommand(file: string,args: string[],timeout: number,input?: string,env=process.env) {
  try {
    return execFileSync(file,args,{
      timeout, killSignal:'SIGKILL', input, env, encoding:'utf8', maxBuffer:256*1024*1024, stdio:['pipe','pipe','pipe'],
    }).replace(/[\r\n]+$/,'');
  } catch (error) {
    const timedOut = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    if (args.includes('psql') && statementTimedOut(String((error as {stderr?:unknown}).stderr)))
      throw new SqlStatementTimeoutError('SQL statement_timeout (SQLSTATE 57014); entire run invalid');
    const message = `${file} ${args.includes('psql') ? 'psql' : args[0] ?? ''} ${timedOut ? 'timed out' : 'failed'} (${timeout} ms limit)`;
    throw timedOut ? new CommandTimeoutError(message) : new Error(message);
  }
};

export const docker = (...args: string[]) => command('docker',args);
// Owner setup/seed/index sessions keep no timeout, as migrations do; only
// app-role psql/pgbench sessions get the production 10s limit.
export const sql = (container: string, db: string, text: string, role = 'fukulow') =>
  command('docker',['exec','-i',...(role==='fukulow_app'?appSessionArguments:[]),container,'psql','-XqAt','-v','VERBOSITY=verbose','-v','ON_ERROR_STOP=1','-U',role,'-d',db],text);
export const save = (path: string, value: unknown) => writeFileSync(path,JSON.stringify(value,null,2)+'\n');
export const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
};

export async function benchmark(container: string, db: string, script: string, dest: string, transactions: number, clients = 5) {
  // Verify the effective setting in every pgbench session/transaction. The
  // guard is included in timing; a mismatch raises division_by_zero and fails.
  const guarded = `SELECT 1 / (current_setting('statement_timeout')::interval = interval '10 seconds')::int;\n${script}`;
  writeFileSync(`${dest}.sql`,guarded);
  docker('cp',`${dest}.sql`,`${container}:/tmp/bench.sql`);
  const name = `${dest.split('/').at(-1)}-${createHash('sha256').update(dest).digest('hex').slice(0,12)}`;
  docker('exec',container,'mkdir','-p',`/tmp/${name}`);
  const prefix = `/tmp/${name}/log`;
  const args = ['exec',...appSessionArguments,container,'pgbench','-n','-U','fukulow_app','-d',db,'-c',String(clients),'-j',String(clients),
    '-t',String(transactions),'-M','prepared','-l','--log-prefix',prefix,'-f','/tmp/bench.sql'];
  const start = performance.now();
  const output = await new Promise<string>((resolve,reject)=>{
    const child = spawn('docker',args); let result = '';
    const timer = setTimeout(()=>{ child.kill('SIGKILL'); reject(new Error('docker pgbench timed out')); },timeouts.benchmark);
    child.stdout.on('data',b=>{result+=String(b);});child.stderr.on('data',b=>{result+=String(b);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      writeFileSync(`${dest}.txt`,result);
      if (statementTimedOut(result)) reject(new SqlStatementTimeoutError('SQL statement_timeout (SQLSTATE 57014); entire run invalid'));
      else if (code!==0 || /number of failed transactions:\s+[1-9]/.test(result)) reject(new Error('docker pgbench failed; entire run invalid'));
      else resolve(result);
    });
  });
  const wallMs = performance.now()-start;
  docker('cp',`${container}:/tmp/${name}`,dest);
  const samples: number[] = [];
  for (const file of readdirSync(dest)) for (const row of readFileSync(`${dest}/${file}`,'utf8').trim().split('\n')) {
    const fields = row.trim().split(/\s+/); const us = Number(fields[2]);
    if (Number.isFinite(us)) samples.push(us/1000);
  }
  if (samples.length !== transactions*clients || /number of failed transactions:\s+[1-9]/.test(output)) throw new Error(`Invalid benchmark ${dest}: ${output}`);
  return { n:samples.length,p50:percentile(samples,.5),p95:percentile(samples,.95),p99:percentile(samples,.99),
    tps:Number(output.match(/tps = ([\d.]+)/)?.[1]),wallMs };
}
