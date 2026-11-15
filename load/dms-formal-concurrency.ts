import { retainedAssignment } from './dms-formal-mix.ts';
import type { MixedScenario } from './dms-formal-scenarios.ts';

export const offeredBucketMs = 60000;
export type OfferedRound = { member: number; retained: number; at: number; lanes: string[] };
export type OfferedBucket = { from: number; to: number; offered: Record<string, number>; rounds: OfferedRound[] };
type Summary = { offeredWork?: { bucketMs: number; coverage: number; buckets: OfferedBucket[] }; fullIntervals: {start:number;end:number}[] };

// Missing historical evidence never establishes a concurrent-load PASS.
export function concurrentBrowsingReasons(core:{from:number;to:number}, organizations:Summary[], browser:Summary, scenario:MixedScenario):string[] {
  const reasons:string[]=[];
  const enough=(actual:number|undefined,expected:number)=>Number.isSafeInteger(actual) && actual! >= Math.ceil(expected*.99);
  const mixMatches=(actual:number|undefined,expected:number)=>enough(actual,expected) && actual!<=Math.floor(expected*1.01);
  const buckets=(summary:Summary,label:string)=>{
    const work=summary.offeredWork;
    const count=Math.ceil((core.to-core.from)/offeredBucketMs);
    if(!work || !Array.isArray(work.buckets) || work.bucketMs!==offeredBucketMs || work.coverage!==.99 || work.buckets.length!==count || work.buckets.some((b,i)=>!b || !b.offered || b.from!==core.from+i*offeredBucketMs || b.to!==Math.min(core.to,b.from+offeredBucketMs))) {
      reasons.push(label+': missing/malformed time-resolved offered-work and O5 cadence evidence');return [];
    }
    return work.buckets;
  };
  if(organizations.length!==10)reasons.push('Missing ten mixed-load Organizations');
  organizations.forEach((org,index)=>{
    const label='Organization '+index, work=buckets(org,label);
    const previous=new Map<number,number>();
    for(const b of work) {
      const seconds=(b.to-b.from)/1000, prefix=label+' bucket '+b.from;
      if(!org.fullIntervals?.some(i=>i.start<=b.from && i.end>=b.to))reasons.push(prefix+': missing 1,000 concurrent connections');
      for(const [kind,rate] of Object.entries({send:200,resolve:1,create:.5,renew:.5}))if(!(kind==='send'?enough:mixMatches)(b.offered[kind],rate*seconds))reasons.push(prefix+': offered '+kind+' outside adopted rate/mix tolerance');
      if(!Array.isArray(b.rounds)) {reasons.push(prefix+': missing O5 cadence evidence');continue;}
      if(!enough(b.rounds.length,1000*seconds/30))reasons.push(prefix+': sparse O5 rounds below 99% of 30-second schedule');
      const byMember=new Map<number,OfferedRound[]>();
      for(const r of b.rounds) {if(!byMember.has(r.member))byMember.set(r.member,[]);byMember.get(r.member)!.push(r);}
      for(let member=0;member<1000;member++) {
        const held=retainedAssignment(member,scenario);
        const rounds=(byMember.get(member) ?? []).sort((a,c)=>a.at-c.at);
        // 30 s +/-3 s jitter can move a nominal start across a bucket edge.
        // Individual maximum gaps, not a two-start cardinality, prove cadence.
        const starts=rounds.map(r=>r.at);
        if(!starts.length || starts.some((at,i)=>!Number.isFinite(at) || at<b.from || at>=b.to || (i>0 && at-starts[i-1]!>33000)) || starts[0]!-b.from>33000 || b.to-starts.at(-1)!>33000 || rounds.some(r=>r.lanes?.length!==5 || r.retained!==held || !['delta','coverage','browse','recovery',...(held?['held']:[])].every(lane=>r.lanes?.includes(lane)))) {
          reasons.push(prefix+': Member '+member+' missing O5 cadence or adopted lanes');break;
        }
        const last=previous.get(member);
        if(last!==undefined && starts[0]!-last>33000) {reasons.push(prefix+': Member '+member+' O5 gap exceeds 33 seconds');break;}
        previous.set(member,starts.at(-1)!);
      }
    }
  });
  for(const b of buckets(browser,'Browsing Organization'))for(const kind of ['first','deep'])if(!mixMatches(b.offered[kind],50*(b.to-b.from)/1000))reasons.push('Browsing bucket '+b.from+': offered '+kind+' outside 99–101% of 50 reads/s (100/s half first/half deep)');
  return reasons;
}
