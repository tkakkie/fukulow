import { mount, unmount, type Component } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { repliesAdapter } from './replies.svelte'
import ReplyPanel from './ReplyPanel.svelte'
import { createSession } from './session'
import { buttonsByText, installMiniDom, MiniDomEvent } from './svelte-dom-test-helpers'
import { syncAdapter } from './sync.svelte'
import Timeline from './Timeline.svelte'
import * as timelineFrame from './TimelineFrame.svelte'
import { replyPage } from './topic-test-helpers'
import { topicsAdapter } from './topics.svelte'
import TopicView from './TopicView.svelte'
import { unreadAdapter } from './unread.svelte'

const dom = installMiniDom()

function nonSvelteClasses(el: { getAttribute(name: string): string | null } | null): string[] {
  const raw = el?.getAttribute('class') ?? ''
  return raw
    .split(/\s+/)
    .filter((cls) => cls.length > 0 && !cls.startsWith('svelte-'))
}

function allElements(root: ReturnType<typeof dom.doc.createElement>) {
  const out: ReturnType<typeof dom.doc.createElement>[] = []
  const stack = [...root.children]
  while (stack.length > 0) {
    const el = stack.pop()!
    out.push(el)
    stack.push(...el.children)
  }
  return out
}

function expectNoTimelineFrameClass(host: ReturnType<typeof dom.doc.createElement>) {
  const leaked = allElements(host).filter((el) =>
    nonSvelteClasses(el).some((cls) => cls.startsWith('timeline-frame')),
  )
  expect(leaked).toHaveLength(0)
}

function unpinScroll(scrollEl: ReturnType<typeof dom.doc.createElement>) {
  scrollEl.clientHeight = 400
  scrollEl.scrollHeight = 2000
  scrollEl.scrollTop = 0
  scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
}

async function bootSession(
  net: ReturnType<typeof fakeNetwork>,
  channelId = 'A',
  caughtUpSeq = 1,
  opts: { holdUnreadList?: boolean } = {},
) {
  const historyGen = record(1, channelId).history_generation
  const options = net.options('me')
  if (opts.holdUnreadList && options.unreadApi) {
    options.unreadApi = {
      ...options.unreadApi,
      listChannels: () => new Promise(() => {}),
    }
  }
  const session = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: vi.fn(), ...options })
  net.lists[0].resolve(ok({ history_generation: historyGen, channels: [channel(channelId)] }))
  net.socket.onReady()
  await settle()
  net.subscribed(channelId, caughtUpSeq)
  await settle()
  return session
}

async function expectLoadErrorSuppressed<Props extends Record<string, unknown>>(
  view: Component<Props>,
  props: Props,
  message: string,
) {
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const state = $state({ organizationUnavailable: true })
  const frame = vi.spyOn(timelineFrame, 'default')
  try {
    const instance = mount(view, {
      target: host as unknown as Element,
      props: { ...props, get organizationUnavailable() { return state.organizationUnavailable } },
    })
    try {
      await settle()
      expect(host.textContent).toContain('この組織は利用できません。')
      expect(host.textContent).not.toContain(message)
      expect(frame.mock.lastCall?.[1]).toHaveProperty('loadErrorMessage', null)

      state.organizationUnavailable = false
      await settle()
      expect(frame.mock.lastCall?.[1]).toHaveProperty('loadErrorMessage', message)
      expect(host.textContent).toContain(message)
    } finally {
      await unmount(instance)
    }
  } finally {
    frame.mockRestore()
    host.remove()
  }
}

describe('Timeline via TimelineFrame (#1127)', () => {
  it('withholds Timeline loadErrorMessage from TimelineFrame when the Organization is unavailable', async () => {
    const net = fakeNetwork()
    net.pages.A = { ok: false, kind: 'network' }
    const session = await bootSession(net, 'A', 0)
    try {
      await expectLoadErrorSuppressed(Timeline, {
        channel: syncAdapter(session.sync).channel('A'),
        channelId: 'A',
        selfId: 'me',
      }, 'メッセージを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
    } finally {
      session.close()
    }
  })

  it('renders .timeline-* classes, no timeline-frame* class, positioning overlay, scroll container, older control, 新着 n件 ↓, Composer slot and ReplaceDraftDialog', async () => {
    const net = fakeNetwork()
    const m1 = { ...record(10, 'A'), sender: 'other', body: '既存メッセージ' }
    net.pages.A = ok({
      history_generation: m1.history_generation,
      as_of_seq: 10,
      messages: [m1],
      has_more: true,
    })
    net.timelines.A = ok({
      history_generation: m1.history_generation,
      as_of_seq: 10,
      has_more: true,
      items: [{ kind: 'message', message: m1 }],
    })
    const session = await bootSession(net, 'A', 10, { holdUnreadList: true })
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    try {
      const ch = syncAdapter(session.sync).channel('A')
      const topics = topicsAdapter(session.topics, 'A')
      const unread = unreadAdapter(session.unread, 'A')

      // 1. Positioning + reconnecting + older + composer placement through real Timeline props
      const inst1 = mount(Timeline, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          topics,
          unread,
          channelId: 'A',
          selfId: 'me',
          reconnecting: true,
        },
      })
      try {
        await settle()
        const root = host.children[0]
        expect(root.tagName).toBe('SECTION')
        expect(root.getAttribute('aria-label')).toBe('タイムライン')
        expect(nonSvelteClasses(root)).toEqual(['timeline-section'])
        expectNoTimelineFrameClass(host)

        const banner = host.querySelector('.timeline-section__banner')
        expect(nonSvelteClasses(banner)).toEqual(['timeline-section__banner'])
        expect(banner?.parentElement).toBe(root)
        expect(banner?.textContent).toContain('再接続しています…')
        expect(banner?.querySelector('.ui-status-banner__message')?.getAttribute('role')).toBeNull()

        const positioning = host.querySelector('.timeline-positioning')
        expect(nonSvelteClasses(positioning)).toEqual(['timeline-positioning'])
        expect(positioning?.parentElement).toBe(root)
        expect(positioning?.querySelector('[aria-label="メッセージを読み込み中"]')).not.toBeNull()

        const scroll = host.querySelector('.timeline-scroll')
        expect(nonSvelteClasses(scroll)).toEqual(['timeline-scroll', 'timeline-scroll--positioning'])
        expect(scroll?.parentElement).toBe(root)
        expect(scroll?.getAttribute('aria-busy')).toBe('true')
        expect(scroll?.hasAttribute('inert')).toBe(true)

        const older = host.querySelector('.timeline-older')
        expect(nonSvelteClasses(older)).toEqual(['timeline-older'])
        expect(older?.parentElement).toBe(scroll)
        const olderBtn = buttonsByText(host, '以前のメッセージを読み込む')[0]
        expect(olderBtn).toBeDefined()
        expect(olderBtn.parentElement).toBe(older)
        const loadOlderSpy = vi.spyOn(topics, 'loadMain')
        olderBtn.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(loadOlderSpy).toHaveBeenCalledTimes(1)

        const composer = host.querySelector('.timeline-composer')
        expect(nonSvelteClasses(composer)).toEqual(['timeline-composer'])
        expect(composer?.parentElement).toBe(root)
        expect(composer?.querySelector('textarea')).not.toBeNull()
      } finally {
        await unmount(inst1)
      }

      // 2. Unpinned 新着 n件 ↓ and ReplaceDraftDialog through real Timeline props
      const inst2 = mount(Timeline, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          channelId: 'A',
          selfId: 'me',
        },
      })
      try {
        await settle()
        const root = host.children[0]
        const scroll = host.querySelector('.timeline-scroll')!
        unpinScroll(scroll)
        await settle()

        const m2 = { ...record(11, 'A'), sender: 'other', body: '新着メッセージ' }
        net.event({ type: 'message', kind: 'create', seq: m2.created_seq, message: m2 })
        await settle()
        const newBelow = host.querySelector('.timeline-new-below')
        expect(nonSvelteClasses(newBelow)).toEqual(['timeline-new-below'])
        expect(newBelow?.parentElement).toBe(root)
        const newerBtn = buttonsByText(host, '新着 1件 ↓')[0]
        expect(newerBtn).toBeDefined()
        expect(newerBtn.parentElement).toBe(newBelow)
        newerBtn.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(buttonsByText(host, '新着 1件 ↓')).toHaveLength(0)

        // Reset scroll geometry so VirtualRows keeps the newly appended pending row mounted
        scroll.scrollHeight = 400
        scroll.scrollTop = 0
        scroll.dispatchEvent(new MiniDomEvent('scroll'))
        await settle()

        // Refused send + non-empty draft -> ReplaceDraftDialog
        const sending = ch.send('失敗した送信')
        await settle()
        ch.setDraft('入力中の下書き')
        net.sends[0].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_body' })
        await sending
        await settle()

        buttonsByText(host, '編集して送り直す')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(host.textContent).toContain('入力中の下書きを置き換えますか？')
        expect(host.textContent).toContain('入力中の下書きを破棄して、送信できなかったメッセージを入力欄に戻します。')
        buttonsByText(host, 'キャンセル')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(host.textContent).not.toContain('入力中の下書きを置き換えますか？')
        expect(ch.composer.draft).toBe('入力中の下書き')

        buttonsByText(host, '編集して送り直す')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        buttonsByText(host, '置き換える')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(ch.composer.draft).toBe('失敗した送信')
        expectNoTimelineFrameClass(host)
      } finally {
        await unmount(inst2)
      }
    } finally {
      session.close()
    }
  })

  it('renders load error, C9 and C10 banners with C10 > C9 precedence and wires view banner callbacks', async () => {
    const net = fakeNetwork()
    net.pages.A = { ok: false, kind: 'network' }
    const session = await bootSession(net, 'A', 0)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const ongoToChannelList = vi.fn()
    const onrecheckmembership = vi.fn()
    const onswitchorganization = vi.fn()
    try {
      const ch = syncAdapter(session.sync).channel('A')

      // 1. Load error only + retry callback
      const inst1 = mount(Timeline, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          channelId: 'A',
          selfId: 'me',
          ongoToChannelList,
          onrecheckmembership,
          onswitchorganization,
        },
      })
      try {
        await settle()
        expect(host.textContent).toContain('メッセージを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
        const historyBefore = net.history.length
        buttonsByText(host, '再試行')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(net.history.length).toBeGreaterThan(historyBefore)

        // 2. C9 banner + ongoToChannelList callback (Timeline gates loadErrorMessage on !targetUnavailable)
        net.pages.A = { ok: false, kind: 'http', status: 404, error: 'channel_not_found' }
        buttonsByText(host, '再試行')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(host.textContent).toContain('このチャンネルは利用できません。')
        expect(host.textContent).toContain('アクセス権がないか、削除された可能性があります。')
        buttonsByText(host, 'チャンネル一覧へ')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        expect(ongoToChannelList).toHaveBeenCalledTimes(1)
      } finally {
        await unmount(inst1)
      }

      // 3. C10 wins over C9 + onrecheckmembership / onswitchorganization callbacks
      const inst2 = mount(Timeline, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          channelId: 'A',
          selfId: 'me',
          organizationUnavailable: true,
          ongoToChannelList,
          onrecheckmembership,
          onswitchorganization,
        },
      })
      try {
        await settle()
        expect(host.textContent).toContain('この組織は利用できません。')
        expect(host.textContent).not.toContain('このチャンネルは利用できません。')
        buttonsByText(host, 'メンバー資格を再確認')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        expect(onrecheckmembership).toHaveBeenCalledTimes(1)
        buttonsByText(host, '組織を切り替える')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        expect(onswitchorganization).toHaveBeenCalledTimes(1)
        expectNoTimelineFrameClass(host)
      } finally {
        await unmount(inst2)
      }
    } finally {
      session.close()
    }
  })
})

describe('TopicView via TimelineFrame (#1127)', () => {
  it('withholds TopicView loadErrorMessage from TimelineFrame when the Organization is unavailable', async () => {
    const net = fakeNetwork()
    net.topicSummaries['A:T'] = { ok: false, kind: 'network' }
    const session = await bootSession(net, 'A', 0)
    try {
      await expectLoadErrorSuppressed(TopicView, {
        channel: syncAdapter(session.sync).channel('A'),
        topics: topicsAdapter(session.topics, 'A'),
        channelId: 'A',
        topicId: 'T',
        topicName: '仕様相談',
        topicStatus: 'error',
        selfId: 'me',
      }, 'トピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
    } finally {
      session.close()
    }
  })

  it('renders .topic-view* classes, no timeline-frame* class, positioning overlay, scroll container, older control, 新着 n件 ↓, Composer slot and ReplaceDraftDialog', async () => {
    const net = fakeNetwork()
    const mainMsg = { ...record(1, 'A'), sender: 'other', body: 'メイン既存' }
    const tm1 = { ...record(10, 'A'), topic_id: 'T', sender: 'other', body: 'トピック既存' }
    net.pages.A = ok({
      history_generation: tm1.history_generation,
      as_of_seq: 10,
      messages: [mainMsg],
      has_more: false,
    })
    net.timelines.A = ok({
      history_generation: tm1.history_generation,
      as_of_seq: 10,
      has_more: false,
      items: [{ kind: 'message', message: mainMsg }],
    })
    net.topicLists.A = ok({
      history_generation: tm1.history_generation,
      as_of_seq: 10,
      has_more: false,
      topics: [],
    })
    net.topicSummaries['A:T'] = new Promise(() => {}) as never
    net.topicMessages['A:T'] = ok({
      history_generation: tm1.history_generation,
      as_of_seq: 10,
      messages: [tm1],
      has_more: true,
    })
    const session = await bootSession(net, 'A', 10)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    try {
      const ch = syncAdapter(session.sync).channel('A')
      const topics = topicsAdapter(session.topics, 'A')
      const unread = unreadAdapter(session.unread, 'A')

      // 1. Positioning + reconnecting + older + composer placement through real TopicView props
      const inst1 = mount(TopicView, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          topics,
          unread,
          channelId: 'A',
          topicId: 'T',
          topicName: '仕様相談',
          selfId: 'me',
          reconnecting: true,
        },
      })
      try {
        await settle()
        const root = host.children[0]
        expect(root.tagName).toBe('SECTION')
        expect(root.getAttribute('aria-label')).toBe('トピックタイムライン')
        expect(nonSvelteClasses(root)).toEqual(['topic-view'])
        expectNoTimelineFrameClass(host)

        const banner = host.querySelector('.topic-view__banner')
        expect(nonSvelteClasses(banner)).toEqual(['topic-view__banner'])
        expect(banner?.parentElement).toBe(root)
        expect(banner?.textContent).toContain('再接続しています…')
        expect(banner?.querySelector('.ui-status-banner__message')?.getAttribute('role')).toBeNull()

        const positioning = host.querySelector('.topic-view__positioning')
        expect(nonSvelteClasses(positioning)).toEqual(['topic-view__positioning'])
        expect(positioning?.parentElement).toBe(root)
        expect(positioning?.querySelector('[aria-label="トピックを読み込み中"]')).not.toBeNull()

        const scroll = host.querySelector('.topic-view__scroll')
        expect(nonSvelteClasses(scroll)).toEqual(['topic-view__scroll', 'topic-view__scroll--positioning'])
        expect(scroll?.parentElement).toBe(root)
        expect(scroll?.getAttribute('aria-busy')).toBe('true')
        expect(scroll?.hasAttribute('inert')).toBe(true)

        const older = host.querySelector('.topic-view__older')
        expect(nonSvelteClasses(older)).toEqual(['topic-view__older'])
        expect(older?.parentElement).toBe(scroll)
        const olderBtn = buttonsByText(host, '以前のメッセージを読み込む')[0]
        expect(olderBtn).toBeDefined()
        expect(olderBtn.parentElement).toBe(older)
        const topicHistoryBefore = net.topicHistory.length
        olderBtn.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(net.topicHistory.length).toBeGreaterThan(topicHistoryBefore)

        const composer = host.querySelector('.topic-view__composer')
        expect(nonSvelteClasses(composer)).toEqual(['topic-view__composer'])
        expect(composer?.parentElement).toBe(root)
        expect(composer?.querySelector('textarea')?.getAttribute('placeholder')).toBe('トピックにメッセージを入力')
      } finally {
        await unmount(inst1)
      }

      // 2. Unpinned 新着 n件 ↓ and ReplaceDraftDialog through real TopicView props
      const inst2 = mount(TopicView, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          topics,
          channelId: 'A',
          topicId: 'T',
          topicName: '仕様相談',
          selfId: 'me',
        },
      })
      try {
        await settle()
        const root = host.children[0]
        const scroll = host.querySelector('.topic-view__scroll')!
        unpinScroll(scroll)
        await settle()

        const tm2 = { ...record(11, 'A'), topic_id: 'T', sender: 'other', body: 'トピック新着' }
        net.event({ type: 'message', kind: 'create', seq: tm2.created_seq, message: tm2 })
        await settle()
        const newBelow = host.querySelector('.topic-view__new-below')
        expect(nonSvelteClasses(newBelow)).toEqual(['topic-view__new-below'])
        expect(newBelow?.parentElement).toBe(root)
        const newerBtn = buttonsByText(host, '新着 1件 ↓')[0]
        expect(newerBtn).toBeDefined()
        expect(newerBtn.parentElement).toBe(newBelow)
        newerBtn.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(buttonsByText(host, '新着 1件 ↓')).toHaveLength(0)

        scroll.scrollHeight = 400
        scroll.scrollTop = 0
        scroll.dispatchEvent(new MiniDomEvent('scroll'))
        await settle()

        // Refused send + non-empty Topic draft -> ReplaceDraftDialog
        const tc = ch.topic('T')
        const sending = ch.send('失敗したトピック送信', { topic_name: '仕様相談' })
        await settle()
        tc.setDraft('トピック下書き')
        net.sends[0].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_body' })
        await sending
        await settle()

        buttonsByText(host, '編集して送り直す')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(host.textContent).toContain('入力中の下書きを置き換えますか？')
        expect(host.textContent).toContain('入力中の下書きを破棄して、送信できなかったメッセージを入力欄に戻します。')
        buttonsByText(host, 'キャンセル')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(host.textContent).not.toContain('入力中の下書きを置き換えますか？')
        expect(tc.composer.draft).toBe('トピック下書き')

        buttonsByText(host, '編集して送り直す')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        buttonsByText(host, '置き換える')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(tc.composer.draft).toBe('失敗したトピック送信')
        expectNoTimelineFrameClass(host)
      } finally {
        await unmount(inst2)
      }
    } finally {
      session.close()
    }
  })

  it('renders load error, C9 and C10 banners with C10 > C9 precedence and wires view banner callbacks', async () => {
    const net = fakeNetwork()
    const m1 = record(1, 'A')
    net.pages.A = ok({ history_generation: m1.history_generation, as_of_seq: 1, messages: [m1], has_more: false })
    net.topicSummaries['A:T'] = ok({
      history_generation: m1.history_generation,
      as_of_seq: 1,
      topic: {
        mention_unread_count: 0,
        id: 'T',
        name: '仕様相談',
        first_seq: 1,
        last_seq: 1,
        message_count: 1,
        latest_message: { ...m1, topic_id: 'T' },
        read_seq: 1,
        unread_count: 0,
      },
    })
    net.topicMessages['A:T'] = { ok: false, kind: 'network' }
    const session = await bootSession(net, 'A', 1)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const ongoToChannelList = vi.fn()
    const onrecheckmembership = vi.fn()
    const onswitchorganization = vi.fn()
    try {
      const ch = syncAdapter(session.sync).channel('A')
      const topics = topicsAdapter(session.topics, 'A')

      // 1. Load error only + retry callback
      const inst1 = mount(TopicView, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          topics,
          channelId: 'A',
          topicId: 'T',
          topicName: '仕様相談',
          selfId: 'me',
          ongoToChannelList,
          onrecheckmembership,
          onswitchorganization,
        },
      })
      try {
        await settle()
        expect(host.textContent).toContain('トピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
        const topicHistoryBefore = net.topicHistory.length
        buttonsByText(host, '再試行')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(net.topicHistory.length).toBeGreaterThan(topicHistoryBefore)

        // 2. C9 banner + ongoToChannelList callback (TopicView gates loadErrorMessage on !targetUnavailable)
        net.event({ type: 'channel_access_lost', channel_id: 'A' })
        await settle()
        expect(host.textContent).toContain('このチャンネルは利用できません。')
        expect(host.textContent).toContain('アクセス権がないか、削除された可能性があります。')
        buttonsByText(host, 'チャンネル一覧へ')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        expect(ongoToChannelList).toHaveBeenCalledTimes(1)
      } finally {
        await unmount(inst1)
      }

      // 3. C10 wins over C9 + onrecheckmembership / onswitchorganization callbacks
      const inst2 = mount(TopicView, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          topics,
          channelId: 'A',
          topicId: 'T',
          topicName: '仕様相談',
          selfId: 'me',
          organizationUnavailable: true,
          ongoToChannelList,
          onrecheckmembership,
          onswitchorganization,
        },
      })
      try {
        await settle()
        expect(host.textContent).toContain('この組織は利用できません。')
        expect(host.textContent).not.toContain('このチャンネルは利用できません。')
        buttonsByText(host, 'メンバー資格を再確認')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        expect(onrecheckmembership).toHaveBeenCalledTimes(1)
        buttonsByText(host, '組織を切り替える')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        expect(onswitchorganization).toHaveBeenCalledTimes(1)
        expectNoTimelineFrameClass(host)
      } finally {
        await unmount(inst2)
      }
    } finally {
      session.close()
    }
  })
})

describe('ReplyPanel via TimelineFrame (#1127)', () => {
  it('withholds ReplyPanel loadErrorMessage from TimelineFrame when the Organization is unavailable', async () => {
    const net = fakeNetwork()
    const root = record(1, 'A')
    net.pages.A = ok({ history_generation: root.history_generation, as_of_seq: 1, messages: [root], has_more: false })
    net.replyChains[`A:${root.id}`] = { ok: false, kind: 'network' }
    const session = await bootSession(net, 'A', 1)
    try {
      const replies = repliesAdapter(session.replies, 'A')
      await replies.open(root)
      await expectLoadErrorSuppressed(ReplyPanel, {
        channel: syncAdapter(session.sync).channel('A'),
        replies,
        channelId: 'A',
        anchorMessageId: root.id,
        resolvedAnchor: root,
        selfId: 'me',
      }, '返信のつながりを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
    } finally {
      session.close()
    }
  })

  it('renders .reply-panel* classes, no timeline-frame* class, header, direct-child older button, 新着 n件 ↓, Composer slot, custom ReplaceDraftDialog and never advances read positions', async () => {
    const net = fakeNetwork()
    const rootMsg = { ...record(1, 'A'), id: 'root-1', sender: 'other', body: '親メッセージ' }
    const anchorReply = {
      ...record(100, 'A'),
      id: 'reply-100',
      sender: 'other',
      reply_to: 'root-1',
      reply_root_id: 'root-1',
      body: 'アンカー返信',
    }
    net.pages.A = ok({
      history_generation: rootMsg.history_generation,
      as_of_seq: 100,
      messages: [rootMsg, anchorReply],
      has_more: false,
    })
    net.unreadChannels.A = {
      ...channel('A'),
      history_generation: rootMsg.history_generation,
      as_of_seq: 100,
      read_seq: 99,
      unread_count: 1,
      main_unread_count: 1,
      mention_unread_count: 0,
      main_mention_unread_count: 0,
    }
    net.replyChains['A:reply-100'] = ok(
      replyPage({
        history_generation: rootMsg.history_generation,
        as_of_seq: 100,
        root_id: 'root-1',
        messages: [anchorReply],
        has_more: false,
      }),
    )
    net.replyChains['A:root-1'] = ok(
      replyPage({
        history_generation: rootMsg.history_generation,
        as_of_seq: 100,
        root_id: 'root-1',
        messages: [rootMsg, anchorReply],
        has_more: false,
      }),
    )
    const session = await bootSession(net, 'A', 100)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    try {
      const ch = syncAdapter(session.sync).channel('A')
      const topics = topicsAdapter(session.topics, 'A')
      const replies = repliesAdapter(session.replies, 'A')
      await replies.open(anchorReply)
      // Opening the panel leaves the main timeline's Unread visit active.
      session.unread.visibility(true)
      await session.unread.enter({ channel: 'A', topicId: null })
      await settle()

      const inst = mount(ReplyPanel, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          replies,
          topics,
          channelId: 'A',
          anchorMessageId: anchorReply.id,
          resolvedAnchor: anchorReply,
          selfId: 'me',
        },
      })
      try {
        await settle()
        const root = host.children[0]
        expect(root.tagName).toBe('DIV')
        expect(nonSvelteClasses(root)).toEqual(['reply-panel'])
        expectNoTimelineFrameClass(host)

        const header = host.querySelector('.reply-panel__header')
        expect(nonSvelteClasses(header)).toEqual(['reply-panel__header'])
        expect(header?.parentElement).toBe(root)
        expect(header?.querySelector('.reply-panel__actions')).not.toBeNull()

        const scroll = host.querySelector('.reply-panel__scroll')!
        expect(nonSvelteClasses(scroll)).toEqual(['reply-panel__scroll'])
        expect(scroll.parentElement).toBe(root)

        // ReplyPanel's 以前の返信を読み込む stays a direct child of the scroll container
        const olderBtn = buttonsByText(host, '以前の返信を読み込む')[0]
        expect(olderBtn).toBeDefined()
        expect(olderBtn.parentElement).toBe(scroll)
        const replyHistoryBefore = net.replyHistory.length
        olderBtn.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(net.replyHistory.length).toBeGreaterThan(replyHistoryBefore)

        const composer = host.querySelector('.reply-panel__composer')
        expect(nonSvelteClasses(composer)).toEqual(['reply-panel__composer'])
        expect(composer?.parentElement).toBe(root)
        expect(composer?.querySelector('textarea')?.getAttribute('placeholder')).toBe('返信を入力')

        // Unpinned 新着 n件 ↓
        unpinScroll(scroll)
        await settle()
        const r101 = {
          ...record(101, 'A'),
          id: 'reply-101',
          sender: 'other',
          reply_to: 'root-1',
          reply_root_id: 'root-1',
          body: '新着返信',
        }
        net.event({ type: 'message', kind: 'create', seq: r101.created_seq, message: r101 })
        await settle()
        const newBelow = host.querySelector('.reply-panel__new-below')
        expect(nonSvelteClasses(newBelow)).toEqual(['reply-panel__new-below'])
        expect(newBelow?.parentElement).toBe(root)
        const newerBtn = buttonsByText(host, '新着 1件 ↓')[0]
        expect(newerBtn).toBeDefined()
        expect(newerBtn.parentElement).toBe(newBelow)
        newerBtn.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(buttonsByText(host, '新着 1件 ↓')).toHaveLength(0)

        scroll.scrollHeight = 400
        scroll.scrollTop = 0
        scroll.dispatchEvent(new MiniDomEvent('scroll'))
        await settle()
        expect(net.markReads).toHaveLength(0)

        // Refused reply send + non-empty reply draft -> ReplaceDraftDialog with ReplyPanel description
        const rc = ch.reply('root-1', null)
        rc.setDraft('失敗した返信')
        const sending = rc.submit(anchorReply.id)
        await settle()
        rc.setDraft('返信の下書き')
        net.sends[0].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
        await sending
        await settle()

        buttonsByText(host, '編集して送り直す')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(host.textContent).toContain('入力中の下書きを置き換えますか？')
        expect(host.textContent).toContain('失敗したメッセージを編集欄に戻すと、現在入力中の下書きは上書きされます。')
        buttonsByText(host, 'キャンセル')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(host.textContent).not.toContain('入力中の下書きを置き換えますか？')
        expect(rc.composer.draft).toBe('返信の下書き')

        buttonsByText(host, '編集して送り直す')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        buttonsByText(host, '置き換える')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(rc.composer.draft).toBe('失敗した返信')

        expectNoTimelineFrameClass(host)
      } finally {
        await unmount(inst)
      }
    } finally {
      session.close()
    }
  })

  it('renders load error, C9 (replyPanel variant) and C10 banners inside .reply-panel__header with C10 > C9 precedence and wires callbacks', async () => {
    const net = fakeNetwork()
    const rootMsg = { ...record(1, 'A'), id: 'root-1', sender: 'other', body: '親メッセージ' }
    net.pages.A = ok({
      history_generation: rootMsg.history_generation,
      as_of_seq: 1,
      messages: [rootMsg],
      has_more: false,
    })
    net.replyChains['A:root-1'] = { ok: false, kind: 'network' }
    const session = await bootSession(net, 'A', 1, { holdUnreadList: true })
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const ongoToChannelList = vi.fn()
    const onrecheckmembership = vi.fn()
    const onswitchorganization = vi.fn()
    try {
      const ch = syncAdapter(session.sync).channel('A')
      const replies = repliesAdapter(session.replies, 'A')
      await replies.open(rootMsg)

      // 1. Load error inside .reply-panel__header + retry callback
      const inst1 = mount(ReplyPanel, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          replies,
          channelId: 'A',
          anchorMessageId: rootMsg.id,
          resolvedAnchor: rootMsg,
          selfId: 'me',
          ongoToChannelList,
          onrecheckmembership,
          onswitchorganization,
        },
      })
      try {
        await settle()
        const header = host.querySelector('.reply-panel__header')
        const banner = host.querySelector('.reply-panel__banner')
        expect(nonSvelteClasses(banner)).toEqual(['reply-panel__banner'])
        expect(banner?.parentElement).toBe(header)
        expect(host.textContent).toContain('返信のつながりを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
        const replyHistoryBefore = net.replyHistory.length
        buttonsByText(host, '再試行')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        await settle()
        expect(net.replyHistory.length).toBeGreaterThan(replyHistoryBefore)

        // 2. C9 with replyPanel variant + ongoToChannelList callback (ReplyPanel gates loadErrorMessage on !targetUnavailable)
        net.event({ type: 'channel_access_lost', channel_id: 'A' })
        await settle()
        expect(host.textContent).toContain('このチャンネルは利用できません。')
        expect(host.textContent).toContain(
          'チャンネルが削除されたか、アクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。',
        )
        buttonsByText(host, 'チャンネル一覧へ')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        expect(ongoToChannelList).toHaveBeenCalledTimes(1)
      } finally {
        await unmount(inst1)
      }

      // 3. C10 wins over C9 + onrecheckmembership / onswitchorganization callbacks
      const inst2 = mount(ReplyPanel, {
        target: host as unknown as Element,
        props: {
          channel: ch,
          replies,
          channelId: 'A',
          anchorMessageId: rootMsg.id,
          resolvedAnchor: rootMsg,
          selfId: 'me',
          organizationUnavailable: true,
          ongoToChannelList,
          onrecheckmembership,
          onswitchorganization,
        },
      })
      try {
        await settle()
        const header = host.querySelector('.reply-panel__header')
        const banner = host.querySelector('.reply-panel__banner')
        expect(banner?.parentElement).toBe(header)
        expect(host.textContent).toContain('この組織は利用できません。')
        expect(host.textContent).not.toContain('このチャンネルは利用できません。')
        buttonsByText(host, 'メンバー資格を再確認')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        expect(onrecheckmembership).toHaveBeenCalledTimes(1)
        buttonsByText(host, '組織を切り替える')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
        expect(onswitchorganization).toHaveBeenCalledTimes(1)
        expectNoTimelineFrameClass(host)
      } finally {
        await unmount(inst2)
      }
    } finally {
      session.close()
    }
  })
})
