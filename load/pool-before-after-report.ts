import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { judgeAll, scenarios, scope, timeoutNote, pairs, type Run } from './pool-before-after-summary.ts';
const dir=resolve(process.argv[2]??'');
if(!process.argv[2])throw new Error('Usage: node load/pool-before-after-report.ts /external/comparison-directory');
const runs:Run[]=[];
const missing:string[]=[];
for(const scenario of scenarios) for(const [i,arms] of pairs().entries()) for(const arm of arms) {
  const path=`${dir}/${scenario}-${i+1}-${arm}/results.json`;
  if(!existsSync(path)){missing.push(path);continue;}
  const run=JSON.parse(readFileSync(path,'utf8')) as Run;
  if(run.arm!==arm||run.pair!==i+1||run.scenario!==scenario){missing.push(`mismatched identity: ${path}`);continue;}
  runs.push(run);
}
// The runner's own record decides completeness: interrupted, failed, smoke, rehearsal or uncleaned runs never yield a verdict.
const summaryPath=`${dir}/summary.json`;
const summary=existsSync(summaryPath)?JSON.parse(readFileSync(summaryPath,'utf8')) as {complete?:unknown;smoke?:unknown;rehearsal?:unknown;cleanupErrors?:unknown}:undefined;
if(!summary)missing.push(summaryPath);
const complete=summary?.complete===true&&summary.smoke===false&&(summary.rehearsal===false||summary.rehearsal===undefined)&&Array.isArray(summary.cleanupErrors)&&summary.cleanupErrors.length===0&&missing.length===0;
const report={scope,timeoutNote,poolAcquireTimeouts:'NOT EVALUATED',complete,missing,judgement:judgeAll(runs,complete)};
writeFileSync(`${dir}/judgement.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
