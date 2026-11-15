import { regularPairs } from './dms-workload.ts';

export const requiredScenarios = ['main', 'held200'] as const;
export type MixedScenario = typeof requiredScenarios[number];
export const deferredNames = ['ten-sockets-per-Member','single-Organization-10000','scale-and-cold-cache','history-and-Mention-shapes','hot-DM','fault-and-backlog-recovery','storage-1M-10M','backup-restore','pre-DM-regression','pool-overhead'] as const;
export type Scenario = MixedScenario | typeof deferredNames[number];
export const isMixedScenario = (scenario: Scenario): scenario is MixedScenario => requiredScenarios.some(name=>name===scenario);
export function fixturePairs(scenario: MixedScenario) {
  const historical = regularPairs(1000,100);
  const existing = new Set(historical.map(([a,b])=>a+':'+b));
  const supplemental = scenario==='held200' ? regularPairs(1000,300).filter(([a,b])=>!existing.has(a+':'+b)) : [];
  return {historical,supplemental};
}
export const heldCohorts = (scenario: MixedScenario) => scenario==='held200' ? [0,50,200] : [0,50];
export const mixedLoad = {organizations:10,socketsPerOrganization:1000,sendsPerOrganization:200,rampSeconds:300,warmSeconds:300,measuredSeconds:1800,extensionSeconds:240};
// Ring distance stays above 150, outside both historical and supplemental pairs.
export function formalCreatePair(ordinal:number):[number,number] {
  if(!Number.isSafeInteger(ordinal) || ordinal<0 || ordinal>=40000)throw new Error('Formal create pool exhausted');
  return [500+ordinal%400,100+Math.floor(ordinal/400)];
}

export function scenarioAcceptance(attempts: {scenario:Scenario;acceptance:boolean;mode:'formal'|'smoke';attempt:number}[], deferred: {scenario:string;status:string}[]) {
  return requiredScenarios.every(scenario=>{
    const runs=attempts.filter(row=>row.scenario===scenario);
    return runs.length>=3 && runs.every((row,index)=>row.mode==='formal' && row.acceptance && row.attempt===index+1);
  }) && deferredNames.every(scenario=>deferred.some(row=>row.scenario===scenario && row.status==='PASS'));
}
