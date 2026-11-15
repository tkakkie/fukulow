import type { Dm, DmChanges, DmDiscovery, DmList } from './api-schema'

export type DmLane = 'delta' | 'coverage' | 'held' | 'browse' | 'recovery'
export type DmRow = { identity: DmDiscovery; baseline?: Dm; access: number; used: number }
type Lane = { cursor?: string; pending: boolean; done: boolean; retryAt: number; attempt: number; stopped: boolean; error: boolean }
export type DmRequest = { id: number; lane: DmLane; generation: number; cursor?: string; ids?: string[]; access: Record<string, number>; recoveryPeer?: string }
export type DmListState = {
  rows: DmRow[]; selected: string | null; generation: number; serial: number; clock: number
  lanes: Record<DmLane, Lane>; round: string[][]; needsRound: boolean
  budget: number; discoveryUsed: DmLane[]; sharedUsed: DmLane[]; rotation: number
  request?: DmRequest; queued: boolean; paused: boolean; closed: boolean
  recoveryPeer?: string; recovered?: string; recoveryAbsent: boolean; recoveryRenewed: boolean
  status: 'loading' | 'ready' | 'error'; error: boolean
  sendBlocks: Record<string, 'dm_peer_deactivated' | 'dm_peer_access_lapsed'>
}
const lane = (pending = false): Lane => ({ pending, done: false, retryAt: 0, attempt: 0, stopped: false, error: false })
export const dmListState = (): DmListState => ({ rows: [], selected: null, generation: 0, serial: 0, clock: 0,
  lanes: { delta: lane(true), coverage: lane(true), held: lane(), browse: lane(), recovery: lane() },
  round: [], needsRound: true, budget: 5, discoveryUsed: [], sharedUsed: [], rotation: 0,
  queued: false, paused: false, closed: false, recoveryAbsent: false, recoveryRenewed: false, status: 'loading', error: false, sendBlocks: {} })

export type DmInput =
  | { type: 'demand'; boundary: boolean; periodic?: boolean; replace: string[] }
  | { type: 'select'; id: string | null }
  | { type: 'browse' }
  | { type: 'recover'; peer: string; renewed?: boolean }
  | { type: 'opened'; generation: number; dm: Dm; renewed?: boolean }
  | { type: 'peer_refusal'; id: string; error: 'dm_peer_deactivated' | 'dm_peer_access_lapsed' }
  | { type: 'access'; id: string; revoked: boolean }
  | { type: 'pause' | 'resume' | 'close' }
  | { type: 'wake'; now: number }
  | { type: 'result'; request: DmRequest; data: DmChanges | DmList }
  | { type: 'failure'; request: DmRequest; retryAt: number; terminal: boolean }

export type DmEffect = { type: 'request'; request: DmRequest } | { type: 'baseline'; dm: Dm; replace: boolean } |
  { type: 'drop'; id: string } | { type: 'processed'; identity: DmDiscovery } | { type: 'recovered'; id: string }

/** One indivisible P8 tuple; a contradictory equal-position snapshot never supplies partial fields. */
export function chooseDmBaseline(old: Dm | undefined, next: Dm): Dm | undefined {
  if (!old || next.as_of_seq > old.as_of_seq || (next.as_of_seq === old.as_of_seq && next.read_seq > old.read_seq)) return next
  if (next.as_of_seq === old.as_of_seq && next.read_seq === old.read_seq &&
    next.unread_count <= old.unread_count && next.main_unread_count <= old.main_unread_count && next.mention_unread_count <= old.mention_unread_count) return next
  return old
}

const shared: DmLane[] = ['held', 'browse', 'recovery']
const discovery: DmLane[] = ['delta', 'coverage']
function freezeRound(s: DmListState) {
  const retained = new Set(s.rows.map(row => row.identity.id))
  while (s.round.length && !s.round[0]!.some(id => retained.has(id))) s.round.shift()
  if (s.round.length || !s.needsRound) return
  const ids = s.rows.map(r => r.identity.id)
  for (let i = 0; i < ids.length; i += 50) s.round.push(ids.slice(i, i + 50))
  s.needsRound = false
  s.lanes.held.pending = s.round.length > 0
}
function nextLane(s: DmListState, now: number): DmLane | undefined {
  if (!s.budget || s.request || s.paused || s.closed) return
  const eligible = (name: DmLane) => s.lanes[name].pending && !s.lanes[name].stopped && s.lanes[name].retryAt <= now
  for (const name of discovery) if (!s.discoveryUsed.includes(name) && eligible(name)) return name
  if (s.sharedUsed.length >= 3) return
  freezeRound(s)
  const order = [...shared.slice(s.rotation), ...shared.slice(0, s.rotation)]
  return order.find(name => eligible(name) && !s.sharedUsed.includes(name)) ?? order.find(eligible)
}
export function dmNextWake(s: DmListState, now: number): number | undefined {
  if (s.paused || s.closed || s.request || !s.budget) return
  const allowed = (name: DmLane) => name === 'delta' || name === 'coverage' ? !s.discoveryUsed.includes(name) : s.sharedUsed.length < 3
  const times = [...discovery, ...shared].filter(name => allowed(name) && s.lanes[name].pending && !s.lanes[name].stopped).map(name => Math.max(now, s.lanes[name].retryAt))
  if (s.needsRound && !s.round.length && s.rows.length && s.sharedUsed.length < 3 && !s.lanes.held.stopped) times.push(Math.max(now, s.lanes.held.retryAt))
  return times.length ? Math.min(...times) : undefined
}

/** Pure bounded list/discovery state. It never receives Message, presentation or mark-read inputs. */
export function stepDmList(state: DmListState, input: DmInput): { state: DmListState; effects: DmEffect[] } {
  // Copy mutable containers; identities, baselines, requests and frozen id batches are immutable.
  const s: DmListState = { ...state, rows: state.rows.map(row => ({ ...row })),
    lanes: { delta: { ...state.lanes.delta }, coverage: { ...state.lanes.coverage }, held: { ...state.lanes.held },
      browse: { ...state.lanes.browse }, recovery: { ...state.lanes.recovery } },
    round: [...state.round], discoveryUsed: [...state.discoveryUsed], sharedUsed: [...state.sharedUsed], sendBlocks: { ...state.sendBlocks } }
  const effects: DmEffect[] = []
  if (s.closed) return { state: s, effects }
  const demand = () => {
    for (const l of Object.values(s.lanes)) l.stopped = false
    s.lanes.delta.pending = true; s.lanes.coverage.pending = true; s.needsRound = true
    if (s.request) s.queued = true
  }
  const remove = (id: string) => {
    s.rows = s.rows.filter(r => r.identity.id !== id)
    delete s.sendBlocks[id]
    effects.push({ type: 'drop', id })
  }
  switch (input.type) {
    case 'demand':
      if (input.boundary) {
        s.generation++
        for (const row of s.rows) if (input.replace.includes(row.identity.id)) {
          row.access = ++s.serial; row.baseline = undefined
          effects.push({ type: 'drop', id: row.identity.id })
        }
      }
      if (input.periodic) {
        s.budget = 5; s.discoveryUsed = []; s.sharedUsed = []; s.rotation = (s.rotation + 1) % 3
      }
      demand(); break
    case 'pause': s.paused = true; s.generation++; s.request = undefined; s.queued = false; break
    case 'resume': s.paused = false; s.generation++; demand(); break
    case 'close': s.closed = true; s.generation++; s.request = undefined; break
    case 'select':
      s.selected = input.id
      for (const row of s.rows) if (row.identity.id === input.id) row.used = ++s.clock
      break
    case 'browse':
      s.lanes.browse.stopped = false
      if (!s.lanes.browse.done) s.lanes.browse.pending = true
      break
    case 'recover':
      if (s.recoveryPeer !== input.peer || s.recovered || s.recoveryAbsent) { s.generation++; s.lanes.recovery = lane(true) }
      s.recoveryPeer = input.peer; s.recovered = undefined; s.recoveryAbsent = false
      s.recoveryRenewed = input.renewed === true
      s.lanes.recovery.stopped = false
      s.lanes.recovery.pending = true
      break
    case 'opened': {
      if (input.generation !== s.generation || s.paused) break
      const dm = input.dm
      let row = s.rows.find(r => r.identity.id === dm.id)
      if (!row) { row = { identity: dm, access: ++s.serial, used: ++s.clock }; s.rows.push(row) }
      row.identity = { id: dm.id, kind: dm.kind, peer: dm.peer }
      const previous = row.baseline
      row.baseline = chooseDmBaseline(previous, dm)
      if (row.baseline === dm) effects.push({ type: 'baseline', dm, replace: previous === undefined })
      s.selected = dm.id; s.needsRound = true
      if (input.renewed) delete s.sendBlocks[dm.id]
      effects.push({ type: 'processed', identity: row.identity })
      trim()
      break
    }
    case 'peer_refusal':
      if (s.rows.some(row => row.identity.id === input.id) || s.selected === input.id) s.sendBlocks[input.id] = input.error
      break
    case 'access':
      s.generation++
      if (input.revoked) remove(input.id)
      else {
        const row = s.rows.find(r => r.identity.id === input.id)
        if (row) { row.access = ++s.serial; row.baseline = undefined; effects.push({ type: 'drop', id: input.id }) }
      }
      demand(); break
    case 'wake': {
      const name = nextLane(s, input.now)
      if (!name) break
      const l = s.lanes[name]
      const access = Object.fromEntries(s.rows.map(r => [r.identity.id, r.access]))
      const request: DmRequest = { id: ++s.serial, lane: name, generation: s.generation,
        ...(l.cursor === undefined ? {} : { cursor: l.cursor }),
        ...(name === 'held' ? { ids: s.round[0]!.filter(id => Object.hasOwn(access, id)) } : {}),
        ...(name === 'recovery' ? { recoveryPeer: s.recoveryPeer } : {}),
        access }
      if (name === 'delta' || name === 'coverage') s.discoveryUsed.push(name)
      else s.sharedUsed.push(name)
      s.budget--; s.request = request; s.queued = false
      effects.push({ type: 'request', request }); break
    }
    case 'failure': {
      if (s.request?.id !== input.request.id) break
      s.request = undefined
      const l = s.lanes[input.request.lane]
      l.retryAt = input.retryAt; l.attempt++; l.stopped = input.terminal; l.error = true
      s.status = 'error'; s.error = true
      break
    }
    case 'result': {
      const q = input.request
      if (s.request?.id !== q.id) break
      s.request = undefined
      const l = s.lanes[q.lane]
      const current = q.generation === s.generation && !s.paused
      if (!current) { s.queued = true; break }
      l.attempt = 0; l.retryAt = 0; l.error = false
      const rowsById = new Map(s.rows.map(row => [row.identity.id, row]))
      // Match recovery before LRU eviction, even when the match is well beyond retained rows.
      for (const dm of input.data.dms) {
        if (q.lane === 'recovery' && q.recoveryPeer === s.recoveryPeer && dm.peer.id === s.recoveryPeer) {
          s.recovered = dm.id; l.done = true; l.pending = false
          s.selected = dm.id
          if (s.recoveryRenewed && dm.peer.active) delete s.sendBlocks[dm.id]
          effects.push({ type: 'recovered', id: dm.id })
        }
        let row = rowsById.get(dm.id)
        if (row && q.access[dm.id] !== row.access) continue
        effects.push({ type: 'processed', identity: dm })
        if (!row) { row = { identity: dm, access: ++s.serial, used: ++s.clock }; s.rows.push(row); rowsById.set(dm.id, row); s.needsRound = true }
        row.identity = { id: dm.id, kind: dm.kind, peer: dm.peer }
        if (dm.peer.active && s.sendBlocks[dm.id] === 'dm_peer_deactivated') delete s.sendBlocks[dm.id]
        if ('as_of_seq' in dm) {
          const previous = row.baseline
          row.baseline = chooseDmBaseline(previous, dm)
          if (row.baseline === dm) effects.push({ type: 'baseline', dm, replace: previous === undefined })
          else { s.needsRound = true; l.error = true }
        }
      }
      if (q.lane === 'held') {
        const returned = new Set(input.data.dms.map(dm => dm.id))
        for (const id of q.ids ?? []) {
          const row = rowsById.get(id)
          if (!returned.has(id) && row?.access === q.access[id]) remove(id)
        }
        s.round.shift(); l.pending = s.round.length > 0
      } else {
        if ((q.lane === 'browse' || q.lane === 'recovery') && l.cursor !== q.cursor) break
        l.cursor = input.data.next_cursor ?? undefined
        if ('caught_up' in input.data) { l.done = input.data.caught_up; l.pending = false }
        else { l.done = input.data.next_cursor === null; l.pending = q.lane === 'recovery' && !l.done && !s.recovered }
        if (q.lane === 'recovery' && l.done && !s.recovered) s.recoveryAbsent = true
      }
      s.status = 'ready'
      // Keep a selected conversation even when it is the oldest retained identity.
      trim()
      break
    }
  }
  s.error = Object.values(s.lanes).some(l => l.error)
  if (s.error) s.status = 'error'
  return { state: s, effects }

  function trim() {
    if (s.rows.length <= 200) return
    const victims = s.rows.filter(r => r.identity.id !== s.selected).sort((a, b) => a.used - b.used).slice(0, s.rows.length - 200)
    const removed = new Set(victims.map(row => row.identity.id))
    s.rows = s.rows.filter(row => !removed.has(row.identity.id))
    for (const row of victims) {
      delete s.sendBlocks[row.identity.id]
      effects.push({ type: 'drop', id: row.identity.id })
    }
  }
}
