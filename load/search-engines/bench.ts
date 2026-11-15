import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

export const command = (file: string, args: string[], input?: string, env = process.env) => execFileSync(file,args,{
  input, env, encoding:'utf8', maxBuffer:256*1024*1024, stdio:['pipe','pipe','pipe'],
}).replace(/[\r\n]+$/,'');

export const docker = (...args: string[]) => command('docker',args);
export const sql = (container: string, db: string, text: string, role = 'fukulow') =>
  command('docker',['exec','-i',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U',role,'-d',db],text);
export const save = (path: string, value: unknown) => writeFileSync(path,JSON.stringify(value,null,2)+'\n');
export const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
};

export async function benchmark(container: string, db: string, script: string, dest: string, transactions: number, clients = 5) {
  writeFileSync(`${dest}.sql`,script);
  docker('cp',`${dest}.sql`,`${container}:/tmp/bench.sql`);
  const name = `${dest.split('/').at(-1)}-${createHash('sha256').update(dest).digest('hex').slice(0,12)}`;
  docker('exec',container,'mkdir','-p',`/tmp/${name}`);
  const prefix = `/tmp/${name}/log`;
  const args = ['exec',container,'pgbench','-n','-U','fukulow_app','-d',db,'-c',String(clients),'-j',String(clients),
    '-t',String(transactions),'-M','prepared','-l','--log-prefix',prefix,'-f','/tmp/bench.sql'];
  const start = performance.now();
  const output = await new Promise<string>((resolve,reject)=>{
    const child = spawn('docker',args); let result = '';
    child.stdout.on('data',b=>{result+=String(b);});child.stderr.on('data',b=>{result+=String(b);});
    child.on('error',reject); child.on('exit',code=>code===0 ? resolve(result) : reject(new Error(result)));
  });
  writeFileSync(`${dest}.txt`,output);
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
