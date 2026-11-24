// Test page for e2e-component/observer-read.spec.ts (#449): the real Timeline in a real layout, with static fakes for
// the Channel sync and Unread sources. Only `presented` calls made inside the row window's IntersectionObserver
// callback advance readSeq, so no other read-update path (scroll handler, effects) can satisfy the test.
import { mount } from 'svelte'
import '../src/app.css'
import type { Message } from '../src/api'
import type { ChannelSync } from '../src/sync.svelte'
import type { UnreadAdapter } from '../src/unread.svelte'
import Timeline from '../src/Timeline.svelte'
import type { ObserverReadProbe } from './observer-read-probe'

const CHANNEL = '00000000-0000-4000-8000-000000000001'
const SELF = '00000000-0000-4000-8000-000000000002'
const OTHER = '00000000-0000-4000-8000-000000000003'
const MESSAGE_COUNT = 200
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const messages: Message[] = Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
  id: uuid(1000 + i), client_message_id: uuid(5000 + i), channel_id: CHANNEL, history_generation: uuid(9),
  created_seq: i + 1, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), deleted: false,
  body: `メッセージ ${i + 1}`, reply_root_id: null, reply_to: null, sender: OTHER, topic_id: null, version: i + 1,
}))

const probe: ObserverReadProbe = { observerSeqs: [], readSeq: 0, otherReports: 0, everMounted: [], scrollEnds: 0 }
Object.assign(globalThis, { observerRead: probe })

// The native observer computes every intersection; the subclass only marks when its callback is running.
let inObserverCallback = 0
const NativeIntersectionObserver = globalThis.IntersectionObserver
globalThis.IntersectionObserver = class extends NativeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    super((entries, observer) => {
      inObserverCallback++
      try { callback(entries, observer) } finally { inObserverCallback-- }
    }, options)
  }
}

// Static state: nothing here changes after mount, so no reactive effect reruns because of a read report.
const visitId = Symbol('visit')
const unreadState: UnreadAdapter['state'] = {
  generation: Symbol('generation'), asOfSeq: MESSAGE_COUNT, unreadCount: MESSAGE_COUNT, mentionUnreadCount: 0,
  main: { position: 0, unreadCount: MESSAGE_COUNT, mentionUnreadCount: 0, stopped: false, error: false },
  topics: {}, stopped: false, error: false,
  entry: { id: visitId, scope: { channel: CHANNEL, topicId: null }, boundary: 0, unreadAtEntry: MESSAGE_COUNT,
    firstUnread: messages[0], needsOlder: false },
}
const unread: UnreadAdapter = {
  get state() { return unreadState },
  enter: async () => visitId,
  leave: () => {},
  visibility: () => {},
  refresh: async () => {},
  presented(visit: symbol, seqs: number[]) {
    if (visit !== visitId) return
    if (inObserverCallback === 0) { probe.otherReports++; return }
    for (const seq of seqs) if (!probe.observerSeqs.includes(seq)) probe.observerSeqs.push(seq)
    probe.readSeq = Math.max(probe.readSeq, ...seqs)
  },
}

const timeline = { status: 'ready' as const, messages, pending: [], hasOlder: false, loadingOlder: false, olderError: false }
const composer = { draft: '', topicDraft: '', composerError: null }
const channel: Pick<ChannelSync, 'timeline' | 'composer' | 'loadLatest' | 'loadOlder' | 'setDraft' | 'setTopicDraft' |
  'submit' | 'retry' | 'restore' | 'discard'> = {
  timeline, composer,
  loadLatest: async () => {}, loadOlder: async () => {}, setDraft: () => {}, setTopicDraft: () => {},
  submit: async () => false, retry: async () => {}, restore: () => false, discard: () => {},
}

const target = document.getElementById('app')!
target.style.height = '720px'
const mounts = new MutationObserver(() => {
  for (const row of target.querySelectorAll<HTMLElement>('[data-confirmed-seq]')) {
    const seq = Number(row.dataset.confirmedSeq)
    if (!probe.everMounted.includes(seq)) probe.everMounted.push(seq)
  }
})
mounts.observe(target, { childList: true, subtree: true })
mount(Timeline, { target, props: { channel: channel as ChannelSync, unread, channelId: CHANNEL, selfId: SELF } })
document.querySelector('.timeline-scroll')!.addEventListener('scrollend', () => { probe.scrollEnds++ })
