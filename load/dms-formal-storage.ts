import { statfsSync, readdirSync, lstatSync } from 'node:fs';
export const GiB=1024**3;
export const summaryLimit=32*1024**2;
export function requireHeadroom(path:string,bytes:number) {
  const stat=statfsSync(path);
  if(stat.bavail*stat.bsize<bytes)throw new Error('Storage headroom insufficient at '+path);
}
export function directoryBytes(path:string):number {
  return readdirSync(path).reduce((total,name)=>{const child=path+'/'+name,stat=lstatSync(child);return total+(stat.isDirectory()?directoryBytes(child):stat.isFile()?stat.size:0);},0);
}
