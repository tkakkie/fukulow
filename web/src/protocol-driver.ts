// Test-only functional facade: replay branches by inputs, never importing State into wasm.
import { createCore } from '#sync-core'
import type { Input, State, SyncCore } from './protocol-types'
export * from './protocol-types'
type Owner = { core: SyncCore; inputs: Input[]; current: State; tokens: Set<number> }
const owners = new WeakMap<State, Owner>()
export function initialState(selfId = ''): State {
  const core = createCore(selfId)
  const state = { ...core.get(), requests: {}, timers: {} }
  owners.set(state, { core, inputs: [], current: state, tokens: new Set() })
  return state
}
export function step(previous: State, input: Input) {
  let owner = owners.get(previous)
  if (!owner) throw new Error('Missing test core')
  if (owner.current !== previous) {
    const branch = createCore(previous.selfId)
    for (const prior of owner.inputs) branch.step(prior)
    owner = { ...owner, core: branch, tokens: new Set(owner.tokens) }
  }
  const result = owner.core.step(input)
  for (const effect of result.effects) if ('id' in effect) owner.tokens.add(effect.id)
  const requests: State['requests'] = {}, timers: State['timers'] = {}
  for (const id of owner.tokens) {
    const request = owner.core.request(id), timer = owner.core.timer(id)
    if (request) requests[id] = request
    if (timer) timers[id] = timer
  }
  const state = result.stateChanged ? { ...owner.core.get(),
    requests: JSON.stringify(requests) === JSON.stringify(previous.requests) ? previous.requests : requests,
    timers: JSON.stringify(timers) === JSON.stringify(previous.timers) ? previous.timers : timers,
  } : previous
  owners.set(state, { ...owner, current: state, inputs: [...owner.inputs, input] })
  owner.current = state
  return { ...result, state }
}
