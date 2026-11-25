import { completeCountFields } from './unread-counts'
import { sessionEndedMessage } from './auth'
import { createActivityTarget, type Activity } from './activity'
import { isOrganizationUnavailable, type Channel, type ChannelList, type ChannelVisibility, type CreateChannelRequest, type Result, type UpdateChannelRequest } from './api'

export type { Channel, ChannelVisibility }

export type ChannelsApi = {
  listChannels: (signal?: AbortSignal) => Promise<Result<{ channels: Channel[] }>>
  createChannel: (body: CreateChannelRequest) => Promise<Result<Channel>>
  listArchivedChannels?: (signal: AbortSignal) => Promise<Result<ChannelList>>
  getChannel?: (id: string, signal: AbortSignal) => Promise<Result<Channel>>
  updateChannel?: (id: string, body: UpdateChannelRequest) => Promise<Result<undefined>>
}

type ChannelListState = {
  status: 'loading' | 'ready' | 'error'
  channels: Channel[]
}

export type ChannelsState = ChannelListState & {
  selectedId: string | null
  readonly openChannel?: Channel
  readonly openChannelPending?: boolean
  archivedList?: ChannelListState
}

const genericError = 'エラーが発生しました。もう一度お試しください。'

/** Japanese message for a failed channel call. */
export function channelError(r: Extract<Result<unknown>, { ok: false }>): string {
  if (r.kind === 'network') return 'サーバーに接続できません。しばらくしてからもう一度お試しください。'
  if (r.status === 400) return 'チャンネル名の前後に空白を入れず、128文字以内にしてください。'
  if (r.status === 409) return '同じ名前のチャンネルがすでにあります。'
  return genericError
}

function updateError(r: Extract<Result<unknown>, { ok: false }>): string {
  if (r.kind === 'network') return channelError(r)
  if (r.status === 400) return r.error === 'dm_channel_fixed'
    ? 'ダイレクトメッセージの名前やアーカイブ状態は変更できません。'
    : channelError(r)
  if (r.status === 403 && r.error === 'forbidden') return 'このチャンネルを変更する権限がありません。'
  if (r.status === 404 && r.error === 'channel not found') return 'このチャンネルは利用できません。チャンネル一覧に戻ってください。'
  if (r.status === 409 && r.error === 'channel_archived') return 'このチャンネルはアーカイブされています。名前を変更するには復元してください。'
  if (r.status === 409 && r.error === 'channel name already exists') return channelError(r)
  return genericError
}

type ChannelDetails = {
  initialHint?(): string | null
  canOpen(id: string): boolean
  verifyOrdinary(id: string, signal: AbortSignal): Promise<Result<unknown>>
  unavailable(id: string): void
  onOpen(channel: Channel): void
  onArchivedSnapshot(rows: ChannelList['channels']): void
  connectionEpoch?(): number | null
  coversUnread?(rows: Channel[]): boolean
}

const terminal = (r: Result<unknown>) => !r.ok && r.kind === 'http' && (r.status === 401 || isOrganizationUnavailable(r))
const validList = <T>(r: Result<T>): Result<T> => r.ok && !completeCountFields(r.data) ? { ok: false, kind: 'network' } : r

/** Channel list, selection and creation. `subscribe` fires after every state change. `close` ends the session's list: later async results are dropped. */
export function createChannels(api: ChannelsApi, onReselect?: (id: string) => void, activity?: Activity, onSnapshot?: (channels: Channel[]) => void, details?: ChannelDetails) {
  let state: ChannelsState = { status: 'loading', channels: [], selectedId: null }
  let generation = 0 // bumped by create(): a load that started earlier is stale
  let loadSeq = 0 // bumped by load(): an earlier load's response is superseded
  let closed = false // the session ended: nothing from an earlier call may reach this state
  let hasList = false
  let selectedKind: 'channel' | 'dm' | undefined
  let open: { id: string; release(): void; invalidate(): void } | undefined
  let archived: { release(): void; invalidate(): void; refresh(): void; retry(): void } | undefined
  let archivedHolds = 0
  let awaitingReady = false
  let authorized: { channels: readonly Channel[]; current: boolean } = { channels: [], current: false }
  const authorizedListeners = new Set<() => void>()
  const setAuthorized = (channels: readonly Channel[], current: boolean) => {
    if (authorized.channels === channels && authorized.current === current) return
    authorized = { channels, current }
    authorizedListeners.forEach(l => l())
  }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<ChannelsState>) => {
    if (closed) return
    if (patch.selectedId !== undefined && patch.selectedId !== state.selectedId) {
      selectedKind = undefined
      open?.release(); open = undefined
      patch = { ...patch, openChannel: undefined, openChannelPending: false }
    }
    state = { ...state, ...patch }
    followOpen()
    followArchived()
    listeners.forEach((l) => l())
  }

  function followOpen() {
    const getChannel = api.getChannel
    if (closed || !activity || !getChannel || !details) return
    const id = state.selectedId
    const listed = state.channels.some(c => c.id === id)
    if (listed || state.archivedList?.channels.some(c => c.id === id)) selectedKind = 'channel'
    if (!id || !hasList || listed || selectedKind === 'dm' || !details.canOpen(id)) {
      if (open) {
        open.release(); open = undefined
        if (state.openChannel) state = { ...state, openChannel: undefined, openChannelPending: false }
      }
      return
    }
    if (open?.id === id) return
    const target = createActivityTarget<Channel>({
      async load(signal) {
        // A URL contains only an id. Topics succeed only for ordinary Channels.
        if (selectedKind !== 'channel') {
          const result = await details.verifyOrdinary(id, signal)
          if (!result.ok) return result
          if (signal.aborted) return { ok: false, kind: 'network' }
          selectedKind = 'channel'
        }
        return getChannel(id, signal)
      },
      accept(channel) {
        set({ openChannel: channel, openChannelPending: false })
        details.onOpen(channel)
      },
      error(r) {
        if (r.kind !== 'http') return
        if (r.status === 404 && !isOrganizationUnavailable(r)) details.unavailable(id)
        if (r.status === 400 && r.error === 'dm_topics_not_allowed') {
          selectedKind = 'dm'
          followOpen()
        }
      },
      terminal,
    })
    const release = activity.hold('open-channel', target)
    open = { id, release: () => { target.close(); release() }, invalidate: () => target.invalidate('access') }
    target.invalidate('notice', 0)
  }

  function followArchived() {
    const load = api.listArchivedChannels
    if (closed || !activity || !load) return
    if (archivedHolds === 0 && (!state.openChannel?.archived || state.openChannelPending)) {
      if (archived) {
        archived.release(); archived = undefined
        state = { ...state, archivedList: undefined }
      }
      return
    }
    if (archived) return
    const target = createActivityTarget<ChannelList>({
      load: async signal => validList(await load(signal)),
      accept(data) {
        set({ archivedList: { status: 'ready', channels: data.channels } })
        details?.onArchivedSnapshot(data.channels)
      },
      error: () => set({ archivedList: { status: 'error', channels: state.archivedList?.channels ?? [] } }),
      terminal,
    })
    const release = activity.hold('archived-channels', target)
    archived = {
      release: () => { target.close(); release() },
      invalidate: () => target.invalidate('access'),
      refresh: () => target.invalidate(),
      retry: () => {
        set({ archivedList: { status: 'loading', channels: state.archivedList?.channels ?? [] } })
        void target.retryNow()
      },
    }
    state = { ...state, archivedList: { status: 'loading', channels: [] } }
    void target.refresh()
  }

  const target = activity ? createActivityTarget<{ channels: Channel[] }>({
    canLoad: () => !awaitingReady,
    load: async signal => validList(await api.listChannels(signal)),
    connectionEpoch: details?.connectionEpoch,
    covers: data => details?.coversUnread?.(data.channels) ?? true,
    acceptBelowFloor: true,
    onReadyCovered() { if (hasList) onSnapshot?.(state.channels) },
    accept(data) {
      hasList = true
      const previous = state.channels.find(c => c.id === state.selectedId)
      const departed = previous && api.getChannel && details?.canOpen(previous.id) && !data.channels.some(c => c.id === previous.id)
      onSnapshot?.(data.channels)
      set({
        status: 'ready', channels: data.channels, selectedId: state.selectedId ?? details?.initialHint?.() ?? data.channels[0]?.id ?? null,
        ...(departed ? { openChannel: previous, openChannelPending: true } : {}),
      })
      setAuthorized(data.channels, true)
    },
    hide: () => setAuthorized(authorized.channels, false),
    error: () => {
      setAuthorized(authorized.channels, false)
      set({ status: 'error' })
    },
    terminal,
  }) : undefined
  const release = target && activity?.hold('channels', target)
  const isOrdinary = (id: string) => (id === state.selectedId && selectedKind === 'channel') || state.channels.some(c => c.id === id) || !!state.archivedList?.channels.some(c => c.id === id)
  async function update(id: string, body: UpdateChannelRequest): Promise<string | null> {
    if (closed) return sessionEndedMessage
    if (!api.updateChannel) return genericError
    const result = await api.updateChannel(id, body)
    if (closed) return sessionEndedMessage
    if (!result.ok) return updateError(result)
    activity?.notice({ type: 'channel_list_changed' })
    return null
  }
  return {
    activityTarget: target,
    authorizedList: {
      get: () => authorized,
      subscribe(listener: () => void) {
        authorizedListeners.add(listener)
        return () => authorizedListeners.delete(listener)
      },
      invalidate: () => target?.invalidate('access'),
      disconnected() {
        awaitingReady = true
        target?.suspend()
        setAuthorized(authorized.channels, false)
      },
      ready() { awaitingReady = false },
    },
    revoke(id: string) {
      generation++; loadSeq++
      const list = state.archivedList
      set({ channels: state.channels.filter(c => c.id !== id),
        archivedList: list && { ...list, channels: list.channels.filter(c => c.id !== id) },
        ...(state.openChannel?.id === id ? { openChannel: undefined, openChannelPending: false } : {}) })
      setAuthorized(authorized.channels.filter(c => c.id !== id), false)
    },
    get: () => state,
    isOrdinary,
    isArchived(id: string) {
      if (state.channels.some(c => c.id === id)) return false
      if (state.openChannel?.id === id && !state.openChannelPending) return state.openChannel.archived
      return !!state.archivedList?.channels.some(c => c.id === id)
    },
    refreshOpen() {
      const before = state
      followOpen()
      followArchived()
      if (before !== state) listeners.forEach(l => l())
    },
    resetHistory() { open?.invalidate(); archived?.invalidate() },
    refreshArchived() { archived?.refresh() },
    // The list may be kept alive by an open archived Channel, so a retry cannot rely on re-holding it.
    retryArchived() { archived?.retry() },
    holdArchived() {
      if (closed || !activity || !api.listArchivedChannels) return () => {}
      if (++archivedHolds === 1) set({})
      let held = true
      return () => {
        if (!held || closed) return
        held = false
        if (--archivedHolds === 0) set({})
      }
    },
    rename: (id: string, name: string) => update(id, { name }),
    archive: (id: string) => update(id, { archived: true }),
    restore: (id: string) => update(id, { archived: false }),
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    async ensure() {
      if (target) return target.ensure()
      return this.load()
    },
    async load() {
      if (target) return target.refresh()
      const seq = ++loadSeq
      const mine = generation
      set({ status: 'loading' })
      const r = await api.listChannels()
      if (closed || seq !== loadSeq) return
      if (!r.ok) return set({ status: mine !== generation ? 'ready' : 'error' })
      if (mine !== generation) {
        // stale: read before a create committed; merge so neither side is lost
        const ids = new Set(r.data.channels.map((c) => c.id))
        const channels = [...r.data.channels, ...state.channels.filter((c) => !ids.has(c.id))]
        return set({ status: 'ready', channels })
      }
      const keep = r.data.channels.some((c) => c.id === state.selectedId)
      set({ status: 'ready', channels: r.data.channels, selectedId: keep ? state.selectedId : (r.data.channels[0]?.id ?? null) })
    },
    close() {
      closed = true
      target?.close(); release?.()
      open?.release(); archived?.release()
      listeners.clear()
      authorizedListeners.clear()
    },
    select(id: string) {
      if (closed || !isOrdinary(id)) return
      const same = state.selectedId === id
      set({ selectedId: id })
      if (same) onReselect?.(id)
    },
    /** A URL hint may be absent from the list; only sync's API response decides availability. */
    selectHint(id: string) { set({ selectedId: id }) },
    /** Creates the channel and selects it; returns an error message on failure. The name is sent unchanged (#72: the server rejects surrounding whitespace; never trim here). */
    async create(req: CreateChannelRequest): Promise<{ error: string } | { channel: Channel }> {
      const r = await api.createChannel(req)
      if (closed) return { error: sessionEndedMessage }
      if (!r.ok) return { error: channelError(r) }
      generation++
      target?.invalidate('access')
      activity?.invalidate('sections', 'access')
      set({ channels: [...state.channels.filter(c => c.id !== r.data.id), r.data], selectedId: r.data.id })
      return { channel: r.data }
    },
  }
}

/** Max Channel name length in Unicode scalar values (API rule; a test compares it to openapi.json). */
export const CHANNEL_NAME_MAX = 128

/** Japanese message when the name is too long, else null. Counts scalar values (not UTF-16 units), like the server's `chars().count()`. */
export function channelNameTooLong(name: string): string | null {
  return [...name].length > CHANNEL_NAME_MAX
    ? `チャンネル名は${CHANNEL_NAME_MAX}文字以内にしてください。`
    : null
}
