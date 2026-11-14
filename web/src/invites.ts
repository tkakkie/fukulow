import * as api from './api'

type Deps = Pick<typeof api, 'listInvites' | 'revokeInvite'>
export function createInvites(org: string, onEnded: () => void, onUnavailable: () => void, deps: Deps = api) {
  let state = { invites: [] as api.OutstandingInvite[], nextCursor: undefined as string | undefined,
    loaded: false, loading: false, busy: false, error: '', retryable: false, forbidden: false }
  let closed = false, generation = 0, loadedOnce = false
  let retryMore = false
  const listeners = new Set<() => void>()
  const set = (patch: Partial<typeof state>) => { if (!closed) { state = { ...state, ...patch }; listeners.forEach(l => l()) } }
  function close() { generation++; closed = true; state = { ...state, invites: [], nextCursor: undefined, loading: false, busy: false }; listeners.forEach(l => l()); listeners.clear() }
  function observe<T>(r: api.Result<T>) {
    if (!r.ok && r.kind === 'http' && r.status === 401) onEnded()
    else if (!closed && !r.ok && api.isOrganizationUnavailable(r)) { close(); onUnavailable() }
    return r
  }
  function failed(r: Exclude<api.Result<unknown>, { ok: true }>) {
    const forbidden = r.kind === 'http' && r.status === 403
    const retryable = r.kind === 'network' || r.status === 429
    set({ retryable, forbidden,
      ...(forbidden ? { invites: [], nextCursor: undefined } : {}),
      error: retryable ? '招待を取得できませんでした。通信状況を確認して再試行してください。'
        : forbidden ? '招待を管理する権限がありません。メンバーパネルを開き直してください。'
        : r.kind === 'http' && r.error === 'invite_unavailable' ? 'この招待は利用できません。一覧を更新してください。'
        : '招待を取得できませんでした。一覧を更新してください。' })
  }
  async function load(more = false) {
    if (closed || state.busy || more && (!state.nextCursor || state.loading)) return
    const own = ++generation
    const cursor = more ? state.nextCursor : undefined
    retryMore = more
    loadedOnce = true
    set({ loading: true, error: '', retryable: false, forbidden: false })
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Even late authentication loss belongs to this Account, after a timeout or close.
    const pending = deps.listInvites(org, cursor, undefined, abort.signal)
      .catch((): api.Result<api.InvitePage> => ({ ok: false, kind: 'network' })).then(observe)
    try {
      const r = await Promise.race([pending, new Promise<api.Result<api.InvitePage>>(resolve => {
        timer = setTimeout(() => { resolve({ ok: false, kind: 'network' }); abort.abort() }, 10_000)
      })])
      if (closed || own !== generation) return
      if (!r.ok) failed(r)
      else {
        const rows = more ? [...state.invites, ...r.data.invites] : r.data.invites
        // Refreshed or repeated pages cannot duplicate a visible Invite.
        set({ invites: [...new Map(rows.map(i => [i.id, i])).values()], nextCursor: r.data.next_cursor ?? undefined,
          loaded: true, error: '' })
      }
      set({ loading: false })
    } finally { clearTimeout(timer) }
  }
  async function revoke(id: string) {
    if (closed || state.busy || state.loading) return false
    generation++
    set({ busy: true, error: '', retryable: false })
    const r = observe(await deps.revokeInvite(org, id).catch((): api.Result<undefined> => ({ ok: false, kind: 'network' })))
    if (closed) return false
    if (!r.ok) {
      failed(r)
      // Retrying an uncertain DELETE could succeed and then appear unavailable.
      set({ retryable: false, error: r.kind === 'network'
        ? '招待の取消を確認できませんでした。一覧を更新して確認してください。' : state.error })
    } else set({ invites: state.invites.filter(i => i.id !== id) })
    set({ busy: false })
    return r.ok
  }
  return {
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
    load, more: () => load(true), retry: () => load(retryMore), revoke,
    refreshIfLoaded: () => loadedOnce ? load() : Promise.resolve(),
    close,
  }
}
