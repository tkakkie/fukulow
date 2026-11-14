import { createActivityTarget } from './activity'
import * as api from './api'
import { memberError } from './members'

type Deps = Pick<typeof api, 'listChannelMembers' | 'addChannelMember' | 'removeChannelMember' | 'changeChannelManager'>
export function channelMemberError(r: Exclude<api.Result<unknown>, { ok: true }>) {
  if (r.kind === 'http') {
    if (r.error === 'last_channel_manager') return 'このチャンネルを管理できる最後のメンバーです。先に別のオーナー、管理者、またはチャンネル管理者を設定してください。'
    if (r.error === 'last_channel_grant') return '最後のメンバーはチャンネルから外せません。先に別のメンバーを追加してください。'
    if (r.error === 'channel_manager_private_only') return 'パブリックチャンネルではチャンネル管理者を設定できません。'
    if (r.error === 'channel_manager_guest') return 'ゲストにはチャンネル管理者を設定できません。'
    if (r.error === 'member_not_found') return '対象のメンバーが見つかりません。一覧を更新してからもう一度お試しください。'
    if (r.error === 'channel_grant_not_found') return 'このメンバーはチャンネルに参加していません。一覧を更新してからもう一度お試しください。'
    if (r.error === 'channel not found' || (r.status === 404 && !api.isOrganizationUnavailable(r))) return 'このチャンネルは利用できません。チャンネル一覧から選び直してください。'
  }
  return memberError(r)
}

export function createChannelMembers(org: string, channel: string, onResult: (r: api.Result<unknown>) => void,
  deps: Deps = api, onUnavailable: () => void = () => {}, onRefreshChannels: () => unknown = () => {}) {
  let state = { members: [] as api.ChannelMember[], loading: true, busy: false, error: '', unavailable: false, retryable: false }
  let generation = 0, closed = false
  const listeners = new Set<() => void>()
  const set = (patch: Partial<typeof state>) => { if (!closed) { state = { ...state, ...patch }; listeners.forEach(l => l()) } }
  async function request<T>(run: () => Promise<api.Result<T>>, withTimeout = true): Promise<api.Result<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    // Keep same-session late 401 handling even after the display timeout or close.
    const pending = run().catch((): api.Result<T> => ({ ok: false, kind: 'network' })).then(r => { onResult(r); return r })
    if (!withTimeout) return pending
    try { return await Promise.race([pending, new Promise<api.Result<T>>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, kind: 'network' }), 10_000)
    })]) } finally { clearTimeout(timer) }
  }
  const activityTarget = createActivityTarget({
    load: signal => request(() => deps.listChannelMembers(org, channel, undefined, signal), false),
    accept: data => { if (!state.unavailable) set({ members: data.members, loading: false, error: '' }) },
    hide: () => set({ members: [], loading: true }),
    error: r => {
      if (r.kind === 'http' && (r.status === 403 || (r.status === 404 && !api.isOrganizationUnavailable(r)))) { onUnavailable(); set({ members: [], loading: false, unavailable: true }) }
      else set({ loading: false, error: channelMemberError(r), retryable: r.kind === 'network' || r.status === 429 || r.status >= 500 })
    },
    terminal: r => !r.ok && r.kind === 'http' && (r.status === 401 || r.status === 403 || r.status === 404),
  })
  const load = () => closed || state.unavailable ? Promise.resolve() : activityTarget.retryNow()
  async function mutate(run: () => Promise<api.Result<undefined>>, refreshChannels = false) {
    if (closed || state.busy || state.unavailable) return
    const own = ++generation
    set({ busy: true, error: '' })
    const r = await request(run)
    if (closed || own !== generation || state.unavailable) return
    set({ busy: false })
    if (!r.ok) set({ error: channelMemberError(r) })
    else await Promise.all([load(), refreshChannels ? onRefreshChannels() : undefined])
  }
  return {
    activityTarget,
    get: () => state,
    subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
    load,
    add: (id: string) => mutate(() => deps.addChannelMember(org, channel, { member_id: id })),
    remove: (id: string) => mutate(() => deps.removeChannelMember(org, channel, id)),
    changeManager: (id: string, manager: boolean) => mutate(() => deps.changeChannelManager(org, channel, id, { manager }), true),
    reselect() { if (!closed && state.unavailable) { set({ unavailable: false }); void load() } },
    unavailable() { activityTarget.suspend(); generation++; set({ members: [], unavailable: true, loading: false, busy: false }) },
    close() { activityTarget.close(); closed = true; generation++; listeners.clear() },
  }
}
