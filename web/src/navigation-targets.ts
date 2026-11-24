import type { Message, Result, TopicSummaryResponse, ReplyChainPage } from './api'
import type { NavigationTarget } from './navigation-url'
import { createRequestDeadlines } from './request-deadlines'

type TargetState = { status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; name: string; targetId?: string; anchor?: Message }
const idle: TargetState = { status: 'idle', name: '' }
type Reads = {
  topic(channel: string, topic: string): Promise<Result<TopicSummaryResponse>>
  reply(channel: string, message: string): Promise<Result<ReplyChainPage>>
  channelUnavailable(channel: string): void
}

/** Resolves URL hints without rendering Topic/Reply content, owned/fenced by the Organization session. */
export function createNavigationTargets(reads: Reads) {
  let state = { topic: idle, reply: idle }
  let generation = 0
  let key = ''
  let currentTarget: NavigationTarget | undefined
  let closed = false
  const deadlines = createRequestDeadlines()
  const listeners = new Set<() => void>()
  const publish = () => listeners.forEach(listener => listener())
  function bounded<T>(read: Promise<Result<T>>): Promise<Result<T>> {
    return deadlines.wait(read, { ok: false, kind: 'network' }, { timeoutMs: 10_000 })
  }
  async function load(target: NavigationTarget, retry = false) {
    currentTarget = target
    const nextKey = JSON.stringify([target.channelId, target.topicId, target.panel?.startsWith('reply:') ? target.panel : null])
    if (closed || (!retry && nextKey === key)) return
    key = nextKey
    const mine = ++generation
    const channel = target.channelId
    const reply = target.panel?.startsWith('reply:') ? target.panel.slice(6) : null
    state = {
      topic: channel && target.topicId ? { status: 'loading', name: '' } : idle,
      reply: channel && reply ? { status: 'loading', name: '', targetId: reply } : idle,
    }
    publish()
    if (!channel) return
    const apply = (slot: 'topic' | 'reply', result: Result<unknown>, name: string) => {
      if (closed || mine !== generation) return
      const unavailable = !result.ok && result.kind === 'http' && (result.status === 403 || result.status === 404)
      // Resource-not-found affects this hint only; Channel/Organization denial keeps C9/C10 semantics.
      if (unavailable && result.error !== 'topic_not_found' && result.error !== 'reply_chain_not_found' && result.error !== 'organization_unavailable') reads.channelUnavailable(channel)
      const anchor =
        slot === 'reply' && result.ok
          ? ((result.data as ReplyChainPage).messages.find(m => m.id === reply) ??
              (result.data as ReplyChainPage).messages[0])
          : undefined
      state = {
        ...state,
        [slot]: {
          status: result.ok ? 'ready' : unavailable ? 'unavailable' : 'error',
          name,
          ...(slot === 'reply' && reply ? { targetId: reply } : {}),
          ...(anchor ? { anchor } : {}),
        },
      }
      publish()
    }
    await Promise.all([
      target.topicId ? bounded(reads.topic(channel, target.topicId)).then(result => apply('topic', result, result.ok ? result.data.topic.name : '')) : undefined,
      reply ? bounded(reads.reply(channel, reply)).then(result => apply('reply', result, '')) : undefined,
    ])
  }
  return {
    get: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    load,
    resetHistory() {
      generation++; key = ''; deadlines.cancel()
      state = { topic: idle, reply: idle }; publish()
      if (currentTarget) void load(currentTarget)
    },
    close() { closed = true; generation++; deadlines.cancel(); listeners.clear() },
  }
}
