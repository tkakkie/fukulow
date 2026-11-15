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
