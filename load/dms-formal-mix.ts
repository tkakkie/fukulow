import { stepDmList, type DmListState } from '../web/src/dm-list.ts';
export const retainedAssignment=(index:number)=>[0,50,200][index%3]!;
export function demandFormalMix(state:DmListState,peer:string):DmListState {
  // Repeated independent browse/recovery traversals; exhausted traversals start
  // again, while unfinished immutable continuations retain their own progress.
  if(state.lanes.browse.done)state={...state,lanes:{...state.lanes,browse:{...state.lanes.browse,done:false,cursor:undefined}}};
  state=stepDmList(state,{type:'browse'}).state;
  if(state.lanes.recovery.done)state={...state,recoveryPeer:undefined};
  return stepDmList(state,{type:'recover',peer}).state;
}

// Cohorts measure cardinality, not frozen identities. Keep the protocol's newest
// retained rows after normal eviction; smaller cohorts use the same LRU order.
export function retainFormalCohort(state:DmListState,retained:number):DmListState {
  const rows=[...state.rows].sort((a,b)=>b.used-a.used).slice(0,retained);
  if(rows.length!==retained)throw new Error('Insufficient authorized retained rows');
  return {...state,rows};
}
export function assertFormalCohort(state:DmListState,retained:number):void {
  if(state.rows.length!==retained || new Set(state.rows.map(row=>row.identity.id)).size!==retained)throw new Error('Retained cohort changed');
}
