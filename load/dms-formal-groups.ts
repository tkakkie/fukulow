import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// The launching shell/timeout supplies the group before the worker starts.
export function currentGroup():number {
  const group=Number(process.env.DM_FORMAL_OWNED_GROUP);
  if(!Number.isSafeInteger(group)||group<=1)throw new Error('Missing owned process group');
  return group;
}
function groupExists(group:number):boolean {
  try {process.kill(-group,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}
}
export async function stopGroups(groups:number[]):Promise<void> {
  const owned=new Set(groups);
  if(process.env.DM_FORMAL_OWNED_GROUP && owned.has(Number(process.env.DM_FORMAL_OWNED_GROUP)))throw new Error('Refusing to clean own process group');
  for(const group of owned) {
    if(!Number.isSafeInteger(group)||group<=1)throw new Error('Invalid owned process group');
    try {process.kill(-group,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  }
  // Require the complete group to disappear (including unreaped children).
  // Failure prevents retention/retry rather than reporting cleanup success.
  const deadline=Date.now()+5000;
  while([...owned].some(groupExists)) {
    if(Date.now()>=deadline)throw new Error('Owned processes remain after cleanup');
    await delay(20);
  }
}

export async function stopRecordedGroups(root:string):Promise<void> {
  const own=Number(process.env.DM_FORMAL_OWNED_GROUP);
  const files=readdirSync(root).filter(file=>/^worker-\d+\.pid$/.test(file));
  const groups=files.map(file=>Number(readFileSync(`${root}/${file}`,'utf8'))).filter(group=>group!==own);
  await stopGroups(groups);
  for(const file of files)if(Number(readFileSync(`${root}/${file}`,'utf8'))!==own)rmSync(`${root}/${file}`,{force:true});
}
