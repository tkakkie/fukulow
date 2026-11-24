import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import * as api from './api'
import type { lookupAuthors, Member, Result } from './api'
import { createAuthors } from './authors'
import { authorsAdapter } from './authors.svelte'
import { createChannelMembers } from './channel-members'
import { createMembers } from './members'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { repliesAdapter } from './replies.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import { membersAdapter } from './members.svelte'
import { channelMembersAdapter } from './channel-members.svelte'
import Workspace from './Workspace.svelte'
import { replyPage } from './topic-test-helpers'
import { buttonsByText, installMiniDom, MiniElement, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

describe('Guest Workspace member panels and author resolution', () => {
  it('Guest member panels reload remote grants on every open and keep the add-candidate picker hidden', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: vi.fn(), ...net.options() })
    const self: Member = { id: 'me', name: '自分', role: 'guest' }
    const peer: Member = { id: 'peer', name: '共有メンバー', role: 'member' }
    let shared = false
    const listMembers = vi.fn(async () => ok({ members: shared ? [self, peer] : [self] }))
    const memberController = createMembers('org-1', vi.fn(), vi.fn(), {
      listMembers, lookupAuthors: async () => ok({ identities: [] }),
      changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    })
    await memberController.load()
    const channelMembers = createChannelMembers('org-1', 'c1', vi.fn(), {
      ...api, listChannelMembers: async () => ok({ members: [{ ...self, manager: false }] }),
    })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels), sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      channelMembers: vi.fn(() => channelMembers), close: rawSession.close,
    }
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    let href = '/o/org-1/c/c1'
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: { state: null,
        pushState(_s: unknown, _t: string, url: string) { href = url },
        replaceState(_s: unknown, _t: string, url: string) { href = url },
      }, innerWidth: 1280, addEventListener() {}, removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, { target: host as unknown as Element, props: {
      navigation, session: sessionModel, selectedOrganizationId: 'org-1', members: membersAdapter(memberController),
      organization: { member: self, organization: { organization_id: 'org-1', name: 'Acme', capabilities: {
        can_create_channels: { allowed: false }, can_invite: { allowed: false },
        can_deactivate_members: { allowed: false }, can_manage_roles: { allowed: false },
      } } },
    } })
    await settle()
    shared = true // Remote grant changes emit no channel_access_lost.
    expect(memberController.get().members).toEqual([self])
    const details = host.querySelector('details.member-list') as MiniElement & { open: boolean }
    details.open = true
    await settle()
    expect(memberController.get().members).toEqual([self, peer])
    expect(details.textContent).toContain(peer.name)
    details.open = false
    await settle()
    shared = false
    details.open = true
    await settle()
    expect(memberController.get().members).toEqual([self])
    shared = true
    navigation.navigate({ type: 'tab', tab: 'members' })
    await settle()
    expect(memberController.get().members).toEqual([self, peer])
    expect(host.querySelector('#panel-content')?.textContent).not.toContain('を追加')
    // A fresh snapshot of the same Channel must preserve the live panel/controller.
    const loading = rawSession.channels.load()
    net.lists.at(-1)!.resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'renamed')] }))
    await loading; await settle()
    expect(sessionModel.channelMembers).toHaveBeenCalledOnce()
    navigation.navigate({ type: 'close' }); await settle()
    shared = false
    navigation.navigate({ type: 'tab', tab: 'members' }); await settle()
    expect(memberController.get().members).toEqual([self])
    expect(listMembers).toHaveBeenCalledTimes(5)
    navigation.destroy()
    await unmount(instance)
    memberController.close(); channelMembers.close(); rawSession.close()
  })

  it('Workspace Channel member controller lifecycle cleans up on rapid switching, tab/panel close, and Organization/Session replacement without late publication', async () => {
    vi.useFakeTimers()
    type MemberResponse = api.Result<{ members: api.ChannelMember[] }>
    const pending: Array<{ org: string; channel: string; resolve: (r: MemberResponse) => void }> = []
    const listSpy = vi.spyOn(api, 'listChannelMembers').mockImplementation((org, ch) => new Promise<MemberResponse>(resolve => {
      pending.push({ org, channel: ch, resolve })
    }))
    const self: Member = { id: 'me', name: '自分', role: 'admin' }
    const makeOrg = (id: string, name: string) => ({
      member: self,
      organization: {
        organization_id: id,
        name,
        capabilities: {
          can_create_channels: { allowed: true }, can_invite: { allowed: true },
          can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
        },
      },
    })
    const makeNav = (initialHref: string) => {
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
    const makeSession = (orgId: string, channelIds: string[]) => {
      const net = fakeNetwork()
      const raw = createSession({ selfId: self.id, organizationId: orgId, initialRole: 'admin', onEnded: vi.fn(), ...net.options() })
      const opened: Array<{ channel: string; controller: ReturnType<typeof raw.channelMembers>; listener: ReturnType<typeof vi.fn> }> = []
      const model = {
        channels: channelsAdapter(raw.channels),
        sync: syncAdapter(raw.sync),
        topics: (id: string) => topicsAdapter(raw.topics, id),
        channelMembers(id: string) {
          const controller = raw.channelMembers(id)
          const listener = vi.fn()
          controller.subscribe(listener)
          opened.push({ channel: id, controller, listener })
          return controller
        },
        close: raw.close,
      }
      net.socket.onReady()
      net.lists[0].resolve(ok({
        history_generation: '00000000-0000-4000-8000-000000000515',
        channels: channelIds.map(id => channel(id, id)),
      }))
      return { net, raw, model, opened }
    }

    const s1 = makeSession('org-1', ['c1', 'c2', 'c3'])
    const s2 = makeSession('org-2', ['c1'])
    const s3 = makeSession('org-2', ['c1'])
    const navigation = makeNav('/o/org-1/c/c1?panel=members')
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const props = $state({
      navigation,
      session: s1.model,
      selectedOrganizationId: 'org-1',
      organization: makeOrg('org-1', 'Org 1'),
    })
    let instance: ReturnType<typeof mount> | undefined = mount(Workspace, { target: host as unknown as Element, props })
    try {
      await settle()
      expect(s1.opened.map(o => o.channel)).toEqual(['c1'])
      expect(pending.map(p => `${p.org}:${p.channel}`)).toEqual(['org-1:c1'])

      // Rapid Channel switching: c1 -> c2 -> c3.
      navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c2' })
      navigation.navigate({ type: 'tab', tab: 'members' })
      await settle()
      navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c3' })
      navigation.navigate({ type: 'tab', tab: 'members' })
      await settle()
      expect(s1.opened.map(o => o.channel)).toEqual(['c1', 'c2', 'c3'])
      expect(pending.map(p => `${p.org}:${p.channel}`)).toEqual(['org-1:c1', 'org-1:c2', 'org-1:c3'])

      // Late completions for c1 and c2 must publish nothing.
      pending[0].resolve(ok({ members: [{ id: 'm1', name: '古いC1メンバー', role: 'member', manager: false }] }))
      pending[1].resolve(ok({ members: [{ id: 'm2', name: '古いC2メンバー', role: 'member', manager: false }] }))
      await settle()
      expect(s1.opened[0].listener).not.toHaveBeenCalled()
      expect(s1.opened[1].listener).not.toHaveBeenCalled()
      expect(s1.opened[0].controller.get().members).toEqual([])
      expect(s1.opened[1].controller.get().members).toEqual([])
      expect(host.querySelector('#panel-content')?.textContent).not.toContain('古いC1メンバー')
      expect(host.querySelector('#panel-content')?.textContent).not.toContain('古いC2メンバー')

      // Activity notices for closed c1/c2 must not re-query; c3 remains live.
      s1.net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'c1' })
      s1.net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'c2' })
      await vi.advanceTimersByTimeAsync(500)
      expect(pending).toHaveLength(3)

      pending[2].resolve(ok({ members: [{ id: 'm3', name: 'C3メンバー', role: 'member', manager: false }] }))
      await settle()
      expect(host.querySelector('#panel-content')?.textContent).toContain('C3メンバー')

      // Tab switch away from 'members' closes c3 and releases its hold.
      navigation.navigate({ type: 'tab', tab: 'topics' })
      await settle()
      s1.net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'c3' })
      await vi.advanceTimersByTimeAsync(500)
      expect(pending).toHaveLength(3)

      // Reopen 'members' then close panel while in-flight; late completion publishes nothing.
      navigation.navigate({ type: 'tab', tab: 'members' })
      await settle()
      expect(pending).toHaveLength(4)
      const beforeClose = s1.opened[3]
      navigation.navigate({ type: 'close' })
      await settle()
      pending[3].resolve(ok({ members: [{ id: 'm3-late', name: '閉じた後のC3メンバー', role: 'member', manager: false }] }))
      await settle()
      expect(beforeClose.listener).not.toHaveBeenCalled()
      expect(beforeClose.controller.get().members).toEqual([])
      s1.net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'c3' })
      await vi.advanceTimersByTimeAsync(500)
      expect(pending).toHaveLength(4)

      // Reopen on org-1/c1, then replace Organization and Session in place.
      navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c1' })
      navigation.navigate({ type: 'tab', tab: 'members' })
      await settle()
      expect(pending).toHaveLength(5)
      const oldOrgEntry = s1.opened[4]

      navigation.navigate({ type: 'channel', organizationId: 'org-2', channelId: 'c1' })
      navigation.navigate({ type: 'tab', tab: 'members' })
      props.session = s2.model
      props.selectedOrganizationId = 'org-2'
      props.organization = makeOrg('org-2', 'Org 2')
      await settle()
      expect(s2.opened.map(o => o.channel)).toEqual(['c1'])
      expect(pending.map(p => `${p.org}:${p.channel}`).slice(4)).toEqual(['org-1:c1', 'org-2:c1'])

      // Late completion from org-1 must publish nothing, and org-1's hold must be released.
      pending[4].resolve(ok({ members: [{ id: 'old-org', name: '旧組織メンバー', role: 'member', manager: false }] }))
      await settle()
      expect(oldOrgEntry.listener).not.toHaveBeenCalled()
      expect(oldOrgEntry.controller.get().members).toEqual([])
      expect(host.querySelector('#panel-content')?.textContent).not.toContain('旧組織メンバー')
      s1.net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'c1' })
      await vi.advanceTimersByTimeAsync(500)
      expect(pending).toHaveLength(6)

      // New Organization/Session renders its members and stays held until unmount.
      pending[5].resolve(ok({ members: [{ id: 'new-org', name: '新組織メンバー', role: 'member', manager: false }] }))
      await settle()
      expect(host.querySelector('#panel-content')?.textContent).toContain('新組織メンバー')

      s2.net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'c1' })
      await vi.advanceTimersByTimeAsync(200)
      expect(pending).toHaveLength(7)
      pending[6].resolve(ok({ members: [{ id: 'new-org-2', name: '新組織更新メンバー', role: 'member', manager: false }] }))
      await settle()
      expect(host.querySelector('#panel-content')?.textContent).toContain('新組織更新メンバー')

      // Same-Organization, same-Channel Session swap with an old request in flight proves Session identity is tracked on its own.
      s2.net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'c1' })
      await vi.advanceTimersByTimeAsync(200)
      expect(pending).toHaveLength(8)
      const s2Calls = s2.opened[0].listener.mock.calls.length
      props.session = s3.model
      await settle()
      expect(s3.opened.map(o => o.channel)).toEqual(['c1'])
      expect(pending).toHaveLength(9)

      pending[7].resolve(ok({ members: [{ id: 'old-session', name: '旧セッションメンバー', role: 'member', manager: false }] }))
      await settle()
      expect(s2.opened[0].listener).toHaveBeenCalledTimes(s2Calls)
      expect(host.querySelector('#panel-content')?.textContent).not.toContain('旧セッションメンバー')
      s2.net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'c1' })
      await vi.advanceTimersByTimeAsync(500)
      expect(pending).toHaveLength(9)

      pending[8].resolve(ok({ members: [{ id: 'new-session', name: '新セッションメンバー', role: 'member', manager: false }] }))
      await settle()
      expect(host.querySelector('#panel-content')?.textContent).toContain('新セッションメンバー')

      // Unmounting Workspace (e.g. {#key session}) closes the active controller and releases its hold.
      const mounted = instance
      instance = undefined
      await unmount(mounted)
      s3.net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'c1' })
      await vi.advanceTimersByTimeAsync(500)
      expect(pending).toHaveLength(9)
    } finally {
      if (instance) await unmount(instance)
      navigation.destroy()
      s1.raw.close()
      s2.raw.close()
      s3.raw.close()
      listSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('Guest Workspace resolves Member list then author lookup then fallback in timeline and announcements', async () => {
    for (const outcome of ['active', 'deactivated', 'omitted', 'failed', 'view changed'] as const) {
      vi.useFakeTimers()
      const net = fakeNetwork()
      net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 1, has_more: false, items: [
        { kind: 'message', message: { ...record(1, 'c1'), sender: 'known' } },
      ] })
      net.timelines.c2 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 0, has_more: false, items: [] })
      const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: vi.fn(), ...net.options('me') })
      const sessionModel = {
        channels: channelsAdapter(rawSession.channels), sync: syncAdapter(rawSession.sync),
        topics: (id: string) => topicsAdapter(rawSession.topics, id),
        navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets), close: rawSession.close,
      }
      let finish!: (result: Awaited<ReturnType<typeof lookupAuthors>>) => void
      const lookup = vi.fn<typeof lookupAuthors>(() => new Promise(resolve => { finish = resolve }))
      const memberController = createMembers('org-1', vi.fn(), vi.fn(), {
        listMembers: async () => ok({ members: [{ id: 'known', name: '既知の著者', role: 'member' }] }),
        lookupAuthors: lookup, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
      })
      await memberController.load()
      // Conflicting cache data proves directory precedence through Workspace's real resolver.
      const cached = memberController.authors.get() as Map<string, api.DisplayIdentity>
      cached.set('known', {
        id: 'known', name: '古いキャッシュ名', deactivated: false,
      })
      net.socket.onReady()
      net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general'), channel('c2', 'other')] }))
      let href = '/o/org-1/c/c1'
      const navigation = createNavigation({
        location: { get href() { return href } },
        history: { state: null,
          pushState(_s: unknown, _t: string, url: string) { href = url },
          replaceState(_s: unknown, _t: string, url: string) { href = url },
        }, innerWidth: 1280, addEventListener() {}, removeEventListener() {},
      } as unknown as NavigationBrowser)
      const announcements: string[] = []
      const host = dom.doc.createElement('div')
      dom.doc.body.appendChild(host)
      const instance = mount(Workspace, { target: host as unknown as Element, props: {
        navigation, session: sessionModel, selectedOrganizationId: 'org-1', members: membersAdapter(memberController),
        organization: { member: { id: 'me', name: '自分', role: 'guest' }, organization: {
          organization_id: 'org-1', name: 'Acme', capabilities: {
            can_create_channels: { allowed: false }, can_invite: { allowed: false },
            can_deactivate_members: { allowed: false }, can_manage_roles: { allowed: false },
          },
        } },
        onannounce: text => announcements.push(text),
      } })
      await settle()
      net.subscribed('c1', 1)
      await settle()
      announcements.length = 0
      // Known authors keep the normal 2 s window; own sends remain silent even
      // when the Member list does not include self.
      net.event({ type: 'message', kind: 'create', seq: ({ ...record(2, 'c1'), sender: 'known', body: '既知の新着' }).created_seq, message: { ...record(2, 'c1'), sender: 'known', body: '既知の新着' } })
      net.event({ type: 'message', kind: 'create', seq: ({ ...record(3, 'c1'), sender: 'me', body: '自分の送信' }).created_seq, message: { ...record(3, 'c1'), sender: 'me', body: '自分の送信' } })
      await settle()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(announcements).toEqual(['既知の著者: 既知の新着'])
      // Self is absent from this Member list and author cache; the Organization identity still names it.
      expect(host.querySelector('[data-message-id="id3"] .ui-message-row__sender')?.textContent).toBe('自分')
      announcements.length = 0
      net.event({ type: 'message', kind: 'create', seq: ({ ...record(4, 'c1'), sender: 'unknown', body: '新着本文' }).created_seq, message: { ...record(4, 'c1'), sender: 'unknown', body: '新着本文' } })
      await settle()
      expect(lookup).toHaveBeenCalledWith('org-1', { ids: ['unknown'] })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(announcements).toEqual([])
      if (outcome === 'view changed') {
        navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c2' })
        await settle()
        expect(announcements).toEqual(['# other'])
        announcements.length = 0
      }
      finish(outcome === 'failed' ? { ok: false, kind: 'network' } : ok({ identities:
        outcome === 'omitted' ? [] : [{ id: 'unknown', name: '田中', deactivated: outcome === 'deactivated' }],
      }))
      await settle()
      await vi.advanceTimersByTimeAsync(2_000)
      const name = outcome === 'active' ? '田中' : outcome === 'deactivated' ? '田中（無効）' : 'メンバー'
      expect(memberController.get().members.map(m => m.id)).toEqual(['known'])
      if (outcome !== 'view changed') {
        expect(host.querySelector('[data-message-id="' + record(4, 'c1').id + '"] .ui-message-row__sender')?.textContent).toBe(name)
        expect(host.querySelector('[data-message-id="' + record(2, 'c1').id + '"] .ui-message-row__sender')?.textContent).toBe('既知の著者')
      }
      const expected = outcome === 'view changed' ? [] : [name + ': 新着本文']
      expect(announcements).toEqual(expected)
      // A further cache notification and timer tick cannot announce the seq again.
      memberController.authors.watch(['unknown'])
      await settle()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(announcements).toEqual(expected)
      navigation.destroy()
      await unmount(instance)
      memberController.close()
      sessionModel.close()
    }
  })

  it('Guest Workspace resolves isolated older Topic and Reply authors without widening its Member list', async () => {
    const net = fakeNetwork()
    const root = { ...record(1, 'c1'), sender: 'known', body: '過去の返信ルート' }
    const reply = { ...record(2, 'c1'), sender: 'reply-only', body: '返信ページだけの本文', reply_to: root.id, reply_root_id: root.id }
    const older = { ...record(3, 'c1'), sender: 'topic-only', body: '古いトピックだけの本文', topic_id: 't-1' }
    const latest = { ...record(9, 'c1'), sender: 'known', body: '最新トピック本文', topic_id: 't-1' }
    const recent = { ...record(10, 'c1'), sender: 'known', body: '最新チャンネル本文' }
    const summary = { mention_unread_count: 0, id: 't-1', name: '相談', first_seq: 3, last_seq: 9, message_count: 2, latest_message: latest, read_seq: 9, unread_count: 0 }
    net.timelines.c1 = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 10, has_more: true, items: [
      { kind: 'topic', topic: summary }, { kind: 'message', message: recent },
    ] })
    net.topicSummaries['c1:t-1'] = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 10, topic: summary })
    net.replyChains[`c1:${root.id}`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([root]).at(-1)?.created_seq ?? 0,  root_id: root.id, messages: [root], has_more: true }))
    net.replyChains[`c1:${root.id}:1`] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([reply]).at(-1)?.created_seq ?? 0,  root_id: root.id, messages: [reply], has_more: false }))
    const base = net.options('me')
    const topicReads = vi.fn(async (_channel: string, _topic: string, query?: { before_seq?: number }) =>
      query?.before_seq ? ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([older]).at(-1)?.created_seq ?? 0,  messages: [older], has_more: false }) : ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([latest]).at(-1)?.created_seq ?? 0,  messages: [latest], has_more: true }))
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: vi.fn(), ...base,
      topicsApi: { ...base.topicsApi!, listTopicMessages: topicReads },
    })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels), sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id, rawSession.replyCounts),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets), close: rawSession.close,
    }
    let deactivated = false
    const lookup = vi.fn(async (_org: string, { ids }: { ids: string[] }) => ok({ identities: ids.map(id => ({
      id, name: id === 'topic-only' ? 'トピック著者' : '返信著者', deactivated,
    })) }))
    const memberController = createMembers('org-1', vi.fn(), vi.fn(), {
      listMembers: async () => ok({ members: [{ id: 'known', name: '既知の著者', role: 'member' }] }),
      lookupAuthors: lookup, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    })
    await memberController.load()
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('c1', 'general')] }))
    let href = '/o/org-1/c/c1/t/t-1'
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: { state: null,
        pushState(_s: unknown, _t: string, url: string) { href = url },
        replaceState(_s: unknown, _t: string, url: string) { href = url },
      }, innerWidth: 1280, addEventListener() {}, removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, { target: host as unknown as Element, props: {
      navigation, session: sessionModel, selectedOrganizationId: 'org-1', members: membersAdapter(memberController),
      organization: { member: { id: 'me', name: '自分', role: 'guest' }, organization: {
        organization_id: 'org-1', name: 'Acme', capabilities: {
          can_create_channels: { allowed: false }, can_invite: { allowed: false },
          can_deactivate_members: { allowed: false }, can_manage_roles: { allowed: false },
        },
      } },
    } })
    await settle()
    net.subscribed('c1', 10)
    await settle()
    expect(lookup).not.toHaveBeenCalled()
    buttonsByText(host, '以前のメッセージを読み込む')[0].click()
    await settle()
    expect(topicReads).toHaveBeenLastCalledWith('c1', 't-1', {as_of_seq: 9, history_generation: '00000000-0000-4000-8000-000000000515', before_seq: 9 })
    navigation.navigate({ type: 'reply', messageId: root.id })
    await settle()
    await settle()
    expect(host.querySelector('#panel-content')?.textContent).not.toContain(reply.body)
    buttonsByText(host, 'さらに返信を読み込む')[0].click()
    await settle()
    expect(net.replyHistory.at(-1)?.query?.after_seq).toBe(1)
    expect(lookup.mock.calls.flatMap(call => call[1].ids)).toEqual(['topic-only', 'reply-only'])
    expect(rawSession.sync.getTimeline('c1').get().messages.map(m => m.sender)).not.toContain('topic-only')
    expect(rawSession.sync.getTimeline('c1').get().messages.map(m => m.sender)).not.toContain('reply-only')
    expect(memberController.get().members.map(m => m.id)).toEqual(['known'])

    const expectAccessibleSender = (scope: string, id: string, text: string) => {
      const label = host.querySelector(`${scope} [data-message-id="${id}"] .ui-message-row__sender`)!
      expect(label.textContent).toBe(text)
      expect(label.closest('[aria-hidden="true"], [hidden], [inert]')).toBeNull()
      expect(label.getAttribute('aria-label')).toBeNull()
    }
    expectAccessibleSender('#main-content', older.id, 'トピック著者')
    expectAccessibleSender('#panel-content', reply.id, '返信著者')
    deactivated = true
    await memberController.load()
    await settle()
    expectAccessibleSender('#main-content', older.id, 'トピック著者（無効）')
    expectAccessibleSender('#panel-content', reply.id, '返信著者（無効）')
    expect(lookup.mock.calls.flatMap(call => call[1].ids).sort()).toEqual(['reply-only', 'reply-only', 'topic-only', 'topic-only'])
    deactivated = false
    await memberController.load()
    await settle()
    expectAccessibleSender('#main-content', older.id, 'トピック著者')
    expectAccessibleSender('#panel-content', reply.id, '返信著者')
    navigation.destroy()
    await unmount(instance)
    rawSession.close()
    memberController.close()
  })

})
