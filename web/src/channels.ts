import { createActivityTarget, type Activity } from './activity'
import type { Channel, ChannelVisibility, CreateChannelRequest, Result } from './api'

export type { Channel, ChannelVisibility }

export type ChannelsApi = {
  listChannels: (signal?: AbortSignal) => Promise<Result<{ channels: Channel[] }>>
  createChannel: (body: CreateChannelRequest) => Promise<Result<Channel>>
}

export type ChannelsState = {
  status: 'loading' | 'ready' | 'error'
  channels: Channel[]
  selectedId: string | null
}

/** Japanese message for a failed channel call. */
export function channelError(r: Extract<Result<unknown>, { ok: false }>): string {
  if (r.kind === 'network') return 'サーバーに接続できません。しばらくしてからもう一度お試しください。'
  if (r.status === 400) return 'チャンネル名の前後に空白を入れず、128文字以内にしてください。'
  if (r.status === 409) return '同じ名前のチャンネルがすでにあります。'
  return 'エラーが発生しました。もう一度お試しください。'
}

const sessionEndedError = 'セッションが終了しました。'

/** Channel list, selection and creation. `subscribe` fires after every state change. `close` ends the session's list: later async results are dropped. */
export function createChannels(api: ChannelsApi, onReselect?: (id: string) => void, activity?: Activity, onSnapshot?: (channels: Channel[]) => void) {
  let state: ChannelsState = { status: 'loading', channels: [], selectedId: null }
  let generation = 0 // bumped by create(): a load that started earlier is stale
  let loadSeq = 0 // bumped by load(): an earlier load's response is superseded
  let closed = false // the session ended: nothing from an earlier call may reach this state
  const listeners = new Set<() => void>()
  const set = (patch: Partial<ChannelsState>) => {
    if (closed) return
    state = { ...state, ...patch }
    listeners.forEach((l) => l())
  }

  const target = activity ? createActivityTarget({
    load: signal => api.listChannels(signal),
    accept(data) {
      set({ status: 'ready', channels: data.channels, selectedId: state.selectedId ?? data.channels[0]?.id ?? null })
      onSnapshot?.(data.channels)
    },
    error: () => set({ status: 'error' }),
    terminal: r => !r.ok && r.kind === 'http' && (r.status === 401 || r.error === 'organization_unavailable'),
  }) : undefined
  const release = target && activity?.hold('channels', target)
  return {
    activityTarget: target,
    revoke(id: string) { generation++; loadSeq++; set({ channels: state.channels.filter(c => c.id !== id) }) },
    get: () => state,
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
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
      listeners.clear()
    },
    select(id: string) {
      if (closed || !state.channels.some((c) => c.id === id)) return
      const same = state.selectedId === id
      set({ selectedId: id })
      if (same) onReselect?.(id)
    },
    /** A URL hint may be absent from the list; only sync's API response decides availability. */
    selectHint(id: string) { set({ selectedId: id }) },
    /** Creates the channel and selects it; returns an error message on failure. The name is sent unchanged (#72: the server rejects surrounding whitespace; never trim here). */
    async create(req: CreateChannelRequest): Promise<{ error: string } | { channel: Channel }> {
      const r = await api.createChannel(req)
      if (closed) return { error: sessionEndedError }
      if (!r.ok) return { error: channelError(r) }
      generation++
      target?.invalidate('access')
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
