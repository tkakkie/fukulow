import { createActivityTarget, type Activity, type ActivityTarget, type Invalidation } from './activity'
import * as api from './api'
import { dmListState, dmNextWake, stepDmList, type DmInput, type DmRequest } from './dm-list'

export type DmsApi = {
  list(query: api.DmListQuery, signal: AbortSignal): Promise<api.Result<api.DmList>>
  changes(query: api.DmChangesQuery, signal: AbortSignal): Promise<api.Result<api.DmChanges>>
  open(body: api.OpenDmRequest, signal: AbortSignal): Promise<api.Result<api.Dm>>
}
export const dmsApi = (org: string): DmsApi => ({
  list: (query, signal) => api.listDms(org, query, undefined, signal),
  changes: (query, signal) => api.listDmChanges(org, query, undefined, signal),
  open: (body, signal) => api.openDm(org, body, undefined, signal),
})
const terminal = (r: api.Result<unknown>) => !r.ok && r.kind === 'http' && (r.status === 401 || api.isOrganizationUnavailable(r))
const retryable = (r: Exclude<api.Result<unknown>, { ok: true }>) => r.kind === 'network' || r.status === 429 || r.status >= 500
export function dmError(r: Exclude<api.Result<unknown>, { ok: true }>): string {
  if (r.kind === 'http' && r.error === 'member_not_found') return 'このメンバーとのダイレクトメッセージは開けません。'
  if (r.kind === 'http' && r.status === 403) return 'ダイレクトメッセージを開く権限がありません。'
  return 'ダイレクトメッセージを確認できませんでした。通信状況を確認してください。'
}

/** Five lanes share the #307 target's deadline, cancellation, debounce and single-flight gate. */
export function createDms(options: {
  api: DmsApi; activity: Activity; watched(id: string): boolean
  baseline(dm: api.Dm, replace: boolean): void; drop(id: string): void
  select(id: string): void; processed?(identity: api.DmDiscovery): void
  random?: () => number; timeoutMs?: number
}) {
  let state = dmListState(), busy = false, error = '', mutation: api.OpenDmRequest | undefined
  let mutationGeneration = 0, active: DmRequest | undefined, closed = false
  const random = options.random ?? Math.random
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())
  function dispatch(input: DmInput) {
    const result = stepDmList(state, input); state = result.state
    for (const effect of result.effects) {
      if (effect.type === 'baseline') options.baseline(effect.dm, effect.replace)
      else if (effect.type === 'drop') options.drop(effect.id)
      else if (effect.type === 'processed') options.processed?.(effect.identity)
      else if (effect.type === 'recovered') { error = ''; options.select(effect.id) }
    }
    notify()
  }
  function plan(delay = 200) {
    if (closed) return
    const next = dmNextWake(state, Date.now())
    if (next !== undefined) target.invalidate('notice', Math.max(delay, next - Date.now()))
  }
  const target = createActivityTarget<{ request: DmRequest; data: api.DmList | api.DmChanges } | null>({
    manualRetry: true, random, timeoutMs: options.timeoutMs,
    async load(signal) {
      dispatch({ type: 'wake', now: Date.now() })
      active = state.request
      if (!active) return { ok: true, data: null }
      const request = active
      const result = request.lane === 'delta' || request.lane === 'coverage'
        ? await options.api.changes({ lane: request.lane, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) }, signal)
        : await options.api.list(request.lane === 'held' ? { channel_id: request.ids } : request.cursor === undefined ? {} : { cursor: request.cursor }, signal)
      return result.ok ? { ok: true, data: { request, data: result.data } } : result
    },
    accept(value) { if (value) dispatch({ type: 'result', ...value }) },
    error(result) {
      if (!active) return
      const attempt = state.lanes[active.lane].attempt
      const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
      dispatch({ type: 'failure', request: active, retryAt: Date.now() + Math.max(result.retryAfterMs ?? 0, cap / 2 + random() * cap / 2), terminal: !retryable(result) })
      if (terminal(result)) close()
    },
    settled() { active = undefined; plan() },
  })
  function invalidate(reason: Invalidation = 'notice', delay = 200) {
    if (closed) return
    dispatch({ type: 'demand', boundary: reason !== 'notice', periodic: reason === 'periodic',
      replace: reason === 'reconcile' || reason === 'periodic' ? state.rows.filter(r => !options.watched(r.identity.id)).map(r => r.identity.id) : [] })
    plan(delay)
  }
  const activityTarget: ActivityTarget = {
    invalidate,
    disconnected() { if (!state.paused) { dispatch({ type: 'pause' }); target.suspend() } },
    close,
  }
  const release = options.activity.hold('dms', activityTarget)
  const mutationTarget = createActivityTarget<api.Dm>({
    manualRetry: true, timeoutMs: options.timeoutMs,
    load: signal => options.api.open(mutation!, signal),
    accept(dm) {
      // A POST snapshot never restores list authority after a notice/access/socket boundary.
      const current = mutationGeneration === state.generation && !state.paused
      if (current) {
        dispatch({ type: 'opened', generation: mutationGeneration, dm, renewed: mutation?.renew === true })
        options.select(dm.id)
      } else dispatch({ type: 'recover', peer: dm.peer.id, renewed: mutation?.renew === true })
      invalidate('access')
    },
    error(result) {
      error = dmError(result)
      invalidate('access')
      if (retryable(result) && mutation) dispatch({ type: 'recover', peer: mutation.member_id })
      if (terminal(result)) close()
    },
    settled() { busy = false; notify(); plan() },
  })
  function close() {
    if (closed) return
    closed = true; dispatch({ type: 'close' }); target.close(); mutationTarget.close(); listeners.clear()
  }
  plan()
  return {
    get: () => ({ ...state, busy, message: error || (state.error ? 'ダイレクトメッセージを確認できませんでした。通信状況を確認して、もう一度お試しください。' : '') }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    activityTarget,
    ready() { dispatch({ type: 'resume' }); invalidate('reconcile') },
    trackSelection(id: string | null) { dispatch({ type: 'select', id }) },
    select(id: string) { dispatch({ type: 'select', id }); options.select(id) },
    browse() { dispatch({ type: 'browse' }); plan() },
    refresh() { invalidate() },
    access(id: string, revoked = false) { dispatch({ type: 'access', id, revoked }); plan() },
    peerRefusal(id: string, result: api.Result<unknown>) {
      if (!result.ok && result.kind === 'http' && (result.error === 'dm_peer_deactivated' || result.error === 'dm_peer_access_lapsed')) {
        dispatch({ type: 'peer_refusal', id, error: result.error }); invalidate('access')
      }
    },
    async open(memberId: string, renew = false) {
      if (closed || busy) return
      busy = true; error = ''; mutation = { member_id: memberId, ...(renew ? { renew: true } : {}) }
      invalidate('access'); mutationGeneration = state.generation; notify()
      await mutationTarget.refresh()
    },
    close() { close(); release() },
  }
}
export type Dms = ReturnType<typeof createDms>
