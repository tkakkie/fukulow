import { lstatSync, readdirSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { checked, type Executor } from './dms-formal-exec.ts';
import { cpus, hostname, platform, release, totalmem, arch } from 'node:os';

export type LoadScale = ReturnType<typeof scaledLoad>;
export function scaledLoad(factor='1/1') {
  const match=/^([1-9]\d*)\/([1-9]\d*)$/.exec(factor);
  if(!match)throw new Error('LOAD_SCALE must be a positive rational numerator/denominator');
  let n=Number(match[1]),d=Number(match[2]);
  if(!Number.isSafeInteger(n)||!Number.isSafeInteger(d)||n>d)throw new Error('LOAD_SCALE must be <=1');
  const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
  const divisor=gcd(n,d);n/=divisor;d/=divisor;
  // Multiples of twenty preserve 10% Guests, half watching / half quiet,
  // the 0/50 held mix, four ordinary lanes and even sender/peer pairs.
  if((1000n*BigInt(n))%(20n*BigInt(d))!==0n||(200n*BigInt(n))%(2n*BigInt(d))!==0n)throw new Error('LOAD_SCALE must preserve even senders and sockets divisible by twenty');
  return {factor:`${n}/${d}`,numerator:n,denominator:d,organizations:10,socketsPerOrganization:1000*n/d,sockets:10000*n/d,sendersPerOrganization:200*n/d,sendsPerOrganization:200*n/d,sends:2000*n/d,opensPerOrganization:2*n/d,opens:20*n/d,resolvePerOrganization:n/d,createPerOrganization:n/d/2,renewPerOrganization:n/d/2,browsing:100*n/d,first:50*n/d,deep:50*n/d};
}
export const localLimits={appCpu:2,appMemory:'2g',dbCpu:2,dbMemory:'4g',generatorCpu:1,generatorMemory:'1g'};
export type LocalLimits=typeof localLimits;
export const localIdentity=()=>({machine:hostname(),kernel:`${platform()} ${release()} ${arch()}`,cpu:cpus().map(c=>c.model),memory:totalmem()});
// GNU du -sb reports apparent bytes, counts directory/symlink inodes, and counts
// a hard-linked inode only once. No traversal through symbolic links.
export function apparentBytes(path:string,seen=new Set<string>()):number {
  const stat=lstatSync(path),key=`${stat.dev}:${stat.ino}`;
  if(seen.has(key))return 0;seen.add(key);
  return stat.size+(stat.isDirectory()?readdirSync(path).reduce((n,name)=>n+apparentBytes(path+'/'+name,seen),0):0);
}

export async function localCopy(exec:Executor,source:string,destination:string,timeout:number,signal?:AbortSignal,log?:string) {
  await checked(exec,{program:'cp',args:['-pR',source,destination],timeout,signal,log});
}

export async function sha256File(path:string) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');
}

if(process.argv[1]===import.meta.filename) {
  if(process.argv[2]!=='size')throw new Error('Unknown portable operation');
  console.log(apparentBytes(process.argv[3]!));
}
