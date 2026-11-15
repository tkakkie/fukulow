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
