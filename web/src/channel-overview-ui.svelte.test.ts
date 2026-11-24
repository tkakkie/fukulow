import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { fakeNetwork, flush, ok, record } from './adapter-test-helpers.svelte'
import type { Channel, ChannelList, DmDiscovery, Result } from './api'
import ArchivedChannelList from './ArchivedChannelList.svelte'
import ChannelOverview from './ChannelOverview.svelte'
import type { ChannelsApi } from './channels'
import { channelsAdapter } from './channels.svelte'
import Composer from './Composer.svelte'
import { dm } from './dm-test-helpers'
import ReplyPanel from './ReplyPanel.svelte'
import { createSession } from './session'
import { MiniDomEvent, withMiniDom, type MiniDocument, type MiniDomOptions, type MiniWindow } from './svelte-dom-test-helpers'
import { syncAdapter } from './sync.svelte'
import { repliesAdapter } from './replies.svelte'
import { deferred, http, row } from './unread-test-helpers'

const CHANNEL_OVERVIEW_DOM_OPTIONS: MiniDomOptions = {
  observers: true,
  initialScrollHeight: 600,
  initialClientHeight: 600,
  zeroRect: true,
  stopBubbleAtDocument: true,
  invokeDelegatedProp: true,
  allowDetachedFocus: true,
  dispatchFocusIn: false,
  clickSubmit: 'always',
}

const withDom = <T>(fn: (doc: MiniDocument, win: MiniWindow) => Promise<T>): Promise<T> =>
  withMiniDom(fn, CHANNEL_OVERVIEW_DOM_OPTIONS)

const makeChannel = (overrides: Partial<Channel> = {}): Channel => ({
  id: 'ch-1',
  kind: 'channel',
  archived: false,
  name: 'general',
  visibility: 'public',
  capabilities: {
    can_add_members: { allowed: false },
    can_remove_members: { allowed: false },
    can_manage_managers: { allowed: false },
    can_leave: { allowed: true },
    can_rename: { allowed: false },
    can_archive: { allowed: false },
  },
  ...overrides,
})

const history_generation = record(1).history_generation
const list = (channels: ChannelList['channels']) => ok({ history_generation, channels })

describe('ChannelOverview UI', () => {
  it('gates rename, archive, and restore controls by Capabilities and archive state, and hides all controls for DMs', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)

      // 1. Ordinary channel without rename/archive capabilities
      const noCapInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({ name: 'secret', visibility: 'private' }),
          onrename: async () => null,
          onarchive: async () => null,
          onrestore: async () => null,
        },
      })
      flushSync()
      expect(host.textContent).toContain('secret')
      expect(host.textContent).toContain('非公開')
      expect(host.querySelector('form')).toBeNull()
      expect(host.querySelectorAll('button')).toHaveLength(0)
      await unmount(noCapInst)

      // 2. Active ordinary channel with can_rename + can_archive
      const activeInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({
            name: 'general',
            visibility: 'public',
            capabilities: {
              ...makeChannel().capabilities,
              can_rename: { allowed: true },
              can_archive: { allowed: true },
            },
          }),
          onrename: async () => null,
          onarchive: async () => null,
          onrestore: async () => null,
        },
      })
      flushSync()
      expect(host.textContent).toContain('公開')
      expect(host.querySelector('form')).not.toBeNull()
      expect(host.querySelectorAll('button').map(b => b.textContent.trim())).toEqual(['名前を変更', 'アーカイブ'])
      await unmount(activeInst)

      // 3. Archived ordinary channel with can_archive (can_rename denied): shows 復元, hides 名前を変更 and アーカイブ
      const archivedInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({
            name: 'old-room',
            archived: true,
            capabilities: {
              ...makeChannel().capabilities,
              can_rename: { allowed: false, reason: 'channel_archived' },
              can_archive: { allowed: true },
            },
          }),
          onrename: async () => null,
          onarchive: async () => null,
          onrestore: async () => null,
        },
      })
      flushSync()
      expect(host.textContent).toContain('アーカイブ済み')
      expect(host.querySelector('form')).toBeNull()
      expect(host.querySelectorAll('button').map(b => b.textContent.trim())).toEqual(['復元'])
      await unmount(archivedInst)

      // 4. DM shows no rename/archive/restore controls
      const dmChannel: DmDiscovery = { id: 'dm-1', kind: 'dm', peer: { id: 'u2', name: '佐藤 花子', active: true } }
      const dmInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: dmChannel,
          onrename: async () => null,
          onarchive: async () => null,
          onrestore: async () => null,
        },
      })
      flushSync()
      expect(host.querySelector('form')).toBeNull()
      expect(host.querySelectorAll('button')).toHaveLength(0)
      await unmount(dmInst)
    })
  })

  it('disables rename, archive and restore while the archived state is pending, so stale Capabilities cannot act', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const onrename = vi.fn(async () => null)
      const onarchive = vi.fn(async () => null)
      const onrestore = vi.fn(async () => null)
      const props = $state({ pending: true, archived: false })
      const inst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          get channel() {
            return makeChannel({
              name: 'general',
              archived: props.archived,
              capabilities: { ...makeChannel().capabilities, can_rename: { allowed: true }, can_archive: { allowed: true } },
            })
          },
          get pending() { return props.pending },
          onrename,
          onarchive,
          onrestore,
        },
      })
      flushSync()
      const buttons = () => host.querySelectorAll('button')
      const btn = (label: string) => buttons().find(b => b.textContent.trim() === label)
      const input = host.querySelector('input')!
      expect(input.disabled).toBe(true)
      expect(btn('名前を変更')!.disabled).toBe(true)
      expect(btn('アーカイブ')!.disabled).toBe(true)
      btn('アーカイブ')!.click()
      flushSync()
      expect(host.textContent).not.toContain('チャンネルをアーカイブしますか？')
      host.querySelector('form')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      flushSync()
      expect(onrename).not.toHaveBeenCalled()

      // Once the by-id read settles the controls work again; pending again closes an open confirmation.
      props.pending = false
      flushSync()
      expect(btn('アーカイブ')!.disabled).toBe(false)
      btn('アーカイブ')!.click()
      flushSync()
      expect(host.textContent).toContain('チャンネルをアーカイブしますか？')
      props.pending = true
      flushSync()
      expect(host.textContent).not.toContain('チャンネルをアーカイブしますか？')
      expect(onarchive).not.toHaveBeenCalled()

      // Restore is gated the same way for an archived Channel.
      props.archived = true
      flushSync()
      expect(btn('復元')!.disabled).toBe(true)
      btn('復元')!.click()
      flushSync()
      expect(host.textContent).not.toContain('チャンネルを復元しますか？')
      expect(onrestore).not.toHaveBeenCalled()
      await unmount(inst)
    })
  })

  it('confirms archive and restore via Dialog, cancels via button or Escape, prevents double submit, and announces results', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const archiveDeferred = deferred<string | null>()
      const onarchive = vi.fn(() => archiveDeferred.promise)
      const onrestore = vi.fn(async () => null)
      const onannounce = vi.fn()

      const inst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({
            name: 'general',
            capabilities: {
              ...makeChannel().capabilities,
              can_rename: { allowed: true },
              can_archive: { allowed: true },
            },
          }),
          onrename: async () => null,
          onarchive,
          onrestore,
          onannounce,
        },
      })
      flushSync()

      const btn = (label: string) => host.querySelectorAll('button').find(b => b.textContent.trim() === label)

      // Open archive confirmation, then cancel via button
      btn('アーカイブ')!.click()
      flushSync()
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain('チャンネルをアーカイブしますか？')
      btn('キャンセル')!.click()
      flushSync()
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(onarchive).not.toHaveBeenCalled()

      // Open archive confirmation again, then cancel via Escape
      btn('アーカイブ')!.click()
      flushSync()
      const dialog = host.querySelector('[role="dialog"]')!
      dialog.keydown('Escape')
      flushSync()
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(onarchive).not.toHaveBeenCalled()

      // Open archive confirmation and confirm: pending disables double submit & Escape
      btn('アーカイブ')!.click()
      flushSync()
      const confirmBtn = host.querySelector('[role="dialog"]')!.querySelectorAll('button').find(b => b.textContent.trim() === 'アーカイブ')!
      confirmBtn.click()
      flushSync()
      expect(onarchive).toHaveBeenCalledTimes(1)
      expect(confirmBtn.disabled).toBe(true)
      confirmBtn.click()
      host.querySelector('[role="dialog"]')!.keydown('Escape')
      flushSync()
      expect(onarchive).toHaveBeenCalledTimes(1)
      expect(host.querySelector('[role="dialog"]')).not.toBeNull()

      archiveDeferred.resolve(null)
      await flush()
      flushSync()
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(onannounce).toHaveBeenCalledWith('チャンネルをアーカイブしました。')
      await unmount(inst)

      // Restore confirmation + confirm
      const restoreInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({
            name: 'general',
            archived: true,
            capabilities: { ...makeChannel().capabilities, can_archive: { allowed: true } },
          }),
          onrename: async () => null,
          onarchive,
          onrestore,
          onannounce,
        },
      })
      flushSync()
      btn('復元')!.click()
      flushSync()
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain('チャンネルを復元しますか？')
      const confirmRestore = host.querySelector('[role="dialog"]')!.querySelectorAll('button').find(b => b.textContent.trim() === '復元')!
      confirmRestore.click()
      await flush()
      flushSync()
      expect(onrestore).toHaveBeenCalledTimes(1)
      expect(onannounce).toHaveBeenCalledWith('チャンネルを復元しました。')
      await unmount(restoreInst)
    })
  })

  it('validates rename via the channels controller, shows Japanese refusal text in role="alert", and disables while pending', async () => {
    await withDom(async (doc) => {
      const net = fakeNetwork()
      const pendingPatch = deferred<Result<undefined>>()
      const updateChannel = vi.fn<NonNullable<ChannelsApi['updateChannel']>>()
        .mockResolvedValueOnce(http(409, 'channel name already exists'))
        .mockReturnValueOnce(pendingPatch.promise)
      const session = createSession({
        selfId: 'me',
        organizationId: 'org',
        onEnded: vi.fn(),
        ...net.options(),
        channelsApi: {
          listChannels: async () => list([row({ id: 'ch-1', name: 'general' })]),
          createChannel: vi.fn(),
          updateChannel,
        },
      })
      const adapter = channelsAdapter(session.channels)
      const onannounce = vi.fn()
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      try {
        const inst = mount(ChannelOverview, {
          target: host as unknown as Element,
          props: {
            channel: makeChannel({
              id: 'ch-1',
              name: 'general',
              capabilities: { ...makeChannel().capabilities, can_rename: { allowed: true } },
            }),
            onrename: (name) => adapter.rename('ch-1', name),
            onarchive: () => adapter.archive('ch-1'),
            onrestore: () => adapter.restore('ch-1'),
            onannounce,
          },
        })
        flushSync()

        const input = host.querySelector('input')!
        const submitBtn = host.querySelectorAll('button').find(b => b.textContent.trim() === '名前を変更')!

        // 1. Over-length client check
        input.input('あ'.repeat(129))
        flushSync()
        submitBtn.click()
        flushSync()
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('チャンネル名は128文字以内にしてください。')
        expect(updateChannel).not.toHaveBeenCalled()

        // 2. Server 409 refusal via controller
        input.input('existing')
        flushSync()
        submitBtn.click()
        await flush()
        flushSync()
        expect(updateChannel).toHaveBeenCalledWith('ch-1', { name: 'existing' })
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('同じ名前のチャンネルがすでにあります。')

        // 3. Pending state disables double submit; resolves with announcement
        input.input('renamed')
        flushSync()
        submitBtn.click()
        flushSync()
        expect(updateChannel).toHaveBeenCalledTimes(2)
        expect(submitBtn.disabled).toBe(true)
        expect(input.disabled).toBe(true)
        submitBtn.click()
        expect(updateChannel).toHaveBeenCalledTimes(2)

        pendingPatch.resolve(ok(undefined))
        await flush()
        flushSync()
        expect(host.querySelector('[role="alert"]')).toBeNull()
        expect(onannounce).toHaveBeenCalledWith('チャンネル名を変更しました。')
        await unmount(inst)
      } finally {
        session.close()
      }
    })
  })
})

describe('ArchivedChannelList UI', () => {
  it('shows no Unread/Mention badges or DMs and releases on collapse when no archived Channel is selected', async () => {
    vi.useFakeTimers()
    try {
      await withDom(async (doc) => {
        const net = fakeNetwork()
        const archivedRow = {
          ...row({ id: 'arch-1', name: 'archived-room', unread_count: 5, main_unread_count: 5, mention_unread_count: 2, main_mention_unread_count: 2 }),
          archived: true,
        }
        const activeRow = row({ id: 'act-1', name: 'general' })
        const listArchivedChannels = vi.fn<NonNullable<ChannelsApi['listArchivedChannels']>>(async () => list([archivedRow]))
        const session = createSession({
          selfId: 'me',
          organizationId: 'org',
          onEnded: vi.fn(),
          ...net.options(),
          channelsApi: {
            listChannels: async () => list([activeRow]),
            listArchivedChannels,
            createChannel: vi.fn(),
          },
          dmsApi: {
            changes: async () => ok({ dms: [dm('dm-1')], next_cursor: '', caught_up: true }),
            list: async () => ok({ history_generation, dms: [dm('dm-1')], next_cursor: null }),
            open: vi.fn(),
          },
        })
        net.socket.onReady()
        const adapter = channelsAdapter(session.channels)
        const onselect = vi.fn()
        const host = doc.createElement('div')
        doc.body.appendChild(host)

        try {
          await flush()
          // Reactive wrapper reading adapter.state.archivedList
          const props = $state<{ list: ReturnType<typeof channelsAdapter>['state']['archivedList'] }>({ list: undefined })
          const stop = $effect.root(() => {
            $effect(() => { props.list = adapter.state.archivedList })
          })
          const inst = mount(ArchivedChannelList, {
            target: host as unknown as Element,
            props: {
              get list() { return props.list },
              selectedId: null,
              onhold: () => adapter.holdArchived(),
              onretry: () => adapter.retryArchived(),
              onselect,
            },
          })
          flushSync()

          // Initially collapsed: archived list is NOT held or fetched
          const toggle = host.querySelector('button')!
          expect(toggle.getAttribute('aria-expanded')).toBe('false')
          expect(listArchivedChannels).not.toHaveBeenCalled()

          // Expand: holds target and fetches archived channels
          toggle.click()
          flushSync()
          await vi.advanceTimersByTimeAsync(200)
          flushSync()
          expect(toggle.getAttribute('aria-expanded')).toBe('true')
          expect(listArchivedChannels).toHaveBeenCalledTimes(1)

          const items = host.querySelectorAll('li')
          expect(items).toHaveLength(1)
          expect(items[0].textContent).toContain('archived-room')
          // No Unread or Mention badge or total, and no DMs
          expect(host.querySelectorAll('.ui-badge')).toHaveLength(0)
          expect(host.textContent).not.toContain('未読')
          expect(host.textContent).not.toContain('5')
          expect(host.textContent).not.toContain('dm-1')

          // Clicking an archived channel selects it
          items[0].querySelector('button')!.click()
          expect(onselect).toHaveBeenCalledWith('arch-1')

          // Collapse: releases hold and clears archivedList
          toggle.click()
          flushSync()
          expect(adapter.state.archivedList).toBeUndefined()
          listArchivedChannels.mockClear()
          net.event({ type: 'channel_list_changed' })
          await vi.advanceTimersByTimeAsync(300)
          expect(listArchivedChannels).not.toHaveBeenCalled()

          await unmount(inst)
          stop()
        } finally {
          session.close()
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ArchivedChannelList retry', () => {
  it('re-reads the archived list on 再試行 even while an open archived Channel keeps it held', async () => {
    vi.useFakeTimers()
    try {
      await withDom(async (doc) => {
        const net = fakeNetwork()
        const archivedRow = { ...row({ id: 'arch-1', name: 'archived-room' }), archived: true }
        const listArchivedChannels = vi.fn<NonNullable<ChannelsApi['listArchivedChannels']>>(async () => list([archivedRow]))
        listArchivedChannels.mockResolvedValueOnce(http(400, 'bad_request'))
        const session = createSession({
          selfId: 'me',
          organizationId: 'org',
          onEnded: vi.fn(),
          ...net.options(),
          channelsApi: {
            listChannels: async () => list([row({ id: 'act-1', name: 'general' })]),
            listArchivedChannels,
            getChannel: async () => ok(archivedRow),
            createChannel: vi.fn(),
          },
        })
        net.socket.onReady()
        const adapter = channelsAdapter(session.channels)
        const host = doc.createElement('div')
        doc.body.appendChild(host)
        try {
          // Opening the archived Channel by link holds the archived list, and its first read fails.
          adapter.selectHint('arch-1')
          await vi.advanceTimersByTimeAsync(200)
          expect(listArchivedChannels).toHaveBeenCalledTimes(1)
          expect(adapter.state.archivedList?.status).toBe('error')

          const props = $state<{ list: ReturnType<typeof channelsAdapter>['state']['archivedList'] }>({ list: undefined })
          const stop = $effect.root(() => {
            $effect(() => { props.list = adapter.state.archivedList })
          })
          const inst = mount(ArchivedChannelList, {
            target: host as unknown as Element,
            props: {
              get list() { return props.list },
              selectedId: 'arch-1',
              onhold: () => adapter.holdArchived(),
              onretry: () => adapter.retryArchived(),
              onselect: vi.fn(),
            },
          })
          flushSync()
          host.querySelector('button')!.click()
          flushSync()
          await vi.advanceTimersByTimeAsync(300)
          flushSync()
          // Expanding re-uses the held list; a failed read is not retried on its own.
          expect(listArchivedChannels).toHaveBeenCalledTimes(1)
          const retry = host.querySelectorAll('button').find(b => b.textContent.trim() === '再試行')!
          expect(retry).toBeDefined()

          retry.click()
          await flush()
          flushSync()
          expect(listArchivedChannels).toHaveBeenCalledTimes(2)
          expect(adapter.state.archivedList?.status).toBe('ready')
          expect(host.querySelectorAll('li').map(li => li.textContent)).toEqual([expect.stringContaining('archived-room')])
          expect(host.textContent).not.toContain('再試行')

          await unmount(inst)
          stop()
        } finally {
          session.close()
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Archived Channel read-only notice and disabled composers', () => {
  it('disables main Composer and shows read-only notice with disabled Reply composer while keeping history readable', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)

      // 1. Composer disabled in an archived channel
      const onsubmit = vi.fn(async () => true)
      const composerInst = mount(Composer, {
        target: host as unknown as Element,
        props: {
          value: '下書き',
          disabled: true,
          oninput: () => {},
          onsubmit,
        },
      })
      flushSync()
      expect(host.querySelector('textarea')!.disabled).toBe(true)
      expect(host.querySelector('button')!.disabled).toBe(true)
      host.querySelector('button')!.click()
      expect(onsubmit).not.toHaveBeenCalled()
      await unmount(composerInst)

      // 2. ReplyPanel in an archived channel: shows read-only notice, disables Reply composer, keeps history readable
      const net = fakeNetwork()
      const msg = record(1, 'arch-1')
      net.pages['arch-1'] = ok({ history_generation, as_of_seq: 1, messages: [msg], has_more: false })
      const session = createSession({
        selfId: 'me',
        organizationId: 'org',
        onEnded: vi.fn(),
        ...net.options(),
        repliesApi: {
          listReplyChain: async () => ok({
            history_generation,
            as_of_seq: 1,
            root_id: msg.id,
            chain_version: 1,
            messages: [msg],
            has_more: false,
          }),
        },
      })
      net.socket.onReady()
      const sync = syncAdapter(session.sync)
      const replies = repliesAdapter(session.replies, 'arch-1')
      try {
        await session.sync.watch('arch-1')
        await replies.open(msg)
        const replyInst = mount(ReplyPanel, {
          target: host as unknown as Element,
          props: {
            channel: sync.channel('arch-1'),
            replies,
            channelId: 'arch-1',
            anchorMessageId: msg.id,
            resolvedAnchor: msg,
            selfId: 'me',
            sendDisabled: true,
            archived: true,
          },
        })
        flushSync()
        expect(host.textContent).toContain('このチャンネルはアーカイブされています。')
        expect(host.textContent).toContain(msg.body)
        expect(host.querySelector('textarea')!.disabled).toBe(true)
        const sendBtn = host.querySelectorAll('button').find(b => b.textContent.trim() === '送信')!
        expect(sendBtn.disabled).toBe(true)
        await unmount(replyInst)
      } finally {
        session.close()
      }
    })
  })
})
