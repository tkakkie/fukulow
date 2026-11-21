import { statfsSync, readdirSync, lstatSync } from 'node:fs';
export const GiB=1024**3;
export const summaryLimit=32*1024**2;
export class HeadroomError extends Error {
  readonly requiredBytes:number;
  readonly observedBytes:number;
  constructor(path:string,requiredBytes:number,observedBytes:number) {
    super('Storage headroom insufficient at '+path);
    this.requiredBytes=requiredBytes;
    this.observedBytes=observedBytes;
  }
}
export function availableBytes(path:string) {
  const stat=statfsSync(path);
  return stat.bavail*stat.bsize;
}
export function requireHeadroom(path:string,bytes:number) {
  const observed=availableBytes(path);
  if(observed<bytes)throw new HeadroomError(path,bytes,observed);
}
export function directoryBytes(path:string):number {
  return readdirSync(path).reduce((total,name)=>{const child=path+'/'+name,stat=lstatSync(child);return total+(stat.isDirectory()?directoryBytes(child):stat.isFile()?stat.size:0);},0);
}
