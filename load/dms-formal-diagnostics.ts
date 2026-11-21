import { execFile } from 'node:child_process';
import { writeSync } from 'node:fs';
import { promisify } from 'node:util';
import { CommandFailure } from './dms-formal-exec.ts';
import { availableBytes, HeadroomError } from './dms-formal-storage.ts';

export type DiagnosticWriter = (line:string)=>void;
export const workerLog:DiagnosticWriter = line=>{writeSync(2,line);};
export function writeDiagnostic(write:DiagnosticWriter,record:object) {
  try {write(JSON.stringify(record)+'\n');} catch { /* Evidence is best effort. */ }
}

export function failureDetails(error:unknown) {
  // Never serialize exceptions, paths, subprocess output or state values. Even
  // parser and system errors can quote input or an unlabelled credential.
  if(error instanceof HeadroomError) return {
    exitCode:null,errorClass:'HeadroomError',message:'Storage headroom insufficient',
    requiredBytes:error.requiredBytes,observedBytes:error.observedBytes,
  };
  if(error instanceof CommandFailure) return {
    exitCode:error.exitCode,errorClass:'CommandFailure',message:error.diagnosticMessage,
  };
  if(error instanceof SyntaxError) return {exitCode:null,errorClass:'SyntaxError',message:'Could not parse input'};
  if(error instanceof TypeError) return {exitCode:null,errorClass:'TypeError',message:'Unexpected value or operation'};
  if(error instanceof RangeError) return {exitCode:null,errorClass:'RangeError',message:'Value outside the supported range'};
  return {exitCode:null,errorClass:error instanceof Error?'Error':'UnknownError',message:'Unexpected worker failure [detail redacted]'};
}

const exec = promisify(execFile);
export type ProbeDocker = (args:string[],signal:AbortSignal)=>Promise<string>;
const probeDocker:ProbeDocker = async (args,signal)=>
  // Unlike a measurement command timeout, a diagnostic timeout must only kill its CLI.
  (await exec('docker',args,{signal,killSignal:'SIGKILL',maxBuffer:8192})).stdout;

function statAvailableBytes(line:string|undefined) {
  const fields=/^(\d+) (\d+)$/.exec(line ?? '');
  const value=Number(fields?.[1])*Number(fields?.[2]);
  return Number.isSafeInteger(value)&&value>=0?value:null;
}

export async function restoreSpace(root:string,id:string,image:string,attempt:number,probe=probeDocker) {
  let hostFreeBytes:number|null=null, dataFreeBytes:number|null=null, snapshotFreeBytes:number|null=null;
  try {hostFreeBytes=availableBytes(root);} catch { /* Report an unavailable sample. */ }
  const data=id+'-data',snapshot=id+'-snapshot';
  try {
    const signal=AbortSignal.timeout(5000);
    // Check existence first so the probe does not create a missing named volume.
    await probe(['volume','inspect','--format','{{.Name}}',data,snapshot],signal);
    const output=await probe(['run','--rm','--pull=never','--network','none','--read-only',
      '--label',`dm-formal=${id}`,
      '--mount',`type=volume,src=${data},dst=/var/lib/postgresql,readonly,volume-nocopy`,
      '--mount',`type=volume,src=${snapshot},dst=/snapshot,readonly,volume-nocopy`,
      '--entrypoint','stat',image,'-f','-c','%a %S','/var/lib/postgresql','/snapshot'],signal);
    const [dataStat,snapshotStat]=output.trimEnd().split('\n');
    dataFreeBytes=statAvailableBytes(dataStat);
    snapshotFreeBytes=statAvailableBytes(snapshotStat);
  } catch { /* An unavailable sample has no bearing on restore. */ }
  return {event:'restore-space',step:'restore',attempt,hostFreeBytes,dataFreeBytes,snapshotFreeBytes};
}
