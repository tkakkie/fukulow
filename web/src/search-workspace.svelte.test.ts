import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import type { ListMessagesQuery, Message, SearchHit } from './api'
import { channelsAdapter } from './channels.svelte'
import { dm } from './dm-test-helpers'
import { dmsAdapter } from './dms.svelte'
import { createMembers } from './members'
import { membersAdapter } from './members.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { repliesAdapter } from './replies.svelte'
import { searchAnchorAdapter } from './search-anchor.svelte'
import { createDefaultSearchSource, type SearchResponse, type SearchSource } from './search-source'
import { createMockSearchSource, makeSearchHit } from './search-test-helpers'
import { createSession, type SessionOptions } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import { unreadAdapter } from './unread.svelte'
import { deferred } from './unread-test-helpers'
import Workspace from './Workspace.svelte'
import { replyPage } from './topic-test-helpers'
import { installMiniDom, MiniDomEvent, MiniElement, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

async function submitSearch(host: MiniElement, query: string, region = '#main-content') {
  const form = host.querySelector(`${region} [role="search"]`)!
  const input = form.querySelector('input')!
  input.value = query
  input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
  flushSync()
  form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
  await settle()
}

describe('Workspace search integration (#153)', () => {
  const ORG_ID = '00000000-0000-4000-8000-000000000001'
  const CH_ID = '00000000-0000-4000-8000-000000000010'
  const TOPIC_ID = '00000000-0000-4000-8000-000000000020'
  const DM_ID = '00000000-0000-4000-8000-000000000030'
  const OTHER_CH_ID = '00000000-0000-4000-8000-000000000040'

  const historyGeneration = record(1).history_generation
  const messagePage = (messages: Message[]) =>
    ok({ history_generation: historyGeneration, as_of_seq: 80, messages, has_more: false })
  function hitSource(message: Message, channelKind: SearchHit['channel_kind'] = 'channel') {
    return createMockSearchSource({
      hits: [{ channel_kind: channelKind, message: { ...message, body: message.body ?? 'リリース' } }],
    })
  }

  function dmSource(peer = dm(DM_ID)): SessionOptions['dmsApi'] {
    return {
      list: async () => ok({ history_generation: historyGeneration, dms: [peer], next_cursor: null }),
      changes: async ({ lane }) => ok({ dms: [peer], next_cursor: lane, caught_up: true }),
      open: async () => ({ ok: false, kind: 'network' }),
    }
  }

  async function mountSearchWorkspace(opts: {
    width?: number
    href?: string
    searchSource?: SearchSource
    onannounce?: (message: string) => void
    channelList?: 'loading' | 'error'
    channelRows?: ReturnType<typeof channel>[]
    dmsApi?: SessionOptions['dmsApi']
    members?: ReturnType<typeof createMembers>
    setupNet?: (net: ReturnType<typeof fakeNetwork>, options: ReturnType<ReturnType<typeof fakeNetwork>['options']>) => void
  } = {}) {
    dom.win.innerWidth = opts.width ?? 1280
    const net = fakeNetwork()
    const options = net.options('me')
    opts.setupNet?.(net, options)
    const raw = createSession({ organizationId: ORG_ID, selfId: 'me', onEnded: () => {}, dmsApi: opts.dmsApi, ...options })
    net.socket.onReady()
    if (opts.channelList !== 'loading') {
      net.lists[0]!.resolve(opts.channelList === 'error' ? { ok: false, kind: 'http', status: 400, error: 'bad_request' } : ok({
        history_generation: historyGeneration,
        channels: opts.channelRows ?? [channel(CH_ID, 'general')],
      }))
    }
    const location = { href: opts.href ?? `/o/${ORG_ID}/c/${CH_ID}` }
    const updateHistory = (state: unknown, _title: string, url: string) => {
      history.state = state
      location.href = url
    }
    const history = { state: null as unknown, pushState: vi.fn(updateHistory), replaceState: vi.fn(updateHistory) }
    const navigation = createNavigation({
      location,
      history,
      get innerWidth() { return dom.win.innerWidth },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        selectedOrganizationId: ORG_ID,
        members: opts.members && membersAdapter(opts.members),
        searchSource: opts.searchSource ?? createMockSearchSource(),
        onannounce: opts.onannounce,
        session: {
          channels: channelsAdapter(raw.channels),
          sync: syncAdapter(raw.sync),
          topics: (id: string) => topicsAdapter(raw.topics, id),
          replies: (id: string) => repliesAdapter(raw.replies, id),
          dms: opts.dmsApi && dmsAdapter(raw.dms),
          unread: (id: string) => unreadAdapter(raw.unread, id),
          searchAnchor: searchAnchorAdapter(raw.searchAnchor),
          onChannelRevoked: raw.onChannelRevoked,
          close: raw.close,
        },
      },
    })
    await settle()
    return {
      host,
      navigation,
      location,
      history,
      net,
      raw,
      async close() {
        await unmount(instance)
        navigation.destroy()
        raw.close()
        opts.members?.close()
        host.remove()
      },
    }
  }

  it('keeps the same search form and input focus on submit, without extra live regions', async () => {
    const ctx = await mountSearchWorkspace()
    try {
      const formBefore = ctx.host.querySelector('#main-content [role="search"]')!
      const inputBefore = formBefore.querySelector('input')!
      inputBefore.focus()
      expect(dom.doc.activeElement).toBe(inputBefore)

      inputBefore.value = 'リリース'
      inputBefore.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      formBefore.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      const formAfter = ctx.host.querySelector('#main-content [role="search"]')!
      const inputAfter = formAfter.querySelector('input')!
      expect(formAfter).toBe(formBefore)
      expect(inputAfter).toBe(inputBefore)
      expect(dom.doc.activeElement).toBe(inputBefore)
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(queryAll(ctx.host, '#main-content [role="status"]')).toHaveLength(0)
    } finally {
      await ctx.close()
    }
  })

  it.each([
    { scope: 'Channel Message in another Channel', id: OTHER_CH_ID, topicId: null, replyRootId: null, archived: false },
    { scope: 'Topic Message', id: CH_ID, topicId: TOPIC_ID, replyRootId: null, archived: false },
    { scope: 'Reply', id: CH_ID, topicId: null, replyRootId: 'id5', archived: false },
    { scope: 'Topic Message in an archived Channel', id: CH_ID, topicId: TOPIC_ID, replyRootId: null, archived: true },
  ])('opens a $scope from search, reads around its creation sequence and focuses the destination', async ({ id, topicId, replyRootId, archived }) => {
    const hit = {
      ...record(37, id),
      id: 'search-hit',
      version: 60,
      topic_id: topicId,
      topic_name: topicId ? 'リリース準備' : null,
      reply_to: replyRootId,
      reply_root_id: replyRootId,
    }
    const latest = { ...record(80, id), topic_id: hit.topic_id, topic_name: hit.topic_name }
    const history_generation = hit.history_generation
    const page = (messages: Message[]) => ok({ history_generation, as_of_seq: 80, messages, has_more: false })
    const read = async (query?: ListMessagesQuery) =>
      page(query?.after_seq === 36 ? [hit] : query?.before_seq === 37 ? [] : [latest])
    const readMessages = vi.fn((_channel: string, query?: ListMessagesQuery) => read(query))
    const readTopicMessages = vi.fn((_channel: string, _topic: string, query?: ListMessagesQuery) => read(query))
    const readTimeline = vi.fn<NonNullable<import('./session').SessionOptions['topicsApi']>['listTimeline']>()
    const searchResult = { channelId: id, topicId, replyRootId, messageId: hit.id, createdSeq: hit.created_seq }
    const ctx = await mountSearchWorkspace({
      href: replyRootId ? `/o/${ORG_ID}/c/${CH_ID}?panel=topics` : undefined,
      channelRows: [{ ...channel(CH_ID, 'general'), archived }, channel(OTHER_CH_ID, 'other')],
      searchSource: createMockSearchSource({
        hits: [{
          channel_kind: 'channel',
          message: {
            ...hit,
            created_at: '2026-11-19T09:30:00.000Z',
            body: 'リリース手順書を更新しました。',
          },
        }],
      }),
      setupNet(net, options) {
        net.pages[id] = page([latest])
        options.sync!.api!.listMessages = readMessages
        options.topicsApi!.listTopicMessages = readTopicMessages
        const defaultTimeline = options.topicsApi!.listTimeline
        options.topicsApi!.listTimeline = readTimeline.mockImplementation(async (channel, query) => {
          if (query?.after_position === 36) return ok({ history_generation, as_of_seq: 80, items: [{ kind: 'message', message: hit }], has_more: false })
          if (query?.before_position === 37) return ok({ history_generation, as_of_seq: 80, items: [], has_more: false })
          return defaultTimeline(channel, query)
        })
        if (replyRootId) {
          net.replyChains[`${id}:${hit.id}`] = ok(replyPage({
            history_generation, as_of_seq: 80, root_id: replyRootId, messages: [hit], has_more: false,
          }))
        }
      },
    })
    try {
      ctx.net.subscribed(CH_ID, 80)
      await settle()
      await submitSearch(ctx.host, 'リリース')
      ctx.host.querySelector('#main-content ol button')!.click()
      await settle()

      const panel = replyRootId ? `reply:${hit.id}` : null
      const url = `/o/${ORG_ID}/c/${id}${topicId ? `/t/${topicId}` : ''}${panel ? `?panel=${panel}` : ''}`
      expect(ctx.navigation.get().target).toEqual({ organizationId: ORG_ID, channelId: id, topicId, panel })
      expect(ctx.raw.channels.get().selectedId).toBe(id)
      expect(ctx.navigation.get().searchResult).toEqual(searchResult)
      expect(ctx.location.href).toBe(url)
      const state = { navigationPreviousTab: replyRootId ? 'topics' : null, searchResult }
      expect(ctx.history.state).toEqual(state)
      expect(ctx.history.pushState.mock.calls).toEqual([[state, '', url]])
      expect(ctx.history.replaceState).not.toHaveBeenCalled()

      if (replyRootId) {
        expect(ctx.net.replyHistory[0]).toEqual({
          channel: id, anchor: hit.id, query: expect.objectContaining({ after_seq: 36, limit: 1 }),
        })
      } else if (topicId) {
        expect(readTopicMessages).toHaveBeenCalledWith(id, topicId, expect.objectContaining({ after_seq: 36 }))
        expect(readTopicMessages).toHaveBeenCalledWith(id, topicId, expect.objectContaining({ before_seq: 37 }))
      } else {
        expect(readTimeline).toHaveBeenCalledWith(id, expect.objectContaining({ after_position: 36 }))
        expect(readTimeline).toHaveBeenCalledWith(id, expect.objectContaining({ before_position: 37 }))
      }
      const scope = replyRootId ? '#panel-content' : '#main-content'
      expect(ctx.host.querySelector(`${scope} .ui-message-row--search-match`)
        ?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(hit.id)
      const composer = ctx.host.querySelector(`${scope} textarea`)!
      expect(composer.disabled).toBe(archived)
      expect(dom.doc.activeElement).toBe(archived ? ctx.host.querySelector('#main-content h1') : composer)
      if (replyRootId) {
        ctx.host.querySelector('#panel-content button[aria-label="前の表示に戻る"]')!.click()
        await settle()
        expect(dom.doc.activeElement).toBe(ctx.host.querySelector('#panel-tab-topics'))

        await submitSearch(ctx.host, 'リリース')
        ctx.host.querySelector('#main-content ol button')!.click()
        await settle()
        const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
        esc.key = 'Escape'
        dom.doc.activeElement!.dispatchEvent(esc)
        await settle()
        expect(ctx.navigation.get().target?.panel).toBeNull()
        expect(dom.doc.activeElement).toBe(ctx.host.querySelector('#main-content textarea'))
      }
    } finally {
      await ctx.close()
    }
  })

  it.each([
    { situation: 'no navigation target and a loading Channel list', href: '/', status: 'loading', width: 480, active: true },
    { situation: 'a previous Organization URL and a failed Channel list', href: `/o/previous/c/${CH_ID}?panel=topics`, status: 'error', width: 800, active: false },
  ] as const)('opens a DM hit with $situation', async ({ href, status, width, active }) => {
    vi.useFakeTimers()
    const hit = record(37, DM_ID)
    const ctx = await mountSearchWorkspace({
      href, width, channelList: status,
      searchSource: hitSource({ ...hit, body: 'リリース' }, 'dm'),
      dmsApi: dmSource(dm(DM_ID, { peer: { id: 'peer', name: 'Peer', active } })),
      setupNet(net) { net.pages[DM_ID] = messagePage([hit]) },
    })
    try {
      ctx.net.socket.onEvent({ type: 'activity_ready' })
      await vi.advanceTimersByTimeAsync(1000)
      await settle()
      expect(ctx.raw.channels.get().status).toBe(status)
      expect(ctx.raw.channels.get().selectedId).toBeNull()
      expect(ctx.raw.dms.get().rows.map(row => row.identity.id)).toContain(DM_ID)
      expect(ctx.navigation.get().target?.organizationId).toBe(href === '/' ? undefined : 'previous')

      const workspace = ctx.host.querySelector('.workspace')!
      if (width === 800) {
        ctx.host.querySelector('.rail button[aria-label="チャンネル一覧"]')!.click()
        await settle()
        expect(workspace.getAttribute('data-drawer-open')).toBe('true')
      }
      await submitSearch(ctx.host, 'リリース', width === 480 ? '#channel-content' : '#main-content')
      ctx.host.querySelector('#main-content ol button')!.click()
      await settle()

      expect(ctx.location.href).toBe(`/o/${ORG_ID}/c/${DM_ID}`)
      expect(ctx.history.pushState).toHaveBeenCalledOnce()
      expect(ctx.history.replaceState).not.toHaveBeenCalled()
      expect(ctx.raw.channels.get().selectedId).toBe(DM_ID)
      expect(ctx.raw.dms.get().selected).toBe(DM_ID)
      expect(ctx.host.querySelector('.ui-message-row--search-match')?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(hit.id)
      expect(workspace.getAttribute('data-drawer-open')).toBe('false')
      const composer = ctx.host.querySelector('#main-content textarea')!
      expect(composer.disabled).toBe(!active)
      expect(dom.doc.activeElement).toBe(active ? composer : ctx.host.querySelector('#main-content h1'))
    } finally {
      await ctx.close()
      vi.useRealTimers()
    }
  })

  it.each([
    { scope: 'Channel', id: CH_ID, width: 1280 },
    { scope: 'Topic', id: CH_ID, width: 480 },
    { scope: 'DM', id: DM_ID, width: 480 },
  ])('retries a C9 watch once for a search hit in the selected $scope', async ({ scope, id, width }) => {
    vi.useFakeTimers()
    const hit = { ...record(37, id), topic_id: scope === 'Topic' ? TOPIC_ID : null }
    const ctx = await mountSearchWorkspace({
      width, href: width < 600 ? `/o/${ORG_ID}` : undefined,
      dmsApi: scope === 'DM' ? dmSource() : undefined,
      searchSource: hitSource({ ...hit, body: 'リリース' }, scope === 'DM' ? 'dm' : 'channel'),
      setupNet(net) { net.pages[id] = messagePage([hit]) },
    })
    try {
      if (scope === 'DM') {
        ctx.net.socket.onEvent({ type: 'activity_ready' })
        await vi.advanceTimersByTimeAsync(1000)
        ctx.raw.dms.select(id)
      }
      await settle()
      ctx.net.subscribed(id, 80)
      await settle()
      expect(ctx.raw.channels.get().selectedId).toBe(id)
      await ctx.raw.sync.channelUnavailable(id)
      await settle()
      expect(ctx.raw.sync.get().channels[id].state).toBe('unavailable')
      const watch = vi.spyOn(ctx.raw.sync, 'watch')

      await submitSearch(ctx.host, 'リリース', width < 600 ? '#channel-content' : '#main-content')
      ctx.host.querySelector('#main-content ol button')!.click()
      await settle()

      expect(watch.mock.calls).toEqual([[id]])
      expect(ctx.raw.searchAnchor.get()?.status).toBe('ready')
      expect(ctx.host.querySelector('.ui-message-row--search-match')?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(hit.id)
      expect(ctx.history.pushState).toHaveBeenCalledOnce()
    } finally {
      await ctx.close()
      vi.useRealTimers()
    }
  })

  it('retries an unresolved author when opening a hit in the selected Channel', async () => {
    const hit = record(37, CH_ID)
    const failure = async () => ({ ok: false, kind: 'network' } as const)
    const lookupAuthors = vi.fn<typeof import('./api').lookupAuthors>(failure)
    const members = createMembers(ORG_ID, vi.fn(), vi.fn(), {
      listMembers: failure, changeRole: failure, deactivateMember: failure, createInvite: failure,
      lookupAuthors, baseUrl: () => 'http://localhost',
    })
    const ctx = await mountSearchWorkspace({
      members, searchSource: hitSource({ ...hit, body: 'リリース' }),
      setupNet(net) { net.pages[CH_ID] = messagePage([hit]) },
    })
    try {
      ctx.net.subscribed(CH_ID, 80)
      await settle()
      await submitSearch(ctx.host, 'リリース')
      expect(lookupAuthors).toHaveBeenLastCalledWith(ORG_ID, { ids: [hit.sender] })
      expect(members.authors.isPending(hit.sender)).toBe(false)
      lookupAuthors.mockResolvedValue(ok({ identities: [{ id: hit.sender, name: '田中 美咲', deactivated: true }] }))
      lookupAuthors.mockClear()

      ctx.host.querySelector('#main-content ol button')!.click()
      await settle()

      expect(lookupAuthors.mock.calls).toEqual([[ORG_ID, { ids: [hit.sender] }]])
      expect(ctx.host.querySelector('.ui-message-row--search-match')?.textContent).toContain('田中 美咲（無効）')
    } finally {
      await ctx.close()
    }
  })

  it('retries stopped main Unread entry when opening a Reply hit in the selected DM', async () => {
    vi.useFakeTimers()
    const root = record(1, DM_ID)
    const reply = { ...record(2, DM_ID), reply_root_id: root.id, reply_to: root.id }
    const conversation = dm(DM_ID, { as_of_seq: 2, read_seq: 0, main_unread_count: 2, unread_count: 2 })
    const ctx = await mountSearchWorkspace({
      channelList: 'loading',
      href: `/o/${ORG_ID}/c/${DM_ID}`,
      dmsApi: dmSource(conversation),
      searchSource: hitSource({ ...reply, body: 'リリース' }, 'dm'),
      setupNet(net) {
        net.unreadListResult = ok({ history_generation: historyGeneration, channels: [] })
        net.pages[DM_ID] = ok({ history_generation: historyGeneration, as_of_seq: 2, messages: [root, reply], has_more: false })
        net.replyChains[`${DM_ID}:${reply.id}`] = ok(replyPage({
          history_generation: historyGeneration, as_of_seq: 2, root_id: root.id, messages: [root, reply], has_more: false,
        }))
      },
    })
    try {
      ctx.net.socket.onEvent({ type: 'activity_ready' })
      await vi.advanceTimersByTimeAsync(1000)
      ctx.raw.dms.select(DM_ID)
      await settle()
      ctx.net.subscribed(DM_ID, 2)
      await settle()
      await submitSearch(ctx.host, 'リリース')
      ctx.raw.unread.activityDmSnapshot(conversation, false)
      const scope = { channel: DM_ID, topicId: null }
      ctx.net.markReadResults[`${DM_ID}:`] = { ok: false, kind: 'http', status: 400, error: 'bad_request' }
      ctx.raw.unread.visibility(true)
      const visit = await ctx.raw.unread.enter(scope)
      expect(visit).toBeDefined()
      expect(ctx.raw.unread.get(DM_ID).entry).toMatchObject({ boundary: 0, unreadAtEntry: 2 })
      ctx.raw.unread.presented(visit!, [1, 2])
      await settle()
      expect(ctx.net.markReads).toHaveLength(1)
      expect(ctx.raw.unread.get(DM_ID).main.stopped).toBe(true)

      const enter = vi.spyOn(ctx.raw.unread, 'enter')
      ctx.host.querySelector('#main-content ol button')!.click()
      expect(enter.mock.calls).toEqual([[scope]])
      expect(ctx.raw.unread.get(DM_ID).main.stopped).toBe(false)
      await settle()
      expect(ctx.navigation.get().target?.panel).toBe(`reply:${reply.id}`)
      expect(dom.doc.activeElement).toBe(ctx.host.querySelector('#panel-content textarea'))
    } finally {
      await ctx.close()
      vi.useRealTimers()
    }
  })

  it('keeps the current view and shows an inline notice when selecting a DM hit that names a Topic', async () => {
    const ctx = await mountSearchWorkspace({
      searchSource: hitSource({ ...record(37, DM_ID), body: 'リリース', topic_id: 'topic-x' }, 'dm'),
    })
    try {
      const routeBefore = ctx.navigation.get().target
      await submitSearch(ctx.host, 'リリース')
      ctx.host.querySelector('#main-content ol button')!.click()
      await settle()

      expect(ctx.navigation.get().target).toEqual(routeBefore)
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(ctx.host.querySelector('[data-testid="search-open-notice"]')?.textContent).toContain('開けません')
    } finally {
      await ctx.close()
    }
  })

  it.each([
    ['readable', true],
    ['server-denied', false],
  ] as const)('opens a %s DM hit absent from loaded DM rows through the server', async (_name, readable) => {
    vi.useFakeTimers()
    const hit = { ...record(37, DM_ID), id: 'dm-hit', body: 'リリース古いDM' }
    const ctx = await mountSearchWorkspace({
      channelRows: [channel(CH_ID, 'general')],
      searchSource: hitSource(hit, 'dm'),
      setupNet(net) {
        net.pages[DM_ID] = readable
          ? messagePage([hit])
          : { ok: false, kind: 'http', status: 404, error: 'channel not found' }
      },
    })
    try {
      await submitSearch(ctx.host, 'リリース古いDM')
      ctx.host.querySelector('#main-content ol button')!.click()
      await vi.advanceTimersByTimeAsync(1000)
      await settle()

      expect(ctx.location.href).toBe(`/o/${ORG_ID}/c/${DM_ID}`)
      expect(ctx.host.querySelector('[data-testid="search-open-notice"]')).toBeNull()
      if (readable) {
        expect(ctx.host.querySelector('#main-content .ui-message-row--search-match')
          ?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(hit.id)
      } else {
        expect(ctx.raw.sync.get().channels[DM_ID].state).toBe('unavailable')
        expect(ctx.host.querySelector('[data-message-id="dm-hit"]')).toBeNull()
      }
    } finally {
      await ctx.close()
      vi.useRealTimers()
    }
  })

  it('opens a readable hit in an accessible archived Channel even when absent from loaded Channel lists', async () => {
    vi.useFakeTimers()
    const ARCHIVED_CH_ID = '00000000-0000-4000-8000-000000000099'
    const archivedChannel = { ...channel(ARCHIVED_CH_ID, 'legacy-archive'), archived: true }
    const hit = { ...record(37, ARCHIVED_CH_ID), id: 'archived-hit', body: 'リリースアーカイブ' }
    const getChannel = vi.fn(async (id: string) =>
      id === ARCHIVED_CH_ID ? ok(archivedChannel) : ({ ok: false as const, kind: 'http' as const, status: 404, error: 'channel not found' }),
    )
    const ctx = await mountSearchWorkspace({
      channelRows: [channel(CH_ID, 'general')],
      searchSource: hitSource(hit, 'channel'),
      setupNet(net, options) {
        net.pages[ARCHIVED_CH_ID] = messagePage([hit])
        options.channelsApi!.getChannel = getChannel
      },
    })
    try {
      expect(ctx.raw.channels.get().channels.some((c) => c.id === ARCHIVED_CH_ID)).toBe(false)
      expect(ctx.raw.channels.get().archivedList).toBeUndefined()
      expect(ctx.raw.channels.get().openChannel).toBeUndefined()

      await submitSearch(ctx.host, 'リリースアーカイブ')
      ctx.host.querySelector('#main-content ol button')!.click()
      await vi.advanceTimersByTimeAsync(1000)
      await settle()

      expect(ctx.location.href).toBe(`/o/${ORG_ID}/c/${ARCHIVED_CH_ID}`)
      expect(ctx.raw.channels.get().selectedId).toBe(ARCHIVED_CH_ID)
      expect(getChannel).toHaveBeenCalledWith(ARCHIVED_CH_ID, expect.anything())
      expect(ctx.raw.channels.get().openChannel?.id).toBe(ARCHIVED_CH_ID)
      expect(ctx.host.querySelector('#main-content .ui-message-row--search-match')
        ?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(hit.id)
      const composer = ctx.host.querySelector('#main-content textarea')!
      expect(composer.disabled).toBe(true)
    } finally {
      await ctx.close()
      vi.useRealTimers()
    }
  })

  it('removes revoked Channel hits from search and drops them from an in-flight page that resolves later', async () => {
    const delayedMore = deferred<SearchResponse>()
    let step = 0
    const ctx = await mountSearchWorkspace({
      channelRows: [channel(CH_ID, 'general'), channel(OTHER_CH_ID, 'secret')],
      searchSource: {
        search() {
          step += 1
          if (step === 1) {
            return Promise.resolve({
              ok: true,
              page: {
                hits: [
                  makeSearchHit(1, { id: 'sec-1', channel_id: OTHER_CH_ID, body: '機密 1' }),
                  makeSearchHit(2, { id: 'gen-1', channel_id: CH_ID, body: '機密 2' }),
                ],
                next_cursor: 'cur-1',
              },
            })
          }
          return delayedMore.promise
        },
      },
    })
    try {
      await submitSearch(ctx.host, '機密')
      expect(queryAll(ctx.host, '#main-content ol article').map((a) => a.textContent)).toEqual([
        expect.stringContaining('機密 1'),
        expect.stringContaining('機密 2'),
      ])

      const loadMoreBtn = queryAll(ctx.host, '#main-content button').find((b) => b.textContent.trim() === 'さらに読み込む')!
      loadMoreBtn.click()
      await settle()

      // Channel access is revoked while page 2 is still in flight.
      ctx.net.socket.onEvent({ type: 'channel_access_revoked', channel_id: OTHER_CH_ID })
      await settle()

      expect(queryAll(ctx.host, '#main-content ol article').map((a) => a.textContent)).toEqual([
        expect.stringContaining('機密 2'),
      ])

      delayedMore.resolve({
        ok: true,
        page: {
          hits: [
            makeSearchHit(3, { id: 'sec-2', channel_id: OTHER_CH_ID, body: '機密 3' }),
            makeSearchHit(4, { id: 'gen-2', channel_id: CH_ID, body: '機密 4' }),
          ],
          next_cursor: null,
        },
      })
      await settle()

      const texts = queryAll(ctx.host, '#main-content ol article').map((a) => a.textContent)
      expect(texts).toHaveLength(2)
      expect(texts[0]).toContain('機密 2')
      expect(texts[1]).toContain('機密 4')
      expect(texts.join(' ')).not.toContain('機密 1')
      expect(texts.join(' ')).not.toContain('機密 3')
    } finally {
      await ctx.close()
    }
  })

  it('exposes search at the phone Channel-list level (375 px) and transitions to results and back', async () => {
    const ctx = await mountSearchWorkspace({ width: 375, href: `http://localhost/o/${ORG_ID}` })
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      expect(workspace.getAttribute('data-mobile-level')).toBe('channels')

      const listForm = ctx.host.querySelector('.channel-column [role="search"]')
      expect(listForm).not.toBeNull()
      const listInput = listForm!.querySelector('input')!
      listInput.focus()
      listInput.value = 'リリース'
      listInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      listForm!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      expect(workspace.getAttribute('data-mobile-level')).toBe('view')
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      const mainSearchInput = ctx.host.querySelector('#main-content [role="search"] input')!
      expect(dom.doc.activeElement).toBe(mainSearchInput)

      const backBtn = queryAll(ctx.host, '#main-content header button').find((b) => b.textContent.includes('戻る'))!
      backBtn.click()
      await settle()

      expect(workspace.getAttribute('data-mobile-level')).toBe('channels')
      const restoredListInput = ctx.host.querySelector('.channel-column [role="search"] input')!
      expect(dom.doc.activeElement).toBe(restoredListInput)
    } finally {
      await ctx.close()
    }
  })

  it('closes the same topmost layer on Escape regardless of focus inside search', async () => {
    const ctx = await mountSearchWorkspace({
      href: `http://localhost/o/${ORG_ID}/c/${CH_ID}?panel=topics`,
    })
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      expect(workspace.getAttribute('data-panel-open')).toBe('true')

      const form = ctx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.focus()
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')

      // First Escape from the focused search input closes the topmost layer (the right panel), keeping search open.
      const esc1 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc1.key = 'Escape'
      input.dispatchEvent(esc1)
      await settle()
      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')

      // Second Escape closes search.
      const esc2 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc2.key = 'Escape'
      input.dispatchEvent(esc2)
      await settle()
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).not.toBe('検索結果')
    } finally {
      await ctx.close()
    }
  })

  it('keeps Topic view Shift+Tab order from Composer -> roving row -> panel toggle -> チャンネルへ戻る ahead of SearchBar', async () => {
    const topicMsg = {
      ...record(1, CH_ID),
      body: 'トピック本文',
      topic_id: TOPIC_ID,
      topic_name: 'キーボード議題',
    }
    const ctx = await mountSearchWorkspace({
      href: `http://localhost/o/${ORG_ID}/c/${CH_ID}/t/${TOPIC_ID}`,
      setupNet(net) {
        net.topicMessages[`${CH_ID}:${TOPIC_ID}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 1,
          messages: [topicMsg],
          has_more: false,
        })
        net.topicSummaries[`${CH_ID}:${TOPIC_ID}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 1,
          topic: {
            mention_unread_count: 0,
            id: TOPIC_ID,
            name: 'キーボード議題',
            first_seq: 1,
            last_seq: 1,
            message_count: 1,
            latest_message: topicMsg,
            read_seq: 0,
            unread_count: 0,
          },
        })
      },
    })
    try {
      const main = ctx.host.querySelector('#main-content')!
      // Collect desktop-visible tabbable elements in DOM order inside #main-content
      // (.mobile-only wrappers are display: none at 1280px).
      const tabbables: MiniElement[] = []
      const walk = (node: MiniElement) => {
        if ((node.getAttribute('class') ?? '').split(/\s+/).includes('mobile-only')) return
        const tag = node.tagName.toLowerCase()
        const tabindex = node.getAttribute('tabindex')
        const disabled = node.hasAttribute('disabled') || (node as unknown as { disabled?: boolean }).disabled === true
        const naturallyTabbable = tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || (tag === 'a' && node.hasAttribute('href'))
        const isTabbable = !disabled && (
          (naturallyTabbable && tabindex !== '-1') ||
          (tabindex !== null && tabindex !== '' && Number(tabindex) >= 0)
        )
        if (isTabbable) tabbables.push(node)
        for (const child of node.childNodes) {
          if (child instanceof MiniElement) walk(child)
        }
      }
      walk(main)

      const composer = main.querySelector('textarea')!
      const rovingRow = main.querySelector('.ui-message-row[data-focusable="true"][tabindex="0"]')!
      const panelToggle = main.querySelector('button[aria-label="パネルを開く(⌘.)"]')!
      const backButton = queryAll(main, 'button').find((b) => b.textContent.includes('チャンネルへ戻る'))!
      const searchSubmit = queryAll(main, '[role="search"] button').find((b) => b.textContent.trim() === '検索')!
      const searchInput = main.querySelector('[role="search"] input')!

      const composerIdx = tabbables.indexOf(composer)
      expect(composerIdx).toBeGreaterThanOrEqual(5)
      // Shift+Tab x1 -> roving Message row, x2 -> panel toggle, x3 -> チャンネルへ戻る (matching e2e/topics.spec.ts & e2e/unread.spec.ts)
      expect(tabbables[composerIdx - 1]).toBe(rovingRow)
      expect(tabbables[composerIdx - 2]).toBe(panelToggle)
      expect(tabbables[composerIdx - 3]).toBe(backButton)
      // SearchBar controls precede the view header row in DOM and visual order.
      expect(tabbables[composerIdx - 4]).toBe(searchSubmit)
      expect(tabbables[composerIdx - 5]).toBe(searchInput)
    } finally {
      await ctx.close()
    }
  })

  it('keeps reverse Tab order from Topic Composer to the roving MessageRow after closing a Reply panel with search closed', async () => {
    const topicMsg1 = {
      ...record(1, CH_ID),
      body: 'トピック内の親メッセージ',
      topic_id: TOPIC_ID,
      topic_name: '仕様確認',
    }
    const topicMsg2 = {
      ...record(2, CH_ID),
      body: 'トピック内の返信-01',
      topic_id: TOPIC_ID,
      topic_name: '仕様確認',
      reply_to: topicMsg1.id,
      reply_root_id: topicMsg1.id,
    }
    const ctx = await mountSearchWorkspace({
      href: `http://localhost/o/${ORG_ID}/c/${CH_ID}/t/${TOPIC_ID}?panel=reply:${topicMsg1.id}`,
      setupNet(net) {
        net.topicMessages[`${CH_ID}:${TOPIC_ID}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 2,
          messages: [topicMsg1, topicMsg2],
          has_more: false,
        })
        net.topicSummaries[`${CH_ID}:${TOPIC_ID}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 2,
          topic: {
            mention_unread_count: 0,
            id: TOPIC_ID,
            name: '仕様確認',
            first_seq: 1,
            last_seq: 2,
            message_count: 2,
            latest_message: topicMsg2,
            read_seq: 2,
            unread_count: 0,
          },
        })
        net.replyChains[`${CH_ID}:${topicMsg1.id}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 2,
          root_id: topicMsg1.id,
          chain_version: 2,
          messages: [topicMsg1, topicMsg2],
          has_more: false,
        })
        net.replyChains[`${CH_ID}:${topicMsg2.id}`] = ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          as_of_seq: 2,
          root_id: topicMsg1.id,
          chain_version: 2,
          messages: [topicMsg1, topicMsg2],
          has_more: false,
        })
      },
    })
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      expect(workspace.getAttribute('data-panel-open')).toBe('true')

      // Close Reply panel via × with search closed: focus returns to main Topic Composer.
      const closeBtn = ctx.host.querySelector('#panel-content button[aria-label="パネルを閉じる(Esc)"]')!
      closeBtn.click()
      await settle()
      expect(workspace.getAttribute('data-panel-open')).toBe('false')

      const main = ctx.host.querySelector('#main-content')!
      const composer = main.querySelector('textarea')!
      expect(dom.doc.activeElement).toBe(composer)

      // Fill a non-empty draft and verify reverse Tab from Composer reaches the roving tabindex="0" row directly.
      composer.value = '消さずに残すトピック下書き'
      composer.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      composer.focus()

      const tabbables: MiniElement[] = []
      const walk = (node: MiniElement) => {
        if ((node.getAttribute('class') ?? '').split(/\s+/).includes('mobile-only')) return
        const tag = node.tagName.toLowerCase()
        const tabindex = node.getAttribute('tabindex')
        const disabled = node.hasAttribute('disabled') || (node as unknown as { disabled?: boolean }).disabled === true
        const naturallyTabbable = tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || (tag === 'a' && node.hasAttribute('href'))
        const isTabbable = !disabled && (
          (naturallyTabbable && tabindex !== '-1') ||
          (tabindex !== null && tabindex !== '' && Number(tabindex) >= 0)
        )
        if (isTabbable) tabbables.push(node)
        for (const child of node.childNodes) {
          if (child instanceof MiniElement) walk(child)
        }
      }
      walk(main)

      const rovingRow = main.querySelector(`[data-message-id="${topicMsg2.id}"] .ui-message-row`)!
      expect(rovingRow.getAttribute('tabindex')).toBe('0')
      const composerIdx = tabbables.indexOf(composer)
      expect(tabbables[composerIdx - 1]).toBe(rovingRow)

      // Simulate Shift+Tab landing on rovingRow, press 'r' to open Reply panel without clearing draft, then Escape.
      rovingRow.focus()
      expect(dom.doc.activeElement).toBe(rovingRow)
      const openKey = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      openKey.key = 'r'
      rovingRow.dispatchEvent(openKey)
      await settle()

      expect(workspace.getAttribute('data-panel-open')).toBe('true')
      expect(dom.doc.activeElement).toBe(ctx.host.querySelector('#panel-content textarea'))
      expect(composer.value).toBe('消さずに残すトピック下書き')

      const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc.key = 'Escape'
      ctx.host.querySelector('#panel-content textarea')!.dispatchEvent(esc)
      await settle()

      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(dom.doc.activeElement).toBe(rovingRow)
    } finally {
      await ctx.close()
    }
  })

  it('restores keyboard focus inside search when closing a panel via Escape while search stays open', async () => {
    const ctx = await mountSearchWorkspace()
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      const form = ctx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.focus()
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')

      // Focus a search hit, open the Topics panel with Cmd+., then press Escape from its heading.
      const hitButton = ctx.host.querySelector('#main-content ol button')!
      hitButton.focus()
      expect(dom.doc.activeElement).toBe(hitButton)

      const togglePanel = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      togglePanel.key = '.'
      togglePanel.metaKey = true
      dom.win.dispatchEvent(togglePanel)
      await settle()
      expect(workspace.getAttribute('data-panel-open')).toBe('true')
      const panelHeading = ctx.host.querySelector('#panel-content h2')!
      expect(dom.doc.activeElement).toBe(panelHeading)

      const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc.key = 'Escape'
      panelHeading.dispatchEvent(esc)
      await settle()

      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(dom.doc.activeElement).toBe(hitButton)
      expect(dom.doc.activeElement?.isConnected).toBe(true)
    } finally {
      await ctx.close()
    }
  })

  it('falls back to the search input when closing a pre-opened panel while search stays open', async () => {
    const ctx = await mountSearchWorkspace({
      href: `http://localhost/o/${ORG_ID}/c/${CH_ID}?panel=topics`,
    })
    try {
      const workspace = ctx.host.querySelector('.workspace')!
      const form = ctx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.focus()
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      const panelHeading = ctx.host.querySelector('#panel-content h2')!
      panelHeading.focus()
      expect(dom.doc.activeElement).toBe(panelHeading)

      const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc.key = 'Escape'
      panelHeading.dispatchEvent(esc)
      await settle()

      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(dom.doc.activeElement).toBe(input)
      expect(dom.doc.activeElement?.isConnected).toBe(true)
    } finally {
      await ctx.close()
    }
  })

  it('announces unavailable search and unopenable hits through the existing page live region without adding new live regions', async () => {
    const prodAnnouncements: string[] = []
    const prodCtx = await mountSearchWorkspace({
      searchSource: createDefaultSearchSource(ORG_ID, {
        searchApi: async () => ({ ok: false, kind: 'network', error: 'search_unavailable' }),
      }),
      onannounce: (msg) => prodAnnouncements.push(msg),
    })
    try {
      const form = prodCtx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.focus()
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      expect(dom.doc.activeElement).toBe(input)
      expect(prodCtx.host.textContent).toContain('メッセージ検索は現在準備中です。')
      expect(prodAnnouncements).toContain('メッセージ検索は現在準備中です。')
      expect(queryAll(prodCtx.host, '#main-content [role="status"]')).toHaveLength(0)
    } finally {
      await prodCtx.close()
    }

    const mockAnnouncements: string[] = []
    const mockCtx = await mountSearchWorkspace({
      searchSource: hitSource({ ...record(37, DM_ID), body: 'リリース', topic_id: 'topic-x' }, 'dm'),
      onannounce: (msg) => mockAnnouncements.push(msg),
    })
    try {
      const form = mockCtx.host.querySelector('#main-content [role="search"]')!
      const input = form.querySelector('input')!
      input.value = 'リリース'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()

      const hitButton = mockCtx.host.querySelector('#main-content ol button')!
      hitButton.click()
      await settle()

      expect(dom.doc.activeElement).toBe(hitButton)
      expect(mockCtx.host.querySelector('[data-testid="search-open-notice"]')?.textContent).toContain('開けません')
      expect(mockAnnouncements.some((msg) => msg.includes('開けません'))).toBe(true)
      expect(queryAll(mockCtx.host, '#main-content [role="status"]')).toHaveLength(0)
    } finally {
      await mockCtx.close()
    }
  })

  it('rejects a hit with a listed Channel and a missing Topic, keeping search open with an announced notice', async () => {
    const announcements: string[] = []
    const missingTopicId = '00000000-0000-4000-8000-000000000999'
    const ctx = await mountSearchWorkspace({
      onannounce: (msg) => announcements.push(msg),
      searchSource: createMockSearchSource({
        hits: [
          makeSearchHit(37, {
            id: 'msg-missing-topic',
            created_seq: 37,
            channel_id: CH_ID,
            topic_id: missingTopicId,
            reply_root_id: null,
            body: '存在しないトピックの検索ヒット',
          }),
        ],
      }),
    })
    try {
      const before = ctx.navigation.get()
      const hrefBefore = ctx.location.href
      await submitSearch(ctx.host, '存在しないトピック')

      const hitButton = ctx.host.querySelector('#main-content ol button')!
      hitButton.click()
      await settle()

      expect(ctx.navigation.get()).toBe(before)
      expect(ctx.location.href).toBe(hrefBefore)
      expect(ctx.history.pushState).not.toHaveBeenCalled()
      expect(ctx.history.replaceState).not.toHaveBeenCalled()
      expect(ctx.history.state).toBeNull()
      expect(ctx.host.querySelector('#main-content h1')?.textContent.trim()).toBe('検索結果')
      expect(ctx.host.querySelector('[data-testid="search-open-notice"]')?.textContent).toContain('この検索結果は現在開けません。')
      expect(announcements).toContain('この検索結果は現在開けません。')
    } finally {
      await ctx.close()
    }
  })

  it('resolves Channel, already-loaded Topic, DM peer, and message-authors names without N+1 topic fetches', async () => {
    vi.useFakeTimers()
    const unloadedTopicId = '00000000-0000-4000-8000-000000000021'
    const senderA = '00000000-0000-4000-8000-000000000101'
    const senderB = '00000000-0000-4000-8000-000000000102'
    const lookupAuthors = vi.fn<typeof import('./api').lookupAuthors>(async (_org, body) =>
      ok({
        identities: body.ids.map((id) =>
          id === senderA
            ? { id, name: '田中 美咲', deactivated: true }
            : { id, name: '佐藤 健', deactivated: false },
        ),
      }),
    )
    const getTopicSummary = vi.fn(async () => ({ ok: false as const, kind: 'network' as const }))
    const failure = async () => ({ ok: false, kind: 'network' } as const)
    const members = createMembers(ORG_ID, vi.fn(), vi.fn(), {
      listMembers: failure, changeRole: failure, deactivateMember: failure, createInvite: failure,
      lookupAuthors, baseUrl: () => 'http://localhost',
    })
    const topicMsg = {
      ...record(1, CH_ID),
      topic_id: TOPIC_ID,
      body: 'ロード済みトピック',
    }
    const ctx = await mountSearchWorkspace({
      members,
      channelRows: [channel(CH_ID, 'general'), channel(OTHER_CH_ID, 'dev')],
      dmsApi: dmSource(dm(DM_ID, { peer: { id: 'peer-1', name: '鈴木 花子', active: false } })),
      searchSource: createMockSearchSource({
        hits: [
          makeSearchHit(1, { id: 'h-loaded-topic', channel_id: CH_ID, topic_id: TOPIC_ID, sender: senderA, body: '検索ヒット トピックあり' }),
          makeSearchHit(2, { id: 'h-unloaded-topic', channel_id: OTHER_CH_ID, topic_id: unloadedTopicId, sender: senderB, body: '検索ヒット トピック未ロード' }),
          makeSearchHit(3, { id: 'h-dm', channel_id: DM_ID, sender: senderB, body: '検索ヒット DM' }, 'dm'),
        ],
      }),
      setupNet(net, options) {
        net.topicSummaries[`${CH_ID}:${TOPIC_ID}`] = ok({
          history_generation: historyGeneration,
          as_of_seq: 1,
          topic: {
            mention_unread_count: 0,
            id: TOPIC_ID,
            name: 'リリース準備',
            first_seq: 1,
            last_seq: 1,
            message_count: 1,
            latest_message: topicMsg,
            read_seq: 1,
            unread_count: 0,
          },
        })
        const origSummary = options.topicsApi!.getTopicSummary
        options.topicsApi!.getTopicSummary = (c, t, signal) => {
          if (c === OTHER_CH_ID) return getTopicSummary()
          return origSummary(c, t, signal)
        }
      },
    })
    try {
      ctx.net.socket.onEvent({ type: 'activity_ready' })
      await vi.advanceTimersByTimeAsync(1000)
      await ctx.raw.topics.loadSummary(CH_ID, TOPIC_ID)
      await settle()
      lookupAuthors.mockClear()

      await submitSearch(ctx.host, '検索ヒット')
      await settle()

      const buttons = queryAll(ctx.host, '#main-content ol button')
      expect(buttons).toHaveLength(3)
      expect(buttons[0].textContent).toContain('# general › リリース準備')
      expect(buttons[0].textContent).toContain('田中 美咲（無効）')
      expect(buttons[1].textContent).toContain('# dev')
      expect(buttons[1].textContent).not.toContain('›')
      expect(buttons[1].textContent).toContain('佐藤 健')
      expect(buttons[2].textContent).toContain('ダイレクトメッセージ: 鈴木 花子（無効）')
      expect(getTopicSummary).not.toHaveBeenCalled()
      expect(lookupAuthors).toHaveBeenCalledTimes(1)
      expect(new Set(lookupAuthors.mock.calls[0][1].ids)).toEqual(new Set([senderA, senderB]))
    } finally {
      await ctx.close()
      vi.useRealTimers()
    }
  })
})
