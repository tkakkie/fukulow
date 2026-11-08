import * as defaultApi from './api'
import type { Channel, CreateChannelRequest, Result } from './api'

export type ChannelsApi = {
  listChannels: () => Promise<Result<{ channels: Channel[] }>>
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
  if (r.status === 400) return 'チャンネル名を確認してください。'
  if (r.status === 409) return '同じ名前のチャンネルがすでにあります。'
  return 'エラーが発生しました。もう一度お試しください。'
}

/** Channel list, selection and creation. `subscribe` fires after every state change. */
export function createChannels(api: ChannelsApi = defaultApi) {
  let state: ChannelsState = { status: 'loading', channels: [], selectedId: null }
  let generation = 0 // bumped by create(): a load that started earlier is stale
  const listeners = new Set<() => void>()
  const set = (patch: Partial<ChannelsState>) => {
    state = { ...state, ...patch }
    listeners.forEach((l) => l())
  }

  return {
    get: () => state,
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    async load() {
      const mine = generation
      set({ status: 'loading' })
      const r = await api.listChannels()
      if (mine !== generation) return set({ status: 'ready' }) // stale: would drop a channel created meanwhile
      if (!r.ok) return set({ status: 'error' })
      const keep = r.data.channels.some((c) => c.id === state.selectedId)
      set({ status: 'ready', channels: r.data.channels, selectedId: keep ? state.selectedId : (r.data.channels[0]?.id ?? null) })
    },
    select(id: string) {
      if (state.channels.some((c) => c.id === id)) set({ selectedId: id })
    },
    /** Creates the channel and selects it; returns an error message on failure. */
    async create(req: CreateChannelRequest): Promise<{ error: string } | { channel: Channel }> {
      const r = await api.createChannel({ ...req, name: req.name.trim() })
      if (!r.ok) return { error: channelError(r) }
      generation++
      set({ channels: [...state.channels, r.data], selectedId: r.data.id })
      return { channel: r.data }
    },
  }
}
