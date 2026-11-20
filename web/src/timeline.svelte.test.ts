import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import type * as api from './api'
import { senderName } from './authors'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { searchAnchorAdapter } from './search-anchor.svelte'
import { repliesAdapter } from './replies.svelte'
import ReplyPanel from './ReplyPanel.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import Timeline from './Timeline.svelte'
import TopicView from './TopicView.svelte'
import { topicsAdapter } from './topics.svelte'
import { unreadAdapter } from './unread.svelte'
import MessageRow from './ui/MessageRow.svelte'
import Workspace from './Workspace.svelte'
import { windowClient } from './message-window-test-helpers'
import { replyPage } from './topic-test-helpers'
import { deferred } from './unread-test-helpers'
import { buttonsByText, installMiniDom, MiniDomEvent, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

describe('Timeline, MessageRow and Workspace component states (docs/ui.md §3, §5)', () => {
  it.each(['Timeline', 'TopicView', 'ReplyPanel'] as const)('%s explains an archived send refusal in Japanese', async view => {
    const net = fakeNetwork()
    const message = { ...record(1, 'A'), topic_id: view === 'TopicView' ? 'T' : null }
    net.pages.A = ok({ history_generation: message.history_generation, as_of_seq: 1, messages: [message], has_more: false })
    const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
    net.lists[0].resolve(ok({ history_generation: message.history_generation, channels: [channel('A')] }))
    const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
    try {
      net.socket.onReady()
      await settle()
      net.subscribed('A', 1)
      const channel = syncAdapter(session.sync).channel('A')
      const props = { channel, channelId: 'A', selfId: 'me' }
      const target = host as unknown as Element
      const replies = repliesAdapter(session.replies, 'A')
      if (view === 'ReplyPanel') await replies.open(message)
      const instance = view === 'Timeline' ? mount(Timeline, { target, props })
        : view === 'TopicView' ? mount(TopicView, {
          target, props: { ...props, topics: topicsAdapter(session.topics, 'A'), topicId: 'T', topicName: 'T' },
        }) : mount(ReplyPanel, {
          target, props: { ...props, replies, anchorMessageId: message.id, resolvedAnchor: message },
        })
      try {
        await settle()
        const sending = channel.send('下書き', {
          topic_name: view === 'TopicView' ? 'T' : undefined,
          reply_to: view === 'ReplyPanel' ? message.id : undefined,
        })
        await settle()
        net.sends[0].resolve({ ok: false, kind: 'http', status: 409, error: 'channel_archived' })
        await sending
        await settle()
        expect(host.querySelector('.ui-message-row [role="alert"]')?.textContent)
          .toBe('このチャンネルはアーカイブされているため、送信できません。')
        expect(buttonsByText(host, '再送する')).toHaveLength(0)
      } finally { await unmount(instance) }
    } finally { session.close() }
  })

  it.each([true, false])('keeps the Channel header and overview until the by-id read resolves archived=%s', async archived => {
    vi.useFakeTimers()
    const net = fakeNetwork()
    const options = net.options()
    const active = channel('A', 'general')
    active.capabilities.can_archive = { allowed: true }
    active.capabilities.can_rename = { allowed: true }
    const history_generation = record(1).history_generation
    const getChannelResult = deferred<api.Result<api.Channel>>()
    const getChannel = vi.fn(() => getChannelResult.promise)
    const session = createSession({
      selfId: 'me', organizationId: 'org-1', onEnded: vi.fn(), ...options,
      channelsApi: { ...options.channelsApi!, getChannel },
    })
    net.lists[0].resolve(ok({ history_generation, channels: [active] }))
    const navigation = createNavigation({
      location: { href: 'http://localhost/o/org-1/c/A?panel=overview' },
      history: { state: null, pushState() {}, replaceState() {} },
      innerWidth: 1280, addEventListener() {}, removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
    const instance = mount(Workspace, { target: host as unknown as Element, props: {
      navigation, selectedOrganizationId: 'org-1',
      session: { channels: channelsAdapter(session.channels), sync: syncAdapter(session.sync),
        topics: id => topicsAdapter(session.topics, id), close: session.close },
    } })
    try {
      net.socket.onReady()
      await settle()
      const composer = host.querySelector('main textarea')!
      const archiveButton = buttonsByText(host, 'アーカイブ')[0]
      expect(composer.disabled).toBe(false)
      expect(archiveButton).toBeDefined()

      net.event({ type: 'channel_list_changed' })
      await vi.advanceTimersByTimeAsync(200)
      net.lists.at(-1)!.resolve(ok({ history_generation, channels: [] }))
      await settle()
      await vi.advanceTimersByTimeAsync(1)
      expect(getChannel).toHaveBeenCalledExactlyOnceWith('A', expect.any(AbortSignal))
      expect(host.querySelector('main h1')?.textContent).toContain('general')
      expect(host.querySelector('.channel-overview__name')?.textContent).toContain('general')
      expect(buttonsByText(host, 'アーカイブ')[0]).toBe(archiveButton)
      expect(host.querySelector('main textarea')).toBe(composer)
      expect(composer.disabled).toBe(true)
      expect(host.querySelector('.main-card__notice')?.textContent).toContain('チャンネルの状態を確認しています。')

      getChannelResult.resolve(ok(archived ? { ...active, archived,
        capabilities: { ...active.capabilities, can_rename: { allowed: false, reason: 'channel_archived' } },
      } : active))
      await settle()
      expect(host.querySelector('main h1')?.textContent).toContain('general')
      if (archived) {
        expect(host.querySelector('.main-card__notice')?.textContent).toContain('このチャンネルはアーカイブされています。')
        expect(buttonsByText(host, '復元')).toHaveLength(1)
      } else {
        expect(host.querySelector('.main-card__notice')).toBeNull()
        expect(buttonsByText(host, 'アーカイブ')[0]).toBe(archiveButton)
      }
      expect(composer.disabled).toBe(archived)
    } finally { await unmount(instance); navigation.destroy(); session.close() }
  })
  it.each(['Timeline', 'TopicView', 'ReplyPanel'] as const)('%s reports detached task rejections without leaving them unhandled', async view => {
    const c = windowClient(), report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error(`${view} task failed`)
    try {
      await c.boot()
      const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
      const channel = syncAdapter(c.sync).channel('A')
      if (view === 'Timeline') {
        const topics = topicsAdapter(c.topics, 'A')
        topics.loadMain = vi.fn().mockRejectedValue(failure)
        const instance = mount(Timeline, { target: host as unknown as Element,
          props: { channel, topics, channelId: 'A' } })
        try {
          await settle()
          buttonsByText(host, '以前のメッセージを読み込む')[0].click()
          await settle()
          expect(report).toHaveBeenCalledExactlyOnceWith(failure)
        } finally { await unmount(instance) }
      } else if (view === 'TopicView') {
        const topics = topicsAdapter(c.topics, 'A')
        topics.ensureSummary = vi.fn().mockRejectedValue(failure)
        const instance = mount(TopicView, { target: host as unknown as Element, props: {
          channel, topics, channelId: 'A', topicId: 'T', topicName: 'Topic T',
        } })
        try {
          await settle(); await settle()
          expect(report).toHaveBeenCalledWith(failure)
        } finally { await unmount(instance) }
      } else {
        await c.replies.open('A', c.records[0])
        const replies = repliesAdapter(c.replies, 'A')
        replies.loadMore = vi.fn().mockRejectedValue(failure)
        const instance = mount(ReplyPanel, { target: host as unknown as Element, props: {
          channel, replies, channelId: 'A', anchorMessageId: 'id1', resolvedAnchor: c.records[0],
        } })
        try {
          await settle()
          buttonsByText(host, 'さらに返信を読み込む')[0].click()
          await settle()
          expect(report).toHaveBeenCalledExactlyOnceWith(failure)
        } finally { await unmount(instance) }
      }
    } finally { await c.close(); report.mockRestore() }
  })

  it('windows a thousand pending sends without dropping them and Composer Up mounts the latest confirmed Message', async () => {
    const net = fakeNetwork()
    const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.socket.onReady()
    net.pages.general = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(1, 'general')]).at(-1)?.created_seq ?? 0,  messages: [record(1, 'general')], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('general')] }))
    await settle(); net.subscribed('general', 1); await settle()
    const ch = syncAdapter(session.sync).channel('general')
    const sends = Array.from({ length: 1000 }, (_, n) => ch.send(`未確認 ${n}`))
    await settle()
    const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
    const instance = mount(Timeline, { target: host as unknown as Element,
      props: { channel: ch, channelId: 'general', selfId: 'me' } })
    await settle()
    const scroll = host.querySelector('.timeline-scroll')!
    scroll.clientHeight = 600; scroll.scrollHeight = 116116; scroll.scrollTop = 115516
    scroll.dispatchEvent(new MiniDomEvent('scroll'))
    await settle()
    expect(queryAll(host, '[data-status]').length).toBeLessThan(25)
    expect(host.textContent).toContain('未確認 999')
    expect(ch.timeline.pending).toHaveLength(1000)
    const up = new MiniDomEvent('keydown', { bubbles: true, cancelable: true }); up.key = 'ArrowUp'
    host.querySelector('textarea')!.dispatchEvent(up)
    await settle()
    expect(dom.doc.activeElement?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('id1')
    await unmount(instance); session.close(); await Promise.all(sends)
  })

  it('renders the deactivated sender name and hint as accessible text in the shared Message row', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(MessageRow, { target: host as unknown as Element, props: {
      body: '本文', senderName: senderName({ id: 'author', name: '田中', deactivated: true }),
    } })
    flushSync()
    const label = host.querySelector('.ui-message-row__sender')!
    expect(label.textContent).toBe('田中（無効）')
    expect(label.getAttribute('aria-hidden')).not.toBe('true')
    expect(label.getAttribute('aria-label')).toBeNull()
    await unmount(instance)
  })

  it('shows accessible Japanese throttled status, automatic retry and discard without manual resend or edit', async () => {
    vi.useFakeTimers()
    const net = fakeNetwork()
    const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.socket.onReady()
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    await settle()
    const ch = syncAdapter(session.sync).channel('A')
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Timeline, {
      target: host as unknown as Element,
      props: { channel: ch, channelId: 'A', selfId: 'me', ongoToChannelList: () => {} },
    })
    await settle()
    ch.setDraft('待機中の本文')
    void ch.submit()
    await settle()
    const original = net.sends[0].body
    ch.setDraft('次の下書き')
    net.sends[0].resolve({ ok: false, kind: 'http', status: 429, retryAfterMs: 2000 })
    await settle()
    const copy = '送信が混み合っています。しばらくしてから自動で再送します。'
    expect(host.textContent).toContain('待機中の本文')
    expect(host.textContent).toContain(copy)
    const status = host.querySelector('.ui-message-row__sending')!
    expect(status.textContent).toBe(copy)
    expect(status.getAttribute('aria-hidden')).not.toBe('true')
    expect(status.getAttribute('role')).toBeNull() // own sends add no second live region (§6)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(buttonsByText(host, '再送する')).toHaveLength(0)
    expect(buttonsByText(host, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(host, '破棄')).toHaveLength(1)
    expect(ch.composer.draft).toBe('次の下書き')
    await vi.advanceTimersByTimeAsync(1999)
    expect(net.sends).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(net.sends[1].body).toEqual(original)
    expect(host.textContent).toContain('送信中…')
    expect(host.textContent).not.toContain(copy)
    net.sends[1].resolve({ ok: false, kind: 'http', status: 429, retryAfterMs: 4000 })
    await settle()
    expect(host.textContent).toContain(copy)
    buttonsByText(host, '破棄')[0].click()
    await settle()
    expect(host.textContent).not.toContain('待機中の本文')
    expect(dom.doc.activeElement).toBe(host.querySelector('textarea'))
    expect(ch.composer.draft).toBe('次の下書き')
    await vi.advanceTimersByTimeAsync(5000)
    expect(net.sends).toHaveLength(2)
    await unmount(instance)
    host.remove()
    session.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders no 再送する or 編集して送り直す when target is unavailable and keeps 破棄 working', async () => {
    // 1. Direct MessageRow check across both retryable and refused failed states under targetUnavailable
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    let discarded = 0
    const rowInstance = mount(MessageRow, {
      target: host as unknown as Element,
      props: {
        body: 'ターゲット利用不可の本文',
        pendingStatus: 'failed',
        retryable: true,
        targetUnavailable: true,
        onretry: () => {},
        onrestore: () => {},
        ondiscard: () => {
          discarded++
        },
      },
    })
    flushSync()

    expect(host.textContent).toContain('ターゲット利用不可の本文')
    expect(buttonsByText(host, '再送する')).toHaveLength(0)
    expect(buttonsByText(host, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(host, '破棄')).toHaveLength(1)
    expect(buttonsByText(host, '破棄')[0].disabled).toBe(false)
    buttonsByText(host, '破棄')[0].click()
    flushSync()
    expect(discarded).toBe(1)
    await unmount(rowInstance)
    host.remove()

    // 2. Mounted Timeline check: transition an active Channel with both unknown and refused failed sends into C9
    const net = fakeNetwork()
    const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.socket.onReady()
    net.pages.general = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(1, 'general')]).at(-1)?.created_seq ?? 0,  messages: [record(1, 'general')], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('general', 'general')] }))
    await settle()
    net.subscribed('general', 1)
    await settle()

    const sync = syncAdapter(session.sync)
    const ch = sync.channel('general')

    const pUnknown = ch.send('通信失敗の送信')
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await pUnknown

    const pRefused = ch.send('拒否された送信')
    await settle()
    net.sends[1].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    await pRefused
    await settle()

    const timelineHost = dom.doc.createElement('div')
    dom.doc.body.appendChild(timelineHost)
    const timelineInstance = mount(Timeline, {
      target: timelineHost as unknown as Element,
      props: {
        channel: ch,
        channelId: 'general',
        selfId: 'me',
        ongoToChannelList: () => {},
      },
    })
    flushSync()

    // While Channel is ready, unknown shows 再送する and refused shows 編集して送り直す
    expect(buttonsByText(timelineHost, '再送する')).toHaveLength(1)
    expect(buttonsByText(timelineHost, '編集して送り直す')).toHaveLength(1)
    expect(buttonsByText(timelineHost, '破棄')).toHaveLength(2)

    // Enter C9 Channel unavailable: C9 has チャンネル一覧へ, no 再試行, disabled Composer, and failed rows keep only 破棄
    net.event({ type: 'error', channel_id: 'general', code: 'channel_not_found' })
    await settle()
    flushSync()

    expect(timelineHost.textContent).toContain('このチャンネルは利用できません。')
    expect(buttonsByText(timelineHost, 'チャンネル一覧へ')).toHaveLength(1)
    expect(buttonsByText(timelineHost, '再試行')).toHaveLength(0)
    expect(buttonsByText(timelineHost, '再送する')).toHaveLength(0)
    expect(buttonsByText(timelineHost, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(timelineHost, '破棄')).toHaveLength(2)
    expect(timelineHost.textContent).toContain('通信失敗の送信')
    expect(timelineHost.textContent).toContain('拒否された送信')

    const composerTextarea = timelineHost.querySelector('textarea')!
    expect(composerTextarea.disabled).toBe(true)

    // Clicking 破棄 removes each failed Message
    buttonsByText(timelineHost, '破棄')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(buttonsByText(timelineHost, '破棄')).toHaveLength(1)
    expect(timelineHost.textContent).not.toContain('通信失敗の送信')
    expect(timelineHost.textContent).toContain('拒否された送信')

    await unmount(timelineInstance)

    // 3. C10 organizationUnavailable on Timeline also hides 再送する / 編集して送り直す and keeps 破棄
    const orgHost = dom.doc.createElement('div')
    dom.doc.body.appendChild(orgHost)
    const orgInstance = mount(Timeline, {
      target: orgHost as unknown as Element,
      props: {
        channel: ch,
        channelId: 'general',
        selfId: 'me',
        organizationUnavailable: true,
        ongoToChannelList: () => {},
        onrecheckmembership: () => {},
      },
    })
    flushSync()

    expect(orgHost.textContent).toContain('この組織は利用できません。')
    expect(buttonsByText(orgHost, 'チャンネル一覧へ')).toHaveLength(0)
    expect(buttonsByText(orgHost, '再試行')).toHaveLength(0)
    expect(buttonsByText(orgHost, '再送する')).toHaveLength(0)
    expect(buttonsByText(orgHost, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(orgHost, '破棄')).toHaveLength(1)

    await unmount(orgInstance)
    session.close()
  })

  it('confirms before replacing a non-empty Composer draft on send refused (置き換える / キャンセル)', async () => {
    const net = fakeNetwork()
    const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.socket.onReady()
    net.pages.general = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 0,  messages: [], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('general', 'general')] }))
    await settle()
    net.subscribed('general', 0)
    await settle()

    const sync = syncAdapter(session.sync)
    const ch = sync.channel('general')

    const pRefused = ch.send('拒否されたメッセージ本文')
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    await pRefused

    ch.setDraft('入力途中の大事な下書き')
    await settle()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Timeline, {
      target: host as unknown as Element,
      props: {
        channel: ch,
        channelId: 'general',
        selfId: 'me',
      },
    })
    flushSync()

    const textarea = host.querySelector('textarea')!
    expect(textarea.value).toBe('入力途中の大事な下書き')
    expect(host.querySelector('[role="dialog"]')).toBeNull()

    // 1. Clicking 編集して送り直す with a non-empty draft opens the confirmation dialog without mutating state
    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    await tick()

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('aria-label')).toBe('入力中の下書きを置き換えますか？')
    expect(buttonsByText(dialog!, '置き換える')).toHaveLength(1)
    expect(buttonsByText(dialog!, 'キャンセル')).toHaveLength(1)
    expect(ch.composer.draft).toBe('入力途中の大事な下書き')
    expect(ch.timeline.pending).toHaveLength(1)

    // 2. Clicking キャンセル closes the dialog and preserves both the draft and the failed Message
    buttonsByText(dialog!, 'キャンセル')[0].click()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(ch.composer.draft).toBe('入力途中の大事な下書き')
    expect(textarea.value).toBe('入力途中の大事な下書き')
    expect(ch.timeline.pending).toHaveLength(1)
    expect(buttonsByText(host, '編集して送り直す')).toHaveLength(1)

    // 3. Reopen and click 置き換える: replaces the draft, removes the failed Message, and focuses Composer
    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    const reopened = host.querySelector('[role="dialog"]')!
    buttonsByText(reopened, '置き換える')[0].click()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(ch.composer.draft).toBe('拒否されたメッセージ本文')
    expect(textarea.value).toBe('拒否されたメッセージ本文')
    expect(ch.timeline.pending).toHaveLength(0)
    expect(buttonsByText(host, '編集して送り直す')).toHaveLength(0)
    expect(dom.doc.activeElement).toBe(textarea)

    // 4. Empty Composer draft restores immediately without confirmation, and 破棄 focuses Composer
    ch.setDraft('')
    await settle()
    const pSecond = ch.send('二度目の拒否メッセージ')
    await settle()
    net.sends[1].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    await pSecond
    await settle()
    flushSync()

    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(textarea.value).toBe('二度目の拒否メッセージ')
    expect(dom.doc.activeElement).toBe(textarea)

    ch.setDraft('')
    await settle()
    const pThird = ch.send('破棄するメッセージ')
    await settle()
    net.sends[2].resolve({ ok: false, kind: 'network' })
    await pThird
    await settle()
    flushSync()

    buttonsByText(host, '破棄')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(ch.timeline.pending).toHaveLength(0)
    expect(dom.doc.activeElement).toBe(textarea)

    await unmount(instance)
    session.close()
  })


  it('exposes a roving tabindex="0" MessageRow for Tab entry even when Composer has a draft, and updates roving focus on ArrowUp/ArrowDown/Home/End', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: '1件目' }
    const m2 = { ...record(2, 'c1'), body: '2件目' }
    const m3 = { ...record(3, 'c1'), body: '3件目' }

    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 3,
      has_more: false,
      items: [
        { kind: 'message', message: m1 },
        { kind: 'message', message: m2 },
        { kind: 'message', message: m3 },
      ],
    })
    net.replyChains[`c1:${m2.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([m2]).at(-1)?.created_seq ?? 0,
      root_id: m2.id,
      messages: [m2],
      has_more: false,
    }))

    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 3)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // Non-empty Composer draft: ArrowUp does not leave the Composer, but the timeline has a single roving tabindex="0" row (the latest by default)
    const mainTextarea = host.querySelector('#main-content textarea')!
    mainTextarea.value = '消したくない下書き'
    mainTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    const rows = queryAll(host, '#main-content .ui-message-row[data-focusable="true"]')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])

    // Focus the roving tabindex="0" row (as Tab/Shift+Tab does) and press ArrowUp to move roving focus to m2
    rows[2].focus()
    const upEvt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    upEvt.key = 'ArrowUp'
    rows[2].dispatchEvent(upEvt)
    flushSync()

    expect(dom.doc.activeElement).toBe(rows[1])
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
    expect(mainTextarea.value).toBe('消したくない下書き')

    // Press R on m2 to open its Reply chain while keeping the main Composer draft intact
    const rEvt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    rEvt.key = 'r'
    rows[1].dispatchEvent(rEvt)
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel).not.toBeNull()
    expect(mainTextarea.value).toBe('消したくない下書き')
    const panelRows = queryAll(panel, '.ui-message-row[data-focusable="true"]')
    expect(panelRows).toHaveLength(1)
    expect(panelRows[0].getAttribute('tabindex')).toBe('0')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

})

describe('Search result navigation', () => {
  function openWorkspace(net: ReturnType<typeof fakeNetwork>, options = net.options()) {
    const session = createSession({ ...options, selfId: 'me', organizationId: 'org', onEnded: vi.fn() })
    let href = '/o/org/c/A'
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: { state: null, pushState: (_state: unknown, _title: string, url: string) => { href = url }, replaceState: vi.fn() },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const replies = repliesAdapter(session.replies, 'A', session.replyCounts)
    const topics = topicsAdapter(session.topics, 'A')
    const unread = unreadAdapter(session.unread, 'A')
    const instance = mount(Workspace, { target: host as unknown as Element, props: {
      navigation, selectedOrganizationId: 'org',
      session: { channels: channelsAdapter(session.channels), sync: syncAdapter(session.sync),
        topics: () => topics, replies: () => replies, unread: () => unread,
        navigationTargets: navigationTargetsAdapter(session.navigationTargets),
        searchAnchor: searchAnchorAdapter(session.searchAnchor), close: session.close },
    } })
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: record(1).history_generation, channels: [channel('A')] }))
    return { host, navigation, session, async close() {
      await unmount(instance)
      navigation.destroy()
      session.close()
    } }
  }

  it.each([null, 'T'])('reveals and highlights a search result ahead of normal entry positioning (Topic %s)', async topicId => {
    const net = fakeNetwork()
    const options = net.options()
    const message = (seq: number) => ({ ...record(seq), topic_id: topicId })
    const history_generation = message(1).history_generation
    net.pages.A = ok({ history_generation, as_of_seq: 100, messages: [message(100)], has_more: false })
    const older = deferred<api.Result<api.MessagePage>>()
    const read = async (query?: api.ListMessagesQuery) => query?.before_seq === 4 ? older.promise
      : ok({ history_generation, as_of_seq: 100, messages: query?.after_seq === 3 ? [message(4), message(5), message(6)] : [message(100)], has_more: false })
    options.sync!.api!.listMessages = (_channel, query) => read(query)
    options.topicsApi!.listTopicMessages = (_channel, _topic, query) => read(query)
    const app = openWorkspace(net, options)
    try {
      await settle()
      net.subscribed('A', 100)
      await settle()
      app.navigation.openSearchResult('org', { channelId: 'A', topicId, messageId: 'id4', createdSeq: 4 })
      await settle()
      older.resolve(ok({ history_generation, as_of_seq: 100, messages: [message(1), message(2), message(3)], has_more: false }))
      await settle()
      const selected = app.host.querySelector('.ui-message-row--search-match')!
      expect(selected.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('id4')
      expect(selected.textContent).toContain('検索結果')
      expect(app.session.sync.get().channels.A.cursor).toBe(100)
    } finally {
      await app.close()
    }
  })

  it.each(['latest', 'send'])('leaves search history on %s and shows the latest timeline', async action => {
    const net = fakeNetwork()
    const options = net.options()
    const history_generation = record(1).history_generation
    net.pages.A = ok({ history_generation, as_of_seq: 100, messages: [record(100)], has_more: false })
    options.sync!.api!.listMessages = async (_id, query) => ok({
      history_generation, as_of_seq: 100, messages: query?.after_seq === 39 ? [record(40)] : [],
      has_more: query?.after_seq === 39,
    })
    const app = openWorkspace(net, options)
    try {
      await settle()
      net.subscribed('A', 100)
      app.navigation.openSearchResult('org', { channelId: 'A', messageId: 'id40', createdSeq: 40 })
      await settle()
      expect(app.host.querySelector('.ui-message-row--search-match')?.textContent).toContain('m40')
      if (action === 'latest') buttonsByText(app.host, '最新のメッセージへ')[0].click()
      else {
        const textarea = app.host.querySelector('main textarea')!
        textarea.value = '検索から送信'
        textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
        await settle()
        buttonsByText(app.host, '送信')[0].click()
        await settle()
        expect(net.sends[0]?.body.body).toBe('検索から送信')
        net.sends[0].resolve(ok({ ...record(101), sender: 'me', body: '検索から送信', client_message_id: net.sends[0].body.client_message_id }))
      }
      await settle()
      expect(app.navigation.get().searchResult).toBeUndefined()
      expect(app.session.searchAnchor.get()).toBeUndefined()
      expect(app.host.querySelector('.ui-message-row--search-match')).toBeNull()
      expect(app.host.querySelector('[data-message-id="id100"]')).not.toBeNull()
    } finally {
      await app.close()
    }
  })

  it('opens the exact Reply in an old chain and reports a stale result without falling back to the root', async () => {
    const net = fakeNetwork()
    const root = record(1)
    const hit = { ...record(35), reply_to: root.id, reply_root_id: root.id }
    const sibling = { ...hit, ...record(36), reply_to: root.id, reply_root_id: root.id }
    net.pages.A = ok({ history_generation: root.history_generation, as_of_seq: 100, messages: [record(100)], has_more: false })
    const chain = (messages: api.Message[]) => ok(replyPage({ history_generation: root.history_generation,
      as_of_seq: 110, root_id: root.id, messages, has_more: false }))
    net.replyChains['A:id35:34'] = chain([hit])
    net.replyChains['A:id35:10'] = chain([hit, sibling])
    net.replyChains['A:id34:33'] = chain([hit])
    const app = openWorkspace(net)
    try {
      await settle()
      net.subscribed('A', 100)
      app.navigation.openSearchResult('org', { channelId: 'A', replyRootId: root.id, messageId: hit.id, createdSeq: 35 })
      await settle()
      expect(app.navigation.get().target?.panel).toBe('reply:id35')
      expect(app.host.querySelector('#panel-content .ui-message-row--search-match')?.textContent).toContain('m35')
      expect(app.host.querySelector('#panel-content')?.textContent).toContain('m36')
      expect(net.replyHistory.map(({ query }) => query?.after_seq)).toEqual([34, 10])
      expect(app.session.sync.get().channels.A.cursor).toBe(100)

      app.navigation.openSearchResult('org', { channelId: 'A', replyRootId: root.id, messageId: 'id34', createdSeq: 34 })
      await settle()
      const panel = app.host.querySelector('#panel-content')!
      expect(panel.querySelector('[role="alert"]')?.textContent).toContain('このメッセージは表示できません。')
      expect(panel.querySelector('.ui-message-row--search-match')).toBeNull()
      expect(panel.textContent).not.toContain('m35')
      expect(app.session.sync.get().channels.A.state).toBe('ready')
    } finally {
      await app.close()
    }
  })
})
