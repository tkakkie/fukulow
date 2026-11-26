import type { Message, Result, ChannelList } from './api'
import type { createSync } from './sync'
import type { Topics } from './topics'
import type { TopicBaseline, TopicLine } from './topic-selectors'
import { initialState } from './protocol-driver'
import { standaloneAccess } from './sync-test-helpers'
import { createUnread, type UnreadApi, type UnreadScope } from './unread'
import { flush, msg, ok, row, summary } from './unread-test-helpers'

/** Bounded upstream windows isolate the Unread controller's retention from sync/projection storage. */
export function retentionClient() {
  let state = initialState('me'), records = new Map<number, Message>(), through = 0
  let channelRow = row({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 0, read_seq: 0, main_unread_count: 0, unread_count: 0 })
  const baselines = new Map<string, TopicBaseline>()
  const listeners = new Set<() => void>(), topicListeners = new Set<() => void>()
  const marks: { scope: UnreadScope; read_seq: number }[] = []
  const projectionRows: Message[] = []
  const topicLines = (): TopicLine[] => [...baselines].map(([topicId, baseline]) => ({ kind: 'topic', topicId, baseline,
    position: baseline.summary.last_seq, latestMessage: baseline.summary.latest_message,
    messageCount: baseline.summary.message_count, summaryError: null }))
  const api: UnreadApi = {
    listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channelRow] }),
    markRead: async (scope, body) => { marks.push({ scope, ...body }); return ok({ ...body, history_generation: '00000000-0000-4000-8000-000000000515' }) },
    getTopicSummary: async (_channel, topic) => {
      const b = baselines.get(topic)!
      return ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: b.asOfSeq, topic: b.summary })
    },
  }
  // Only the upstream observations/lifecycle used by Unread are implemented by this test double.
  const sync = { observeHistoryGeneration: (generation: string) => { state = { ...state, historyGeneration: generation }; return true }, request: (id: number) => state.requests[id], timer: (id: number) => state.timers[id], get: () => state, subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
    close: async () => {}, unavailable: async () => {}, reportAccess: standaloneAccess().reportSyncAccess } as unknown as ReturnType<typeof createSync>
  const topics = { subscribe(l: () => void) { topicListeners.add(l); return () => { topicListeners.delete(l) } },
    get: () => ({ unavailable: false, lines: projectionRows.map(message => ({ kind: 'message', message })), topics: topicLines(),
      main: { asOfSeq: through, hasMore: false },
      topic: () => ({ initialized: true, hasMore: false, through, messages: [] }) }),
  } as unknown as Topics
  const unread = createUnread(sync, { api, topics })
  function capture(run: () => void) {
    const set = Map.prototype.set
    Map.prototype.set = function(key, value) {
      if (typeof key === 'number' && value?.channel_id === 'A' && value.created_seq === key) records = this
      return set.call(this, key, value)
    }
    try { run() } finally { Map.prototype.set = set }
  }
  function feed(messages: Message[]) {
    through = Math.max(through, ...messages.map(m => m.created_seq))
    state = { ...state, channels: { A: { ...state.channels.A, messages, cursor: through } } }
    capture(() => listeners.forEach(l => l()))
  }
  function topic(topicId: string, asOfSeq: number, readSeq: number, count: number, notify = true) {
    baselines.set(topicId, { asOfSeq, summary: summary(topicId, asOfSeq, readSeq, count) })
    if (notify) capture(() => topicListeners.forEach(l => l()))
  }
  return { unread, api, marks, feed, topic, projectionRows,
    get records() { return records },
    setList(run: () => Promise<Result<ChannelList>>) { api.listChannels = run },
    setMark(run: UnreadApi['markRead']) { api.markRead = run },
    async baseline(asOfSeq: number, readSeq: number, mainCount: number, count: number) {
      channelRow = row({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: asOfSeq, read_seq: readSeq, main_unread_count: mainCount, unread_count: count })
      await unread.refresh()
    },
    async boot(messages: Message[] = [msg(1)]) {
      for (const id of ['T', 'U']) baselines.set(id, { asOfSeq: 0, summary: summary(id, 0, 0, 0) })
      state = { ...state, running: true, connected: true, channels: { A: { state: 'ready', watched: true, mutationSeq: 0, cursor: 0,
        messages: [], versions: {}, retiredVersions: [], versionEpoch: 0, advancing: [], pending: [], hasOlder: false, historyError: false, fillAttempt: 0 } } }
      capture(() => listeners.forEach(l => l())); await flush()
      feed(messages); await flush()
    },
    async enter(topicId: string | null = null) {
      unread.visibility(true)
      const id = await unread.enter({ channel: 'A', topicId }); await flush(); return id!
    },
    async present(id: symbol, seqs: number[]) { unread.presented(id, seqs); await flush() },
    snapshot() {
      const { generation: _generation, entry, ...rest } = unread.get('A')
      return { ...rest, entry: entry && { ...entry, id: undefined } }
    },
    close() { unread.close() },
  }
}
export type RetentionClient = ReturnType<typeof retentionClient>
export const held = <T>() => {
  let resolve!: (result: Result<T>) => void
  const promise = new Promise<Result<T>>(r => { resolve = r })
  return { promise, resolve }
}
