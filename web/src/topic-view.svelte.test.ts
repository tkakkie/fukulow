import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import TopicView from './TopicView.svelte'
import { topicsAdapter } from './topics.svelte'
import { windowClient } from './message-window-test-helpers'
import { msg, summary } from './topic-test-helpers'
import { buttonsByText, installMiniDom, queryAll } from './svelte-dom-test-helpers'
import { HISTORY_GENERATION } from './topic-workspace-test-helpers'

const dom = installMiniDom()

describe('Topic summary lines, TopicList and TopicView states', () => {
  it('TopicView handles an active summary evicted by 400 newer main Messages without rejection or a render loop', async () => {
    vi.useFakeTimers()
    const c = windowClient(), report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await c.boot()
      for (let page = 0; page < 7; page++) await c.topics.loadMain('A')
      c.options.listTopicMessages = async () => ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([msg(1, 'T')]).at(-1)?.created_seq ?? 0, messages: [msg(1, 'T')], has_more: false })
      const getSummary = vi.fn(async () => ok({ history_generation: HISTORY_GENERATION, as_of_seq: 1000, topic: summary('T', 1, 1) }))
      c.options.getTopicSummary = getSummary
      const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
      const instance = mount(TopicView, { target: host as unknown as Element, props: {
        channel: syncAdapter(c.sync).channel('A'), topics: topicsAdapter(c.topics, 'A'),
        channelId: 'A', topicId: 'T', topicName: 'Topic T',
      } })
      try {
        await settle(); await settle()
        await vi.advanceTimersByTimeAsync(60_000); await settle()
        expect(getSummary).toHaveBeenCalledTimes(1)
        expect(report).not.toHaveBeenCalled()
        expect(c.topics.get('A').lines).toHaveLength(400)
        expect(c.topics.get('A').topic('T').messages).toEqual([msg(1, 'T')])
        expect(host.querySelector('[data-message-id="id1"]')).not.toBeNull()
        expect(c.sync.get().channels.A.cursor).toBe(1000)
      } finally { await unmount(instance) }
    } finally { await c.close(); report.mockRestore() }
  })

  it.each([403, 404])('Topic history %s shows Channel denial and keeps the Topic draft', async status => {
    const net = fakeNetwork()
    const raw = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
    net.pages.A = ok({ history_generation: HISTORY_GENERATION, as_of_seq: ([{ ...record(10), topic_id: 'T' }]).at(-1)?.created_seq ?? 0, messages: [{ ...record(10), topic_id: 'T' }], has_more: false })
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('A')] }))
    await settle(); net.subscribed('A', 10); await settle()
    const ch = syncAdapter(raw.sync).channel('A')
    ch.topic('T').setDraft('失わないトピック下書き')
    net.topicMessages['A:T'] = { ok: false, kind: 'http', status, error: 'channel_not_found' }
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(TopicView, { target: host as unknown as Element,
      props: { channel: ch, topics: topicsAdapter(raw.topics, 'A'), channelId: 'A', topicId: 'T', topicName: 'Topic T', ongoToChannelList: vi.fn() } })
    await settle()
    expect(host.textContent).toContain('このチャンネルは利用できません。')
    expect(buttonsByText(host, '再試行')).toHaveLength(0)
    expect(buttonsByText(host, 'チャンネル一覧へ')).toHaveLength(1)
    const textarea = queryAll(host, 'textarea')[0]
    expect(textarea.disabled).toBe(true)
    expect(textarea.value).toBe('失わないトピック下書き')
    expect(await ch.topic('T').submit('Topic T')).toBe(false)
    expect(net.sends).toHaveLength(0)
    await unmount(instance); raw.close()
  })

  it('confirms before replacing a non-empty Topic Composer draft on send refused (置き換える / キャンセル)', async () => {
    const net = fakeNetwork()
    const raw = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options('me') })
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: HISTORY_GENERATION, channels: [channel('A', 'general')] }))
    net.topicMessages['A:T'] = ok({ history_generation: HISTORY_GENERATION, as_of_seq: 0, messages: [], has_more: false })
    net.topicSummaries['A:T'] = ok({
      history_generation: HISTORY_GENERATION,
      as_of_seq: 0,
      topic: summary('T', 0, 0),
    })
    await vi.waitFor(() =>
      expect(net.socket.sent.some((m) => m.type === 'subscribe' && m.channel_id === 'A')).toBe(true),
    )
    net.subscribed('A', 0)
    await vi.waitFor(() => expect(raw.sync.get().channels.A?.state).toBe('ready'))

    const ch = syncAdapter(raw.sync).channel('A')
    const tp = topicsAdapter(raw.topics, 'A')
    const tc = ch.topic('T')

    tc.setDraft('拒否されたトピック本文')
    const refused = tc.submit('Topic T')
    await vi.waitFor(() => expect(net.sends).toHaveLength(1))
    net.sends[0].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    await refused
    flushSync()
    await tick()

    tc.setDraft('入力途中のトピック下書き')
    flushSync()
    await tick()

    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(TopicView, {
      target: host as unknown as Element,
      props: {
        channel: ch,
        topics: tp,
        channelId: 'A',
        topicId: 'T',
        topicName: 'Topic T',
        selfId: 'me',
      },
    })
    try {
      flushSync()
      await tick()
      await vi.waitFor(() => expect(buttonsByText(host, '編集して送り直す')).toHaveLength(1))
      flushSync()

      const textarea = host.querySelector('textarea')!
      expect(textarea.value).toBe('入力途中のトピック下書き')
      expect(host.querySelector('dialog:modal')).toBeNull()

      // 1. Clicking 編集して送り直す with a non-empty draft opens the replace dialog without mutating draft or pending
      buttonsByText(host, '編集して送り直す')[0].click()
      flushSync()
      await tick()

      const dialog = host.querySelector('dialog:modal')
      expect(dialog).not.toBeNull()
      expect(dialog!.getAttribute('aria-label')).toBe('入力中の下書きを置き換えますか？')
      expect(buttonsByText(dialog!, '置き換える')).toHaveLength(1)
      expect(buttonsByText(dialog!, 'キャンセル')).toHaveLength(1)
      expect(tc.composer.draft).toBe('入力途中のトピック下書き')
      expect(ch.timeline.pending).toHaveLength(1)

      // 2. Clicking キャンセル closes the dialog and keeps both the original draft and the failed send
      buttonsByText(dialog!, 'キャンセル')[0].click()
      flushSync()
      await tick()
      flushSync()

      expect(host.querySelector('dialog:modal')).toBeNull()
      expect(tc.composer.draft).toBe('入力途中のトピック下書き')
      expect(textarea.value).toBe('入力途中のトピック下書き')
      expect(ch.timeline.pending).toHaveLength(1)
      expect(buttonsByText(host, '編集して送り直す')).toHaveLength(1)

      // 3. Reopen and click 置き換える: replaces the draft, removes the failed send, and returns focus to Composer
      buttonsByText(host, '編集して送り直す')[0].click()
      flushSync()
      const reopened = host.querySelector('dialog:modal')!
      buttonsByText(reopened, '置き換える')[0].click()
      flushSync()
      await tick()
      flushSync()

      expect(host.querySelector('dialog:modal')).toBeNull()
      expect(tc.composer.draft).toBe('拒否されたトピック本文')
      expect(textarea.value).toBe('拒否されたトピック本文')
      expect(ch.timeline.pending).toHaveLength(0)
      expect(buttonsByText(host, '編集して送り直す')).toHaveLength(0)
      expect(dom.doc.activeElement).toBe(textarea)

      // 4. Empty Topic Composer draft restores immediately without confirmation and focuses Composer
      tc.setDraft('二度目の拒否トピック本文')
      const secondRefused = tc.submit('Topic T')
      await vi.waitFor(() => expect(net.sends).toHaveLength(2))
      net.sends[1].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
      await secondRefused
      flushSync()
      await tick()
      flushSync()
      expect(textarea.value).toBe('')

      buttonsByText(host, '編集して送り直す')[0].click()
      flushSync()
      await tick()
      flushSync()

      expect(host.querySelector('dialog:modal')).toBeNull()
      expect(tc.composer.draft).toBe('二度目の拒否トピック本文')
      expect(textarea.value).toBe('二度目の拒否トピック本文')
      expect(dom.doc.activeElement).toBe(textarea)
    } finally {
      await unmount(instance)
      raw.close()
    }
  })
})
