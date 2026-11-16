import execution from 'k6/execution';
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import type { Options } from 'k6/options';
import type { SendMessageRequest, SignInRequest } from '../web/src/api-schema.d.ts';
import { uuid } from './seed.ts';
import { plan, settings, scope, timeoutNote, type Counts } from './pool-before-after-summary.ts';
const fixture=JSON.parse(open('/fixture/data.json')) as {organization:string;otherOrganization:string;reader:string;channels:string[];password:string};
const tokens=new SharedArray<string>('members',()=>JSON.parse(open('/fixture/tokens.json')));
const steps=plan(__ENV.POOL_SMOKE==='1');
const mixed=__ENV.POOL_SCENARIO==='mixed';
const countNames=['attempted','accepted','rejected429','rejected503','otherErrors','clientTimeouts','transportErrors'] as const;
const counts=Object.fromEntries(countNames.map(n=>[n,new Counter(`pool_${n}`)]));
const latency=new Trend('pool_success_ms',true);
const lanes=steps.flatMap(step=>[
  {name:`${step.name}_send`,rate:step.rate,seconds:step.seconds,start:step.startSeconds,exec:'send'},
  ...(mixed?[
    {name:`${step.name}_reads`,rate:settings.readRate,seconds:step.seconds,start:step.startSeconds,exec:'reads'},
    {name:`${step.name}_signin`,rate:settings.signinRate,seconds:step.seconds,start:step.startSeconds,exec:'signin'},
  ]:[]),
]);
const duration=steps.at(-1)!.startSeconds+steps.at(-1)!.seconds+11;
lanes.push({name:'reader',rate:2,seconds:duration,start:0,exec:'reader'});
export const options:Options={
  scenarios:Object.fromEntries(lanes.map(l=>[l.name,{executor:'constant-arrival-rate',rate:l.rate,timeUnit:'1s',duration:`${l.seconds}s`,
    startTime:`${l.start}s`,exec:l.exec,preAllocatedVUs:l.exec==='send'?100:l.exec==='reads'?50:10,
    maxVUs:l.exec==='send'?2000:l.exec==='reads'?1000:100,gracefulStop:'11s'}])),
  summaryTrendStats:['p(95)','p(99)'],systemTags:['scenario','status','name'],
  thresholds:Object.fromEntries(lanes.flatMap(l=>[...countNames.map(n=>[`pool_${n}{scenario:${l.name}}`,['count>=0']]),
    [`dropped_iterations{scenario:${l.name}}`,['count>=0']], [`pool_success_ms{scenario:${l.name}}`,['max>=0']]])),
};
for(const kind of ['send','reads','signin']) for(const [metric,threshold] of [...countNames.map(n=>[`pool_${n}`,'count>=0']),['pool_success_ms','max>=0']])
  options.thresholds![`${metric}{scenario:run_${kind}}`]=[threshold];
const base=__ENV.BASE_URL;
function request(kind:'send'|'reads'|'signin'|'reader') {
  const index=execution.scenario.iterationInTest;
  if(kind==='reader' && index===0) console.log('POOL_START '+execution.scenario.startTime);
  const token=kind==='reader'?fixture.reader:tokens[index%tokens.length];
  const org=kind==='reader'?fixture.otherOrganization:fixture.organization;
  const headers:Record<string,string>={'Content-Type':'application/json',Authorization:`Bearer ${token}`};
  const ip=index%10000;
  headers['X-Load-Client-IP']=`10.${(ip>>>16)&255}.${(ip>>>8)&255}.${ip&255}`;
  const body:SendMessageRequest|SignInRequest=kind==='signin'?{email:`member-${index%4000}@example.invalid`,password:fixture.password}:
    {client_message_id:uuid(),body:'Load test message'};
  const start=Date.now();
  const path=kind==='signin'?'/api/v1/native/session':`/api/v1/orgs/${org}/channels`+(kind==='send'?`/${fixture.channels[index%fixture.channels.length]}/messages`:'');
  counts.attempted.add(1);
  const r=http.request(kind==='send'||kind==='signin'?'POST':'GET',base+path,kind==='send'||kind==='signin'?JSON.stringify(body):null,
    {headers,timeout:'10s',redirects:0,tags:{name:kind}});
  const outcome=r.error_code===1050?'clientTimeouts':r.status>=200&&r.status<300?'accepted':r.status===429?'rejected429':r.status===503?'rejected503':
    r.status===0?(r.error_code===1050?'clientTimeouts':'transportErrors'):'otherErrors';
  for(const name of countNames.filter(n=>n!=='attempted')) counts[name].add(Number(outcome===name));
  if(outcome==='accepted') latency.add(r.timings.duration);
  if(kind!=='reader') {
    const tags={scenario:`run_${kind}`};
    counts.attempted.add(1,tags);
    for(const name of countNames.filter(n=>n!=='attempted')) counts[name].add(Number(outcome===name),tags);
    if(outcome==='accepted') latency.add(r.timings.duration,tags);
  }
  // Split the continuous other-Organization reader by request start, including drain gaps.
  if(kind==='reader') {
    const elapsed=start-execution.scenario.startTime;
    const step=steps.find(s=>elapsed>=s.startSeconds*1000&&elapsed<(s.startSeconds+s.seconds)*1000);
    if(step) {
      const tags={scenario:`${step.name}_reader`};
      counts.attempted.add(1,tags);
      for(const name of countNames.filter(n=>n!=='attempted')) counts[name].add(Number(outcome===name),tags);
      if(outcome==='accepted') latency.add(r.timings.duration,tags);
    }
  }
}
export function send(){request('send');}
export function reads(){request('reads');}
export function signin(){request('signin');}
export function reader(){request('reader');}
// Force per-step reader submetrics too; missing metric values remain missing evidence.
for(const step of steps) for(const [metric,threshold] of [...countNames.map(n=>[`pool_${n}`,'count>=0']),['pool_success_ms','max>=0']])
  options.thresholds![`${metric}{scenario:${step.name}_reader}`]=[threshold];
export function handleSummary(data:unknown) {
  const metrics=(data as {metrics:Record<string,{values:Record<string,number>}>}).metrics;
  function row(name:string):Counts {
    const value=(metric:string,stat='count')=>metrics[`${metric}{scenario:${name}}`]?.values[stat];
    const attempted=value('pool_attempted')??-1,accepted=value('pool_accepted')??-1;
    const counters=Object.fromEntries(countNames.map(n=>[n,value(`pool_${n}`)??-1])) as Record<typeof countNames[number],number>;
    return {...counters,attempted,accepted,successRate:attempted>0?accepted/attempted:null,droppedIterations:value('dropped_iterations')??0,
      p95:value('pool_success_ms','p(95)')??null,p99:value('pool_success_ms','p(99)')??null} as Counts;
  }
  const readerTotals=row('reader');
  // Global counters include tagged reader duplicates; aggregate unique scenario rows instead.
  return {stdout:'POOL_RESULT '+JSON.stringify({scope,timeoutNote,steps:steps.map(s=>({...s,send:{...row(`${s.name}_send`),rate:s.rate,seconds:s.seconds},
    reader:{...row(`${s.name}_reader`),droppedIterations:readerTotals.droppedIterations,rate:2,seconds:s.seconds},...(mixed?{reads:{...row(`${s.name}_reads`),rate:500,seconds:s.seconds},signin:{...row(`${s.name}_signin`),rate:20,seconds:s.seconds}}:{})})),
    continuousReaderComplete:readerTotals.droppedIterations===0&&readerTotals.attempted>=2*duration*settings.minimumOfferedFraction,
    runMetrics:Object.fromEntries(['send',...(mixed?['reads','signin']:[]),'reader'].map(kind=>[kind,kind==='reader'?readerTotals:{...row(`run_${kind}`),
      droppedIterations:steps.reduce((sum,s)=>sum+row(`${s.name}_${kind}`).droppedIterations,0)}])),
    lanes:lanes.map(l=>({...l,...row(l.name)})),poolAcquireTimeouts:'NOT EVALUATED'})+'\n'};
}
