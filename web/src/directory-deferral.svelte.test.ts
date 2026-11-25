import { mount, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './api'
import type { DisplayIdentity, lookupAuthors, listMembers, Member, MemberList, Result } from './api'
import { FIRST_DISPLAY_AUTHORS_TIMEOUT_MS } from './authors'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createChannelMembers } from './channel-members'
import { rememberIdentityResponse } from './identity-order'
import { createMembers, watchMemberAccess } from './members'
import { membersAdapter } from './members.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import { unreadAdapter } from './unread.svelte'
import Workspace from './Workspace.svelte'
import { buttonsByText, installMiniDom, MiniDomEvent, MiniElement, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

afterEach(() => vi.useRealTimers())

function makeNavigation(initialHref: string) {
  let href = initialHref
  return createNavigation({
    location: { get href() { return href } },
    history: {
      state: null,
      pushState(_s: unknown, _t: string, url: string) { href = url },
      replaceState(_s: unknown, _t: string, url: string) { href = url },
    },
    innerWidth: 1280,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as NavigationBrowser)
}

function makeWorkspace(options: {
  initialHref?: string
  timelineItems?: api.TimelineItem[]
  listMembers?: typeof listMembers
  lookupAuthors?: typeof lookupAuthors
  role?: api.Role
  onannounce?: (msg: string) => void
  firstDisplayTimeoutMs?: number
}) {
  const net = fakeNetwork()
  const self: Member = { id: 'me', name: '自分', role: options.role ?? 'member' }
  if (options.timelineItems) {
    net.timelines.c1 = ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: options.timelineItems.length,
      has_more: false,
      items: options.timelineItems,
    })
  }
  const rawSession = createSession({
    selfId: self.id,
    organizationId: 'org-1',
    initialRole: self.role,
    onEnded: vi.fn(),
    ...net.options(self.id),
  })
  const listMembersFn = options.listMembers ?? vi.fn<typeof listMembers>(async () => ok({ members: [self] }))
  const lookupAuthorsFn = options.lookupAuthors ?? vi.fn<typeof lookupAuthors>(async () => ok({ identities: [] }))
  const memberController = createMembers('org-1', vi.fn(), vi.fn(), {
    listMembers: listMembersFn,
    lookupAuthors: lookupAuthorsFn,
    changeRole: vi.fn(),
    deactivateMember: vi.fn(),
    createInvite: vi.fn(),
    firstDisplayTimeoutMs: options.firstDisplayTimeoutMs,
    baseUrl: () => '',
  }, rawSession.memberListAccess)
  rawSession.holdActivity('members', memberController.activityTarget)
  const stopRefresh = watchMemberAccess(rawSession.channels, rawSession.sync, reason => {
    if (reason === 'access') memberController.activityTarget.invalidate('access')
    else void memberController.refreshIfActive()
  })
  const channelMembers = createChannelMembers('org-1', 'c1', vi.fn(), {
    ...api,
    listChannelMembers: async () => ok({ members: [{ ...self, manager: false }] }),
  })
  const sessionModel = {
    channels: channelsAdapter(rawSession.channels),
    sync: syncAdapter(rawSession.sync),
    topics: (id: string) => topicsAdapter(rawSession.topics, id),
    unread: (id: string) => unreadAdapter(rawSession.unread, id),
    navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
    channelMembers: vi.fn(() => channelMembers),
    close: rawSession.close,
  }
  const navigation = makeNavigation(options.initialHref ?? '/o/org-1/c/c1')
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const instance = mount(Workspace, {
    target: host as unknown as Element,
    props: {
      navigation,
      session: sessionModel,
      selectedOrganizationId: 'org-1',
      members: membersAdapter(memberController),
      organization: {
        member: self,
        organization: {
          organization_id: 'org-1',
          name: 'Acme',
          capabilities: {
            can_create_channels: { allowed: self.role !== 'guest' },
            can_invite: { allowed: false },
            can_deactivate_members: { allowed: false },
            can_manage_roles: { allowed: false },
          },
        },
      },
      onannounce: options.onannounce,
    },
  })
  return {
    net,
    host,
    navigation,
    memberController,
    listMembersFn,
    lookupAuthorsFn,
    async cleanup() {
      stopRefresh()
      navigation.destroy()
      await unmount(instance)
      memberController.close()
      channelMembers.close()
      rawSession.close()
    },
  }
}

describe('Deferred Member directory and first-display author resolution (#954 R1)', () => {
  it('resolves first-row sender names (active and deactivated) before first display and activates directory once after milestone', async () => {
    vi.useFakeTimers()
    const meSpy = vi.spyOn(api, 'getOrganizationMe').mockResolvedValue(ok({
      member: { id: 'me', name: '自分', role: 'member' },
      organization: {
        organization_id: 'org-1',
        name: 'Acme',
        capabilities: {
          can_create_channels: { allowed: true },
          can_invite: { allowed: false },
          can_deactivate_members: { allowed: false },
          can_manage_roles: { allowed: false },
        },
      },
    }))
    const finishes: Array<(result: Result<{ identities: DisplayIdentity[] }>) => void> = []
    const lookupAuthorsFn = vi.fn<typeof lookupAuthors>(() => new Promise(resolve => { finishes.push(resolve) }))
    const listMembersFn = vi.fn<typeof listMembers>(async () => ok({
      members: [
        { id: 'me', name: '自分', role: 'member' },
        { id: 'alice', name: 'アリス', role: 'member' },
      ],
    }))
    const w = makeWorkspace({
      timelineItems: [
        { kind: 'message', message: { ...record(1, 'c1'), sender: 'alice', body: 'こんにちは' } },
        { kind: 'message', message: { ...record(2, 'c1'), sender: 'bob', body: '退会済み' } },
        { kind: 'message', message: { ...record(3, 'c1'), sender: 'me', body: '自分です' } },
      ],
      listMembers: listMembersFn,
      lookupAuthors: lookupAuthorsFn,
    })
    try {
      // Connect edge, initial Channel list addition, and activity_ready must not start the directory.
      w.net.socket.onReady()
      w.net.lists[0].resolve(ok({
        history_generation: '00000000-0000-4000-8000-000000000515',
        channels: [channel('c1', 'general')],
      }))
      await settle()
      w.net.socket.onEvent({ type: 'activity_ready' })
      // Even after activity_ready's 200ms Role revalidation completes, directory stays deferred before first display.
      await vi.advanceTimersByTimeAsync(200)
      await settle()
      expect(meSpy).toHaveBeenCalledTimes(1)

      // First-page rows wait for scoped author lookup; directory has not started.
      expect(lookupAuthorsFn).toHaveBeenCalledTimes(1)
      expect(lookupAuthorsFn.mock.calls[0][1].ids).toEqual(expect.arrayContaining(['alice', 'bob']))
      expect(w.host.querySelector('.timeline-list .timeline-list__item')).toBeNull()
      expect(listMembersFn).not.toHaveBeenCalled()

      // Resolve scoped authors: first display renders immediately with resolved active & deactivated labels.
      finishes.at(-1)!(ok({
        identities: [
          { id: 'alice', name: 'アリス', deactivated: false },
          { id: 'bob', name: 'ボブ', deactivated: true },
        ],
      }))
      await settle()

      const senders = queryAll(w.host, '.timeline-list .ui-message-row__sender').map(el => el.textContent)
      expect(senders).toEqual(['アリス', 'ボブ（無効）', '自分'])
      // Directory has not started synchronously before DOM display completes.
      expect(listMembersFn).not.toHaveBeenCalled()

      // Milestone activates the directory exactly once after first display.
      await vi.advanceTimersByTimeAsync(1)
      await settle()
      expect(listMembersFn).toHaveBeenCalledTimes(1)

      // Repeated milestone calls do not re-fetch.
      w.memberController.scheduleActivate()
      w.memberController.activate()
      await vi.advanceTimersByTimeAsync(1)
      expect(listMembersFn).toHaveBeenCalledTimes(1)
    } finally { meSpy.mockRestore(); await w.cleanup() }
  })

  it('activates directory on first use (member panel, channel members tab, mention picker) before milestone without duplicate load', async () => {
    for (const consumer of ['member-panel', 'channel-members', 'mention-picker'] as const) {
      vi.useFakeTimers()
      let finishLookup!: (result: Result<{ identities: DisplayIdentity[] }>) => void
      const lookupAuthorsFn = vi.fn<typeof lookupAuthors>(() => new Promise(resolve => { finishLookup = resolve }))
      const listMembersFn = vi.fn<typeof listMembers>(async () => ok({
        members: [
          { id: 'me', name: '自分', role: 'member' },
          { id: 'alice', name: 'アリス', role: 'member' },
        ],
      }))
      const w = makeWorkspace({
        timelineItems: [
          { kind: 'message', message: { ...record(1, 'c1'), sender: 'alice', body: '本文' } },
        ],
        listMembers: listMembersFn,
        lookupAuthors: lookupAuthorsFn,
      })
      try {
        w.net.socket.onReady()
        w.net.lists[0].resolve(ok({
          history_generation: '00000000-0000-4000-8000-000000000515',
          channels: [channel('c1', 'general')],
        }))
        await settle()
        expect(listMembersFn, consumer).not.toHaveBeenCalled()

        if (consumer === 'member-panel') {
          const details = w.host.querySelector('details.member-list') as MiniElement & { open: boolean }
          details.open = true
        } else if (consumer === 'channel-members') {
          w.navigation.navigate({ type: 'tab', tab: 'members' })
        } else {
          const textarea = w.host.querySelector('textarea[name="body"]') as MiniElement & { value: string; selectionStart: number }
          textarea.value = '@ア'
          textarea.selectionStart = 2
          textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
        }
        await settle()
        expect(listMembersFn, `${consumer} activates on first use`).toHaveBeenCalledTimes(1)

        // Completing first display afterward must not trigger a second directory load.
        finishLookup(ok({ identities: [{ id: 'alice', name: 'アリス', deactivated: false }] }))
        await settle()
        await vi.advanceTimersByTimeAsync(0)
        await settle()
        expect(listMembersFn, `${consumer} does not duplicate at milestone`).toHaveBeenCalledTimes(1)
      } finally { await w.cleanup(); vi.useRealTimers() }
    }
  })

  it('does not block first display when author lookup fails, showing メンバー and filling in from directory', async () => {
    vi.useFakeTimers()
    const lookupAuthorsFn = vi.fn<typeof lookupAuthors>(async () => ({ ok: false, kind: 'network' }))
    let finishDirectory!: (result: Result<MemberList>) => void
    const listMembersFn = vi.fn<typeof listMembers>(() => new Promise(resolve => { finishDirectory = resolve }))
    const w = makeWorkspace({
      timelineItems: [
        { kind: 'message', message: { ...record(1, 'c1'), sender: 'alice', body: '本文' } },
        { kind: 'message', message: { ...record(2, 'c1'), sender: 'me', body: '自分' } },
      ],
      listMembers: listMembersFn,
      lookupAuthors: lookupAuthorsFn,
    })
    try {
      w.net.socket.onReady()
      w.net.lists[0].resolve(ok({
        history_generation: '00000000-0000-4000-8000-000000000515',
        channels: [channel('c1', 'general')],
      }))
      await settle()

      // Failed lookup unblocks immediately without waiting for timeout.
      const senders = queryAll(w.host, '.timeline-list .ui-message-row__sender').map(el => el.textContent)
      expect(senders).toEqual(['メンバー', '自分'])

      // Directory activates after milestone and fills in alice's name.
      await vi.advanceTimersByTimeAsync(0)
      expect(listMembersFn).toHaveBeenCalledTimes(1)
      finishDirectory(ok({ members: [{ id: 'me', name: '自分', role: 'member' }, { id: 'alice', name: 'アリス', role: 'member' }] }))
      await settle()
      expect(queryAll(w.host, '.timeline-list .ui-message-row__sender').map(el => el.textContent)).toEqual(['アリス', '自分'])
    } finally { await w.cleanup() }
  })

  it('does not block first display when author lookup times out, showing メンバー and filling names in when they arrive', async () => {
    vi.useFakeTimers()
    let finishLookup!: (result: Result<{ identities: DisplayIdentity[] }>) => void
    const lookupAuthorsFn = vi.fn<typeof lookupAuthors>(() => new Promise(resolve => { finishLookup = resolve }))
    const listMembersFn = vi.fn<typeof listMembers>(() => new Promise(() => {}))
    const w = makeWorkspace({
      timelineItems: [
        { kind: 'message', message: { ...record(1, 'c1'), sender: 'alice', body: '遅延本文' } },
        { kind: 'message', message: { ...record(2, 'c1'), sender: 'bob', body: '退会遅延' } },
      ],
      listMembers: listMembersFn,
      lookupAuthors: lookupAuthorsFn,
    })
    try {
      w.net.socket.onReady()
      w.net.lists[0].resolve(ok({
        history_generation: '00000000-0000-4000-8000-000000000515',
        channels: [channel('c1', 'general')],
      }))
      await settle()

      // Still gated right before timeout.
      await vi.advanceTimersByTimeAsync(FIRST_DISPLAY_AUTHORS_TIMEOUT_MS - 1)
      expect(w.host.querySelector('.timeline-list .timeline-list__item')).toBeNull()
      expect(listMembersFn).not.toHaveBeenCalled()

      // At timeout, first display releases with メンバー placeholders.
      await vi.advanceTimersByTimeAsync(1)
      await settle()
      expect(queryAll(w.host, '.timeline-list .ui-message-row__sender').map(el => el.textContent)).toEqual(['メンバー', 'メンバー'])

      // Milestone activates directory once after display.
      await vi.advanceTimersByTimeAsync(1)
      expect(listMembersFn).toHaveBeenCalledTimes(1)

      // Late lookup arrival fills in active and deactivated names in place.
      finishLookup(ok({
        identities: [
          { id: 'alice', name: 'アリス', deactivated: false },
          { id: 'bob', name: 'ボブ', deactivated: true },
        ],
      }))
      await settle()
      expect(queryAll(w.host, '.timeline-list .ui-message-row__sender').map(el => el.textContent)).toEqual(['アリス', 'ボブ（無効）'])
    } finally { await w.cleanup() }
  })

  it('preserves authorized Mention-name override and live-announcement lookup order while directory is deferred', async () => {
    vi.useFakeTimers()
    const targetId = '123e4567-e89b-12d3-a456-426614174000'
    const mentions = [{ member_id: targetId, name: 'メンション名' }]
    rememberIdentityResponse(mentions)
    let finishLiveLookup!: (result: Result<{ identities: DisplayIdentity[] }>) => void
    const lookupAuthorsFn = vi.fn<typeof lookupAuthors>(async (_org, { ids }) => {
      if (ids.includes('deact')) return new Promise(resolve => { finishLiveLookup = resolve })
      return ok({ identities: ids.includes('alice') ? [{ id: 'alice', name: 'アリス', deactivated: false }] : [] })
    })
    let finishDirectory!: (result: Result<MemberList>) => void
    const listMembersFn = vi.fn<typeof listMembers>(() => new Promise(resolve => { finishDirectory = resolve }))
    const announcements: string[] = []
    const w = makeWorkspace({
      timelineItems: [
        {
          kind: 'message',
          message: {
            ...record(1, 'c1'),
            sender: 'alice',
            body: `こんにちは @{member:${targetId}}`,
            mentions,
          },
        },
      ],
      listMembers: listMembersFn,
      lookupAuthors: lookupAuthorsFn,
      onannounce: text => announcements.push(text),
    })
    try {
      w.net.socket.onReady()
      w.net.lists[0].resolve(ok({
        history_generation: '00000000-0000-4000-8000-000000000515',
        channels: [channel('c1', 'general')],
      }))
      await settle()
      w.net.subscribed('c1', 1)
      await settle()
      announcements.length = 0

      // Authorized Mention renders its Message-carried name before the directory loads.
      expect(w.host.querySelector('.timeline-list')?.textContent).toContain('@メンション名')

      // Live message from unknown deactivated author holds announcement until lookup settles.
      const liveMsg = { ...record(2, 'c1'), sender: 'deact', body: 'ライブ通知' }
      w.net.event({ type: 'message', kind: 'create', seq: liveMsg.created_seq, message: liveMsg })
      await settle()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(announcements).toEqual([])
      finishLiveLookup(ok({ identities: [{ id: 'deact', name: '退会者', deactivated: true }] }))
      await settle()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(announcements).toEqual(['退会者（無効）: ライブ通知'])

      // Newer directory response overrides the older Mention name.
      finishDirectory(ok({
        members: [
          { id: 'me', name: '自分', role: 'member' },
          { id: targetId, name: '更新後の名前', role: 'member' },
        ],
      }))
      await settle()
      expect(w.host.querySelector('.timeline-list')?.textContent).toContain('@更新後の名前')
    } finally { await w.cleanup() }
  })

  it('keeps error, empty and unavailable directory views working in MemberList', async () => {
    vi.useFakeTimers()
    const listMembersFn = vi.fn<typeof listMembers>()
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 503 })
      .mockResolvedValueOnce(ok({ members: [] }))
    const w = makeWorkspace({
      timelineItems: [],
      listMembers: listMembersFn,
    })
    try {
      w.net.socket.onReady()
      w.net.lists[0].resolve(ok({
        history_generation: '00000000-0000-4000-8000-000000000515',
        channels: [channel('c1', 'general')],
      }))
      await settle()

      const details = w.host.querySelector('details.member-list') as MiniElement & { open: boolean }
      details.open = true
      await settle()
      // Retryable error view
      expect(details.textContent).toContain('再試行')
      buttonsByText(details, '再試行')[0].click()
      await settle()
      // Empty directory view (no loading, no error, no items)
      expect(details.textContent).not.toContain('読み込み中')
      expect(details.textContent).not.toContain('再試行')
      expect(queryAll(details, '.member-list__item')).toHaveLength(0)

      // Organization unavailable hides the MemberList section and stops requests.
      w.net.socket.onClose(4003)
      await settle()
      expect(w.host.querySelector('details.member-list')).toBeNull()
    } finally { await w.cleanup() }
  })

  it('defers initial unread scroll and presentation until first-display senders resolve, then positions at first Unread with 未読 marker', async () => {
    vi.useFakeTimers()
    let finishLookup!: (result: Result<{ identities: DisplayIdentity[] }>) => void
    const lookupAuthorsFn = vi.fn<typeof lookupAuthors>(() => new Promise(resolve => { finishLookup = resolve }))
    const listMembersFn = vi.fn<typeof listMembers>(() => new Promise(() => {}))
    const ownMsg = { ...record(1, 'c1'), sender: 'me', body: '既読メッセージ' }
    const unreadMsgs = Array.from({ length: 10 }, (_, i) => ({
      ...record(i + 2, 'c1'),
      sender: 'bob',
      body: `未読メッセージ ${i + 1}`,
    }))
    const allMsgs = [ownMsg, ...unreadMsgs]
    const w = makeWorkspace({
      timelineItems: allMsgs.map(message => ({ kind: 'message' as const, message })),
      listMembers: listMembersFn,
      lookupAuthors: lookupAuthorsFn,
    })
    w.net.pages.c1 = ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: allMsgs.length,
      messages: allMsgs,
      has_more: false,
    })
    w.net.unreadChannels.c1 = {
      history_generation: '00000000-0000-4000-8000-000000000515',
      ...channel('c1', 'general'),
      as_of_seq: allMsgs.length,
      read_seq: 1,
      unread_count: unreadMsgs.length,
      main_unread_count: unreadMsgs.length,
      mention_unread_count: 0,
      main_mention_unread_count: 0,
    }
    try {
      w.net.socket.onReady()
      w.net.lists[0].resolve(ok({
        history_generation: '00000000-0000-4000-8000-000000000515',
        channels: [w.net.unreadChannels.c1],
      }))
      await settle()
      w.net.subscribed('c1', allMsgs.length)
      await settle()

      const scrollEl = w.host.querySelector('#main-content .timeline-scroll') as MiniElement
      expect(scrollEl).not.toBeNull()
      scrollEl.clientHeight = 300
      scrollEl.scrollHeight = 1500
      scrollEl.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 375, width: 375, height: 300, x: 0, y: 0, toJSON: () => ({}) })

      // While first-display senders are pending, rows are held behind Skeleton and no read mark is sent.
      expect(w.host.querySelector('.timeline-list .timeline-list__item')).toBeNull()
      expect(w.net.markReads).toHaveLength(0)

      // Resolve author lookup -> rows mount, scroll positions at first Unread (not bottom), and 未読 marker is rendered.
      finishLookup(ok({ identities: [{ id: 'bob', name: 'ボブ', deactivated: false }] }))
      // Position the first unread row at top = 120 relative to scrollEl once mounted.
      const origQuery = scrollEl.querySelector.bind(scrollEl)
      scrollEl.querySelector = (selector: string) => {
        const el = origQuery(selector)
        if (el && (selector.includes('data-read-marker') || selector.includes(unreadMsgs[0].id))) {
          el.getBoundingClientRect = () => ({ top: 120, bottom: 200, left: 0, right: 375, width: 375, height: 80, x: 0, y: 120, toJSON: () => ({}) })
        }
        return el
      }
      await settle()
      await settle()

      const firstUnreadItem = w.host.querySelector(`#main-content [data-message-id="${unreadMsgs[0].id}"]`)
      expect(firstUnreadItem).not.toBeNull()
      expect(firstUnreadItem?.querySelector('[data-read-marker="true"]')?.textContent?.trim()).toBe('未読')
      expect(firstUnreadItem?.querySelector('.ui-message-row__sender')?.textContent).toBe('ボブ')
      expect(scrollEl.scrollTop).toBe(120)
    } finally { await w.cleanup() }
  })
})
