// One-sprint build-time rollback; removed by #467.
import { initialState, step } from './protocol'
import type { State, SyncCore, SyncView } from './protocol-types'
export const initCore = async () => {}
function viewOf({ requests: _requests, timers: _timers, ...view }: State): SyncView { return view }
export function createCore(selfId: string): SyncCore {
  let state = initialState(selfId), view = viewOf(state)
  return {
    get: () => view,
    request: id => state.requests[id],
    timer: id => state.timers[id],
    hasPending: () => Object.values(state.channels).some(c => c.pending.length > 0),
    step(input) {
      const previous = state
      const result = step(state, input)
      state = result.state
      const stateChanged = state !== previous
      if (stateChanged) view = viewOf(state)
      return { effects: result.effects, changedChannels: result.changedChannels, records: result.records, stateChanged }
    },
  }
}

export { createReplyCountCore } from './reply-count-core-ts'
