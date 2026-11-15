import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dmListState, stepDmList } from '../web/src/dm-list.ts';
import { demandFormalMix, retainFormalCohort, assertFormalCohort } from './dms-formal-mix.ts';
const dm=(id:string)=>({id,kind:'dm' as const,peer:{id:'peer-'+id,name:'Peer',active:true},capabilities:{can_add_members:{allowed:false},can_remove_members:{allowed:false},can_manage_managers:{allowed:false},can_leave:{allowed:false}},as_of_seq:0,read_seq:0,unread_count:0,main_unread_count:0,mention_unread_count:0});
for(const retained of [0,50,200])test(`successful multi-page discovery and concurrent creates preserve ${retained}-row samples across repeated O5 runs`,()=>{
  let state=dmListState(),serial=0;
  state.rows=Array.from({length:retained},()=>({identity:dm(String(++serial)),access:++state.serial,used:++state.clock}));
  const cursors=new Map<string,string>();const lanes=new Set<string>();
  for(let run=0;run<12;run++) {
    state=stepDmList(state,{type:'demand',boundary:true,periodic:true,replace:[]}).state;
    state=demandFormalMix(state,'absent-peer');
    let used=0;const runLanes=new Set<string>();
    for(;;) {
      // A concurrent create is discovered through successful server responses.
      state=stepDmList(state,{type:'wake',now:run}).state;
      const request=state.request;if(!request)break;
      assertFormalCohort(state,retained);used++;lanes.add(request.lane);runLanes.add(request.lane);
      if(cursors.has(request.lane))assert.equal(request.cursor,cursors.get(request.lane));
      const rows=request.lane==='held'?(request.ids??[]).map(dm):Array.from({length:50},()=>dm(String(++serial)));
      const cursor=`${request.lane}-${run}-${used}`;
      const discovery=request.lane==='delta'||request.lane==='coverage';
      const data=discovery?{dms:rows.map(({id,kind,peer})=>({id,kind,peer})),next_cursor:cursor,caught_up:false}:{dms:rows,next_cursor:cursor};
      state=stepDmList(state,{type:'result',request,data}).state;
      if(request.lane!=='held')cursors.set(request.lane,cursor);
      state=retainFormalCohort(state,retained);assertFormalCohort(state,retained);
      if(retained && request.lane!=='held')assert.ok(state.rows.some(row=>rows.some(dm=>dm.id===row.identity.id)));
    }
    assert.equal(used,5);if(retained)assert.equal(runLanes.size,5);assert.equal(state.request,undefined);
    assert.ok(Object.values(state.lanes).some(lane=>lane.pending),'continuation debt remains distinct from completed attempts');
  }
  for(const lane of ['delta','coverage','browse','recovery',...(retained?['held']:[])])assert.ok(lanes.has(lane));
});

test('main has exactly 100 DMs per Member and no supplemental empty pairs',async()=>{
  const {fixturePairs}=await import('./dms-formal-scenarios.ts');
  const {historical,supplemental}=fixturePairs('main');
  const degrees=Array<number>(1000).fill(0);
  for(const [a,b] of [...historical,...supplemental]){degrees[a]++;degrees[b]++;}
  assert.equal(supplemental.length,0);assert.equal(historical.length*10,500000);
  assert.equal(historical.length*10*100,50000000);
  assert.ok(degrees.every(degree=>degree===100));
  for(const [,peer] of historical.filter(([a,b])=>a<900 && (a^1)!==b).slice(0,10000))degrees[peer]--;
  assert.ok(degrees.every(degree=>degree>=50),'the main fixture supplies its 50-held cohort after prepared grant lapses');
});
test('held200 supplies at least 200 current authorized rows for every held Member under full mixed load',async()=>{
  const {fixturePairs,mixedLoad}=await import('./dms-formal-scenarios.ts');
  const {retainedAssignment}=await import('./dms-formal-mix.ts');
  const {historical,supplemental}=fixturePairs('held200');
  const usable=Array<number>(1000).fill(0);
  for(const [a,b] of [...historical,...supplemental]){usable[a]++;usable[b]++;}
  const renewals=historical.filter(([a,b])=>a<900 && (a^1)!==b).slice(0,10000);
  for(const [,peer] of renewals)usable[peer]--;
  assert.equal(supplemental.length*10,1000000);
  assert.ok(usable.every((count,index)=>count>=retainedAssignment(index,'held200')));
  assert.equal(mixedLoad.organizations*mixedLoad.socketsPerOrganization,10000);
  assert.equal(mixedLoad.organizations*mixedLoad.sendsPerOrganization,2000);
  assert.deepEqual([mixedLoad.rampSeconds,mixedLoad.warmSeconds,mixedLoad.measuredSeconds],[300,300,1800]);
  assert.ok(Array.from({length:1000},(_,i)=>retainedAssignment(i,'main')).every(rows=>rows===0 || rows===50));
  assert.ok(Array.from({length:1000},(_,i)=>retainedAssignment(i,'held200')).includes(200));
});
test('formal creates stay unused and distinct throughout the mixed window in both fixtures',async()=>{
  const {fixturePairs,formalCreatePair,mixedLoad}=await import('./dms-formal-scenarios.ts');
  // Two opens/s, a quarter creates, including warm-up, core and extension.
  const creates=Math.ceil((mixedLoad.warmSeconds+mixedLoad.measuredSeconds+mixedLoad.extensionSeconds)*2/4);
  for(const scenario of ['main','held200'] as const) {
    const {historical,supplemental}=fixturePairs(scenario);
    const used=new Set([...historical,...supplemental].map(([a,b])=>a+':'+b));
    for(let i=0;i<creates;i++) {
      const [a,b]=formalCreatePair(i),key=Math.min(a,b)+':'+Math.max(a,b);
      assert.ok(a<900 && b<900);assert.ok(!used.has(key),`${scenario} create ${i}`);used.add(key);
    }
  }
  assert.throws(()=>formalCreatePair(40000),/exhausted/);
});
