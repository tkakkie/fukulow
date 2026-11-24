import { replyPage } from './topic-test-helpers'
import { describe, expect, it, vi } from 'vitest'
import { createSession, type SessionOptions } from './session'
import { createMembers } from './members'
import * as api from './api'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import type { MoveChainApi } from './move-chain'

function open(overrides: Partial<SessionOptions> = {}) {
  const net = fakeNetwork()
  const onEnded = vi.fn()
  const session = createSession({ selfId: 'me', onEnded, ...net.options(), ...overrides })
  net.socket.onReady()
  return { net, session, onEnded }
}
const controls = (net: ReturnType<typeof fakeNetwork>) => net.sockets.flatMap((s) => s.sent).map((m) => `${m.type}:${m.channel_id}`)

describe('session controllers', () => {
  it('watches the selected Channel and moves the watch when the selection changes (unwatch before watch)', async () => {
    const { net, session } = open()
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  messages: [record(100)], has_more: false })
    net.pages.B = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(200, 'B')]).at(-1)?.created_seq ?? 0,  messages: [record(200, 'B')], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A'), channel('B')] }))
    await settle()
    expect(session.channels.get().selectedId).toBe('A')
    expect(net.history.map((h) => h.channel)).toEqual(['A'])
    expect(controls(net)).toEqual(['subscribe:A'])

    session.channels.select('B')
    await settle()
    expect(controls(net)).toEqual(['subscribe:A', 'unsubscribe:A', 'subscribe:B'])
    session.channels.select('B') // the same selection is not a new intent
    await settle()
    expect(controls(net)).toEqual(['subscribe:A', 'unsubscribe:A', 'subscribe:B'])
    session.close()
  })

  it('close stops the connection and fences a Channel list that is still loading', async () => {
    const { net, session } = open()
    session.close()
    expect(net.socket.closed).toBe(true)
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    expect(session.channels.get()).toMatchObject({ status: 'loading', selectedId: null })
    expect(net.history).toEqual([]) // nothing was selected, so nothing was watched
    expect(net.sockets).toHaveLength(1)
  })

  it('close stops following the selection', async () => {
    const { net, session } = open()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A'), channel('B')] }))
    await settle()
    session.close()
    const requests = net.history.length
    session.channels.select('B') // a stray caller on the closed session
    await settle()
    expect(net.history).toHaveLength(requests)
    expect(controls(net)).not.toContain('subscribe:B')
  })

  it('a new session does not see the closed session\'s state or late results', async () => {
    const first = open()
    first.session.close()
    const second = open()
    second.net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('X')] }))
    await settle()
    first.net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    expect(second.session.channels.get().channels.map((c) => c.id)).toEqual(['X'])
    expect(second.net.history.map((h) => h.channel)).toEqual(['X'])
    expect(first.net.history).toEqual([])
    second.session.close()
  })

  it('a refusal from the server ends the session through onEnded only (401 on a send)', async () => {
    const { net, session, onEnded } = open()
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    void session.sync.getTimeline('A').send('hi')
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'http', status: 401 })
    await settle()
    expect(onEnded).toHaveBeenCalledTimes(1)
    session.close()
  })
})

it('a Move refusal leaves the Channel available and Organization loss follows the session boundary', async () => {
  const moveChainApi = vi.fn<MoveChainApi>()
  const { net, session, onEnded } = open({ moveChainApi })
  const anchor = record(100), history_generation = anchor.history_generation
  net.pages.A = ok({ history_generation, as_of_seq: 100, messages: [anchor], has_more: false })
  net.replyChains[`A:${anchor.id}`] = ok(replyPage({ history_generation, as_of_seq: 100, root_id: anchor.id, messages: [anchor], has_more: false }))
  net.lists[0].resolve(ok({ history_generation, channels: [channel('A')] }))
  await settle(); net.subscribed('A', 100)
  await session.replies.open('A', anchor)

  moveChainApi.mockResolvedValueOnce({ ok: false, kind: 'http', status: 403, error: 'move_not_allowed' })
  await expect(session.moveChain('A', anchor.id, { topicId: 'T' })).resolves.toEqual({ kind: 'denied' })
  expect(session.sync.get().channels.A.state).toBe('ready')
  expect(net.replyHistory).toHaveLength(1)

  moveChainApi.mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
  await expect(session.moveChain('A', anchor.id, { topicName: 'T' })).resolves.toEqual({ kind: 'not_found' })
  expect(session.sync.get().organization).toBe('unavailable')
  expect(onEnded).not.toHaveBeenCalled()
  session.close()
})

it('ordinary REST organization_unavailable ends only its Organization', async () => {
  for (const operation of ['history', 'send', 'list', 'create'] as const) {
    vi.useFakeTimers()
    const { net, session, onEnded } = open()
    const other = open()
    try {
      net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  messages: [record(100)], has_more: false })
      net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
      await settle()
      net.subscribed('A', 100)
      void session.sync.getTimeline('A').send('pending')
      await settle()
      const refusal = { ok: false, kind: 'http', status: 404, error: 'organization_unavailable' } as const
      if (operation === 'history') {
        net.pages.A = refusal
        await session.sync.getTimeline('A').loadLatest()
      } else if (operation === 'send') {
        net.sends[0].resolve(refusal)
      } else if (operation === 'list') {
        void session.channels.load()
        net.lists[1].resolve(refusal)
      } else {
        void session.channels.create({ name: 'New', visibility: 'public' })
        net.creates[0].resolve(refusal)
      }
      await settle()
      expect(session.sync.get()).toMatchObject({ organization: 'unavailable', running: false,
        channels: { A: { pending: [{ state: 'failed' }] } } })
      expect(net.socket.closed).toBe(true)
      expect(onEnded).not.toHaveBeenCalled()
      expect(other.session.sync.get().organization).toBe('available')
      expect(other.net.socket.closed).toBe(false)
      const requests = [net.history.length, net.sends.length, net.lists.length, net.creates.length]
      await session.sync.getTimeline('A').retry('me-c1')
      await vi.advanceTimersByTimeAsync(120_000)
      expect([net.history.length, net.sends.length, net.lists.length, net.creates.length]).toEqual(requests)
      expect(net.sockets).toHaveLength(1)
    } finally {
      session.close(); other.session.close(); vi.useRealTimers()
    }
  }
})

it('ordinary history channel_not_found stays terminal for the Channel under C9', async () => {
  const { net, session, onEnded } = open()
  net.pages.A = { ok: false, kind: 'http', status: 404, error: 'channel_not_found' }
  net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
  await settle()
  expect(session.sync.get()).toMatchObject({ organization: 'available', running: true,
    channels: { A: { state: 'unavailable' } } })
  expect(net.socket.closed).toBe(false)
  expect(onEnded).not.toHaveBeenCalled()
  session.close()
})

it('explicitly reselecting the only Channel in C9 triggers one retry attempt, recovers when allowed, and never loops', async () => {
  vi.useFakeTimers()
  const { net, session, onEnded } = open()
  const watch = vi.spyOn(session.sync, 'watch')
  try {
    // 1. Single Channel enters C9 on initial history 404: no automatic retry or reload side-effect.
    net.pages.A = { ok: false, kind: 'http', status: 404, error: 'channel_not_found' }
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    expect(session.sync.get().channels.A.state).toBe('unavailable')
    expect(session.sync.getTimeline('A').get().status).toBe('unavailable')
    expect(net.history).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    void session.channels.load()
    net.lists[1].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    expect(net.history).toHaveLength(1)
    expect(watch).toHaveBeenCalledTimes(1)

    // Still denied on explicit reselect: tries once and returns to terminal unavailable with no loop.
    session.channels.select('A')
    await settle()
    expect(watch).toHaveBeenCalledTimes(2)
    expect(net.history).toHaveLength(2)
    expect(session.sync.get().channels.A.state).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(net.history).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(watch).toHaveBeenCalledTimes(2)

    // Server now allows access: explicit reselect tries once and recovers to ready.
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  messages: [record(100)], has_more: false })
    session.channels.select('A')
    await settle()
    expect(watch).toHaveBeenCalledTimes(3)
    expect(net.history).toHaveLength(3)
    expect(controls(net)).toEqual(['subscribe:A'])
    net.subscribed('A', 100)
    await settle()
    expect(session.sync.get().channels.A.state).toBe('ready')
    expect(session.sync.getTimeline('A').get()).toMatchObject({ status: 'ready', messages: [record(100)] })

    // Reselecting while ready is not a new watch attempt.
    session.channels.select('A')
    await settle()
    expect(watch).toHaveBeenCalledTimes(3)
    expect(net.history).toHaveLength(3)
    expect(controls(net)).toEqual(['subscribe:A'])

    // 2. Single Channel enters C9 via subscription refusal after bootstrap: reselect subscribes once and recovers.
    net.event({ type: 'error', channel_id: 'A', code: 'channel_not_found' })
    await settle()
    expect(session.sync.get().channels.A.state).toBe('unavailable')
    expect(controls(net)).toEqual(['subscribe:A', 'unsubscribe:A'])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(controls(net)).toEqual(['subscribe:A', 'unsubscribe:A'])
    expect(net.history).toHaveLength(3)

    session.channels.select('A')
    await settle()
    expect(watch).toHaveBeenCalledTimes(4)
    expect(controls(net)).toEqual(['subscribe:A', 'unsubscribe:A', 'subscribe:A'])
    expect(net.history).toHaveLength(3)
    net.subscribed('A', 100)
    await settle()
    expect(session.sync.get().channels.A.state).toBe('ready')
    expect(session.sync.getTimeline('A').get().status).toBe('ready')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(controls(net)).toEqual(['subscribe:A', 'unsubscribe:A', 'subscribe:A'])
    expect(watch).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
    expect(onEnded).not.toHaveBeenCalled()
  } finally {
    session.close()
    vi.useRealTimers()
  }
})

it('a URL re-render with the same Channel hint does not retry C9', async () => {
  const { net, session } = open()
  try {
    net.pages.A = { ok: false, kind: 'http', status: 404, error: 'channel_not_found' }
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    expect(session.sync.get().channels.A.state).toBe('unavailable')
    const watch = vi.spyOn(session.sync, 'watch')
    session.channels.selectHint('A')
    await settle()
    expect(watch).not.toHaveBeenCalled()
    expect(net.history).toHaveLength(1)
    expect(controls(net)).toEqual([])
  } finally { session.close() }
})

it.each(['C10', 'close', '4001', '401'] as const)('an explicit C9 reselect after %s does not watch or retry', async end => {
  vi.useFakeTimers()
  const { net, session, onEnded } = open()
  try {
    net.pages.A = { ok: false, kind: 'http', status: 404, error: 'channel_not_found' }
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    expect(session.sync.get().channels.A.state).toBe('unavailable')
    if (end === 'close') session.close()
    else if (end === 'C10') net.socket.onClose(4003)
    else {
      // The Account Session owner closes its Organization controllers on session end.
      onEnded.mockImplementation(() => session.close())
      if (end === '4001') net.socket.onClose(4001)
      else {
        void session.channels.load()
        net.lists[1].resolve({ ok: false, kind: 'http', status: 401 })
      }
      await settle()
      expect(onEnded).toHaveBeenCalledOnce()
    }
    await settle()
    const watch = vi.spyOn(session.sync, 'watch')
    const requests = [net.history.length, net.sends.length, net.lists.length, net.sockets.length]
    const sent = controls(net)
    session.channels.select('A')
    await settle()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(watch).not.toHaveBeenCalled()
    expect([net.history.length, net.sends.length, net.lists.length, net.sockets.length]).toEqual(requests)
    expect(controls(net)).toEqual(sent)
    expect(vi.getTimerCount()).toBe(0)
  } finally { session.close(); vi.useRealTimers() }
})

it('explicitly selecting the current C9 Channel reattempts it while another Organization stays ready', async () => {
  const a = open(), b = open()
  for (const c of [a, b]) {
    c.net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  messages: [record(100)], has_more: false })
    c.net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] })); await settle(); c.net.subscribed('A', 100)
  }
  a.net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
  await settle(); expect(a.session.sync.get().channels.A.state).toBe('unavailable')
  expect(b.session.sync.get().channels.A.state).toBe('ready')
  a.session.channels.select('A'); await settle()
  expect(controls(a.net).filter(c => c === 'subscribe:A')).toHaveLength(2)
  a.net.subscribed('A', 100); await settle(); expect(a.session.sync.get().channels.A.state).toBe('ready')
  a.session.close(); b.session.close()
})

it('members_changed retains both Member lists without publishing refetches during /me', () => checkMemberListRole('members_changed', 'delayed'))
it('members_changed clears both Member lists when /me fails', () => checkMemberListRole('members_changed', 'failed'))
it('members_changed clears both Member lists when /me confirms Guest', () => checkMemberListRole('members_changed', 'demoted'))
it('activity_ready retains both Member lists without publishing refetches during /me', () => checkMemberListRole('activity_ready', 'delayed'))
it('activity_reset retains both Member lists without publishing refetches during /me', () => checkMemberListRole('activity_reset', 'delayed'))
it('O5 retains verified Member rows until /me confirms a demotion', () => checkMemberListRole('periodic', 'demoted'))
it('O5 retains verified Member rows only until the identity probe fails', () => checkMemberListRole('periodic', 'failed'))
it('members_changed withholds both lists for a confirmed Guest', () => checkMemberListRole('members_changed', 'delayed', 'guest'))

async function checkMemberListRole(
  trigger: 'members_changed' | 'activity_ready' | 'activity_reset' | 'periodic',
  outcome: 'delayed' | 'failed' | 'demoted',
  initialRole: api.Role = 'member',
) {
  vi.useFakeTimers()
  const net = fakeNetwork()
  const self: api.Member = { id: 'me', name: '本人', role: initialRole }
  const guest: api.Member = { ...self, role: 'guest' }
  const organization: api.Identity['organization'] = {
    organization_id: 'org', name: '組織', capabilities: {
      can_invite: { allowed: false }, can_manage_roles: { allowed: false },
      can_deactivate_members: { allowed: false }, can_create_channels: { allowed: false },
    },
  }
  let resolveIdentity!: (result: api.Result<api.Identity>) => void
  const identity = vi.spyOn(api, 'getOrganizationMe')
    .mockImplementation(() => new Promise(resolve => { resolveIdentity = resolve }))
  const initial = [self, { id: 'other', name: '佐藤', role: 'member' as const }]
  const channelRows = (members: api.Member[]) => ({ members: members.map(m => ({ ...m, manager: false })) })
  const current = outcome === 'demoted' ? [guest] : [self, { ...initial[1], name: '新しい名前' }]
  let resolveChannel!: (result: api.Result<api.ChannelMemberList>) => void
  const channelList = vi.spyOn(api, 'listChannelMembers')
    .mockResolvedValueOnce(ok(channelRows(initial)))
    .mockImplementationOnce(() => new Promise(resolve => { resolveChannel = resolve }))
    .mockResolvedValue(ok(channelRows(current)))
  let resolveDirectory!: (result: api.Result<api.MemberList>) => void
  const listMembers = vi.fn()
    .mockResolvedValueOnce(ok({ members: initial }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveDirectory = resolve }))
    .mockResolvedValue(ok({ members: current }))
  let viewerRole: api.Role = self.role
  const options = net.options()
  const session = createSession({ selfId: self.id, onEnded: vi.fn(), ...options,
    sync: { ...options.sync, random: () => 0.5 }, initialRole: self.role,
    onIdentity: value => { viewerRole = value.member.role },
  })
  const directory = createMembers('org', vi.fn(), vi.fn(), {
    listMembers, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
  }, session.memberListAccess)
  try {
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }))
    if (trigger === 'periodic') {
      net.socket.onEvent({ type: 'activity_ready' })
      await vi.advanceTimersByTimeAsync(200)
      resolveIdentity(ok({ member: self, organization }))
      await vi.advanceTimersByTimeAsync(14_799)
    }
    session.holdActivity('members', directory.activityTarget)
    const panel = session.channelMembers('A')
    await directory.load()
    await settle()
    const expectRows = (rows: api.Member[], stage: string) => {
      expect(directory.get().members, stage).toEqual(rows)
      expect(panel.get().members, stage).toEqual(channelRows(rows).members)
    }
    expectRows(initial, 'initial load')
    const channelRefresh = panel.load(), directoryRefresh = directory.load()
    if (trigger === 'periodic') await vi.advanceTimersByTimeAsync(1)
    else net.socket.onEvent({ type: trigger })
    const pendingRows = initialRole === 'guest' ? [] : initial
    expectRows(pendingRows, 'immediately after invalidation')
    await vi.advanceTimersByTimeAsync(trigger === 'activity_reset' ? 1_000 : 200)
    expect(identity).toHaveBeenCalledTimes(trigger === 'periodic' ? 2 : 1)
    expectRows(pendingRows, 'while /me is pending')

    const stale = [{ ...self, name: '古い名前' }]
    resolveChannel(ok(channelRows(stale)))
    resolveDirectory(ok({ members: stale }))
    await Promise.all([channelRefresh, directoryRefresh])
    expectRows(pendingRows, 'after the pre-invalidation list responses')
    await vi.advanceTimersByTimeAsync(200)
    expectRows(pendingRows, 'after the list refresh delay with /me still pending')
    expect(listMembers).toHaveBeenCalledTimes(2)
    expect(channelList).toHaveBeenCalledTimes(2)

    if (outcome === 'failed') {
      resolveIdentity({ ok: false, kind: 'http', status: 503, retryAfterMs: 1_000 })
      await settle()
      expectRows([], 'after /me failed')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    const verified = outcome === 'demoted' ? guest : self
    resolveIdentity(ok({ member: verified, organization }))
    await settle()
    expect(viewerRole).toBe(verified.role)
    expectRows(outcome === 'delayed' ? pendingRows : [], 'after /me, before the list responses')
    await vi.advanceTimersByTimeAsync(200)
    expect(listMembers).toHaveBeenCalledTimes(3)
    expect(channelList).toHaveBeenCalledTimes(3)
    expectRows(current, 'after replacement under verified Role')
  } finally {
    session.close(); directory.close(); identity.mockRestore(); channelList.mockRestore(); vi.useRealTimers()
  }
}

it('a Member panel created during C9 recovers on explicit Channel re-selection', async () => {
  const list = vi.spyOn(api, 'listChannelMembers').mockResolvedValue(ok({
    members: [{ id: 'me', name: '本人', role: 'admin', manager: false }],
  }))
  const { net, session } = open()
  try {
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await settle()
    expect(session.sync.get().channels.A.state).toBe('unavailable')

    const panel = session.channelMembers('A')
    expect(panel.get()).toMatchObject({ unavailable: true, loading: false })
    await panel.load()
    expect(list).not.toHaveBeenCalled()

    session.channels.select('A')
    await settle()
    net.subscribed('A', 100)
    await settle()
    expect(session.sync.get().channels.A.state).toBe('ready')
    expect(panel.get()).toMatchObject({ unavailable: false, loading: false,
      members: [{ id: 'me', name: '本人', role: 'admin', manager: false }] })
    expect(list).toHaveBeenCalledExactlyOnceWith('', 'A', undefined, expect.any(AbortSignal))
  } finally {
    session.close()
    list.mockRestore()
  }
})

it.each([403, 404])('a Member panel %s during C9 reselect stays terminal without another watch until explicit selection', async status => {
  vi.useFakeTimers()
  const list = vi.spyOn(api, 'listChannelMembers').mockResolvedValue({ ok: false, kind: 'http', status })
  const { net, session } = open()
  const watch = vi.spyOn(session.sync, 'watch')
  try {
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    session.sync.getTimeline('A').setDraft('失わない下書き')
    net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await settle()
    const panel = session.channelMembers('A')

    session.channels.select('A')
    await settle()
    expect(watch).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledOnce()
    expect(session.sync.get().channels.A.state).toBe('unavailable')
    expect(panel.get().unavailable).toBe(true)
    // The denied attempt's subscription handoff may arrive after the Member response.
    net.subscribed('A', 100)
    await settle()
    expect(session.sync.get().channels.A.state).toBe('unavailable')
    session.channels.selectHint('A')
    void session.channels.load()
    net.lists[1].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(watch).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(session.sync.getTimeline('A').composer.get().draft).toBe('失わない下書き')

    list.mockResolvedValue(ok({ members: [{ id: 'me', name: '本人', role: 'admin', manager: false }] }))
    session.channels.select('A')
    await settle()
    net.subscribed('A', 100)
    await settle()
    expect(watch).toHaveBeenCalledTimes(3)
    expect(list).toHaveBeenCalledTimes(2)
    expect(session.sync.get().channels.A.state).toBe('ready')
    expect(panel.get().unavailable).toBe(false)
    expect(session.sync.getTimeline('A').composer.get().draft).toBe('失わない下書き')
  } finally {
    session.close()
    list.mockRestore()
    vi.useRealTimers()
  }
})

it('refreshes Channel capabilities from the server when the メンバー tab is (re)opened and after a successful changeManager', async () => {
  const list = vi.spyOn(api, 'listChannelMembers').mockResolvedValue(ok({
    members: [
      { id: 'me', name: '本人', role: 'member', manager: true },
      { id: 'other', name: '佐藤', role: 'owner', manager: true },
    ],
  }))
  const patch = vi.spyOn(api, 'changeChannelManager').mockResolvedValue(ok(undefined))
  const { net, session } = open()
  const privateChannel = (allowed: boolean): api.Channel => ({
    id: 'A',
    kind: 'channel', archived: false,
    name: 'A',
    visibility: 'private',
    capabilities: {
      can_add_members: { allowed },
      can_remove_members: { allowed },
      can_manage_managers: { allowed },
      can_leave: { allowed: true }, can_rename: { allowed: false }, can_archive: { allowed: false },
    },
  })
  try {
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([record(100)]).at(-1)?.created_seq ?? 0,  messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [privateChannel(false)] }))
    await settle()
    net.subscribed('A', 100)
    await settle()
    expect(session.channels.get().channels[0].capabilities.can_manage_managers.allowed).toBe(false)

    // Opening the メンバー tab refreshes Channel records/capabilities from the server.
    const firstTab = session.channelMembers('A')
    expect(net.lists).toHaveLength(2)
    net.lists[1].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [privateChannel(true)] }))
    await settle()
    expect(session.channels.get().channels[0].capabilities).toMatchObject({
      can_add_members: { allowed: true },
      can_remove_members: { allowed: true },
      can_manage_managers: { allowed: true },
    })

    // A successful changeManager triggers both listChannelMembers and the Channel capability refresh.
    list.mockResolvedValueOnce(ok({
      members: [
        { id: 'me', name: '本人', role: 'member', manager: false },
        { id: 'other', name: '佐藤', role: 'owner', manager: true },
      ],
    }))
    const changing = firstTab.changeManager('me', false)
    await settle()
    expect(patch).toHaveBeenCalledWith('', 'A', 'me', { manager: false })
    expect(net.lists).toHaveLength(3)
    net.lists[2].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [privateChannel(false)] }))
    await changing
    expect(firstTab.get().members[0].manager).toBe(false)
    expect(session.channels.get().channels[0].capabilities).toMatchObject({
      can_add_members: { allowed: false },
      can_remove_members: { allowed: false },
      can_manage_managers: { allowed: false },
    })

    // Closing and reopening the メンバー tab refreshes Channel capabilities from the server again.
    firstTab.close()
    const reopenedTab = session.channelMembers('A')
    expect(net.lists).toHaveLength(4)
    net.lists[3].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [privateChannel(true)] }))
    await settle()
    expect(reopenedTab.get().loading).toBe(false)
    expect(session.channels.get().channels[0].capabilities).toMatchObject({
      can_add_members: { allowed: true },
      can_remove_members: { allowed: true },
      can_manage_managers: { allowed: true },
    })
  } finally {
    session.close()
    list.mockRestore()
    patch.mockRestore()
  }
})

it('closing a Channel member controller releases its Session registration and activity hold', async () => {
  vi.useFakeTimers()
  let resolveInitial!: (r: api.Result<{ members: api.ChannelMember[] }>) => void
  const list = vi.spyOn(api, 'listChannelMembers')
    .mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve }))
    .mockResolvedValue(ok({ members: [{ id: 'me', name: '本人', role: 'admin', manager: true }] }))
  const { net, session } = open({ initialRole: 'admin' })
  try {
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 100, messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    await settle()

    const panel = session.channelMembers('A')
    const notifications = vi.fn()
    panel.subscribe(notifications)
    expect(list).toHaveBeenCalledTimes(1)

    // Closing the controller releases its Session registration and activity hold, and fences late completions.
    panel.close()
    const invalidate = vi.spyOn(panel.activityTarget, 'invalidate')
    const suspend = vi.spyOn(panel.activityTarget, 'suspend')
    const unavailable = vi.spyOn(panel, 'unavailable')
    const reselect = vi.spyOn(panel, 'reselect')

    resolveInitial(ok({ members: [{ id: 'me', name: '遅れた応答', role: 'admin', manager: true }] }))
    await settle()
    expect(notifications).not.toHaveBeenCalled()
    expect(panel.get().members).toEqual([])

    // Activity notices must not invalidate or re-query a closed controller.
    net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'A' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(invalidate).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(1)

    // Channel access loss + re-selection must not invoke access callbacks or re-hold a closed controller.
    net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await settle()
    expect(unavailable).not.toHaveBeenCalled()
    session.channels.select('A')
    await settle()
    net.subscribed('A', 100)
    await settle()
    expect(reselect).not.toHaveBeenCalled()
    net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'A' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(invalidate).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(1)

    // Replacing the activity slot must not retire the closed controller (proving channel-members:A is unheld).
    session.holdActivity('channel-members:A', { invalidate: vi.fn(), close: vi.fn() })()
    expect(suspend).not.toHaveBeenCalled()

    net.socket.onEvent({ type: 'channel_access_revoked', channel_id: 'A' })
    await settle()
    expect(unavailable).not.toHaveBeenCalled()
  } finally {
    session.close()
    list.mockRestore()
    vi.useRealTimers()
  }
})

it('closing a Channel member controller inside its subscriber during access loss leaves no registration or activity hold', async () => {
  vi.useFakeTimers()
  const list = vi.spyOn(api, 'listChannelMembers')
    .mockResolvedValue(ok({ members: [{ id: 'me', name: '本人', role: 'admin', manager: true }] }))
  const { net, session } = open({ initialRole: 'admin' })
  try {
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 100, messages: [record(100)], has_more: false })
    net.pages.B = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 100, messages: [record(100, 'B')], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A'), channel('B')] }))
    await settle()
    net.subscribed('A', 100)
    await settle()

    const panel = session.channelMembers('A')
    const sibling = session.channelMembers('B')
    await settle()
    expect(list).toHaveBeenCalledTimes(2)

    let closedInCallback = false
    panel.subscribe(() => {
      if (panel.get().unavailable && !closedInCallback) {
        closedInCallback = true
        panel.close()
      }
    })

    net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await settle()
    expect(closedInCallback).toBe(true)

    const invalidate = vi.spyOn(panel.activityTarget, 'invalidate')
    const suspend = vi.spyOn(panel.activityTarget, 'suspend')
    const unavailable = vi.spyOn(panel, 'unavailable')
    const reselect = vi.spyOn(panel, 'reselect')

    // Activity notices and hold replacement confirm channel-members:A is released.
    net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'A' })
    await vi.advanceTimersByTimeAsync(500)
    expect(invalidate).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(2)

    // Reselecting A must not call reselect or re-hold the closed controller.
    session.channels.select('A')
    await settle()
    net.subscribed('A', 100)
    await settle()
    expect(reselect).not.toHaveBeenCalled()
    net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'A' })
    await vi.advanceTimersByTimeAsync(500)
    expect(invalidate).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(2)

    session.holdActivity('channel-members:A', { invalidate: vi.fn(), close: vi.fn() })()
    expect(suspend).not.toHaveBeenCalled()

    net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await settle()
    expect(unavailable).not.toHaveBeenCalled()

    // Sibling controller B remains registered and held after A was removed mid-loop.
    net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'B' })
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(list).toHaveBeenCalledTimes(3)
    sibling.close()
  } finally {
    session.close()
    list.mockRestore()
    vi.useRealTimers()
  }
})

it('closing a Channel member controller inside its subscriber during reselection leaves no registration or activity hold', async () => {
  vi.useFakeTimers()
  const list = vi.spyOn(api, 'listChannelMembers')
    .mockResolvedValue(ok({ members: [{ id: 'me', name: '本人', role: 'admin', manager: true }] }))
  const { net, session } = open({ initialRole: 'admin' })
  try {
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 100, messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await settle()
    expect(session.sync.get().channels.A.state).toBe('unavailable')

    const panel = session.channelMembers('A')
    expect(panel.get().unavailable).toBe(true)
    expect(list).not.toHaveBeenCalled()

    let closedInCallback = false
    panel.subscribe(() => {
      if (!panel.get().unavailable && !closedInCallback) {
        closedInCallback = true
        panel.close()
      }
    })

    session.channels.select('A')
    await settle()
    net.subscribed('A', 100)
    await settle()
    expect(closedInCallback).toBe(true)
    expect(list).not.toHaveBeenCalled()

    const invalidate = vi.spyOn(panel.activityTarget, 'invalidate')
    const suspend = vi.spyOn(panel.activityTarget, 'suspend')
    const unavailable = vi.spyOn(panel, 'unavailable')
    const reselect = vi.spyOn(panel, 'reselect')

    // Activity hold taken right before reselect() must have been released by close().
    net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'A' })
    await vi.advanceTimersByTimeAsync(500)
    expect(invalidate).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()

    session.holdActivity('channel-members:A', { invalidate: vi.fn(), close: vi.fn() })()
    expect(suspend).not.toHaveBeenCalled()

    // Subsequent access loss and reselection must not reach the closed controller.
    net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await settle()
    expect(unavailable).not.toHaveBeenCalled()
    session.channels.select('A')
    await settle()
    net.subscribed('A', 100)
    await settle()
    expect(reselect).not.toHaveBeenCalled()
  } finally {
    session.close()
    list.mockRestore()
    vi.useRealTimers()
  }
})

it('late close of a replaced Channel member controller does not release the newer controller hold', async () => {
  vi.useFakeTimers()
  let resolveFirst!: (r: api.Result<{ members: api.ChannelMember[] }>) => void
  const list = vi.spyOn(api, 'listChannelMembers')
    .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
    .mockResolvedValueOnce(ok({ members: [{ id: 'me', name: '現在', role: 'admin', manager: true }] }))
    .mockResolvedValueOnce(ok({ members: [{ id: 'me', name: '更新後', role: 'admin', manager: true }] }))
  const { net, session } = open({ initialRole: 'admin' })
  try {
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 100, messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    await settle()

    const first = session.channelMembers('A')
    const firstListener = vi.fn()
    first.subscribe(firstListener)
    const second = session.channelMembers('A')
    await settle()
    expect(second.get().members[0]?.name).toBe('現在')

    // Late close of the replaced controller must not drop the newer controller's hold or registration.
    first.close()
    resolveFirst(ok({ members: [{ id: 'me', name: '古い応答', role: 'admin', manager: true }] }))
    await settle()
    expect(firstListener).not.toHaveBeenCalled()
    expect(first.get().members).toEqual([])
    expect(second.get().members[0]?.name).toBe('現在')

    // Activity notice still refreshes the active newer controller.
    net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'A' })
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(list).toHaveBeenCalledTimes(3)
    expect(second.get().members[0]?.name).toBe('更新後')

    second.close()
    net.socket.onEvent({ type: 'channel_members_changed', channel_id: 'A' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(list).toHaveBeenCalledTimes(3)
  } finally {
    session.close()
    list.mockRestore()
    vi.useRealTimers()
  }
})

it('channelMembers on a closed Session returns a closed controller without registering or loading', async () => {
  const list = vi.spyOn(api, 'listChannelMembers').mockResolvedValue(ok({ members: [] }))
  const { net, session } = open({ initialRole: 'admin' })
  try {
    session.close()
    const listsBefore = net.lists.length
    const panel = session.channelMembers('A')
    await panel.load()
    expect(list).not.toHaveBeenCalled()
    expect(net.lists).toHaveLength(listsBefore)
  } finally {
    list.mockRestore()
  }
})

it('composes replies and topics over a single sync instance and fences replaceSession/close in order (replies -> topics -> sync)', async () => {
  const { net, session, onEnded } = open()
  try {
    expect(net.sockets).toHaveLength(1)
    const anchor = record(100, 'A')
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([anchor]).at(-1)?.created_seq ?? 0,  messages: [anchor], has_more: false })
    net.replyChains['A:id100'] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([anchor, { ...record(101, 'A'), reply_to: 'id100', reply_root_id: 'id100' }]).at(-1)?.created_seq ?? 0,
      root_id: 'id100',
      messages: [anchor, { ...record(101, 'A'), reply_to: 'id100', reply_root_id: 'id100' }],
      has_more: false,
    }))
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    await settle()

    await session.replies.open('A', anchor)
    expect(session.replies.get('A').messages.map((m) => m.id)).toEqual(['id100', 'id101'])
    expect(net.sockets).toHaveLength(1)

    const order: string[] = []
    session.replies.subscribe(() => {
      if (!order.includes('replies')) order.push('replies')
    })
    session.topics.subscribe(() => {
      if (!order.includes('topics')) order.push('topics')
    })
    session.sync.subscribe(() => {
      if (!order.includes('sync')) order.push('sync')
    })

    await session.sync.replaceSession('next')
    expect(order).toEqual(['replies', 'topics', 'sync'])
    expect(session.replies.get('A').anchor).toBeNull()

    order.length = 0
    await session.sync.close()
    expect(order).toEqual(['replies', 'topics', 'sync'])
    expect(onEnded).not.toHaveBeenCalled()
  } finally {
    session.close()
  }
})

it('composes unread, replies and topics over a single sync instance and fences replaceSession/close in order (unread -> replies -> topics -> sync)', async () => {
  const { net, session, onEnded } = open()
  try {
    expect(net.sockets).toHaveLength(1)
    const anchor = { ...record(100, 'A'), sender: 'other' }
    net.pages.A = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([anchor]).at(-1)?.created_seq ?? 0,  messages: [anchor], has_more: false })
    net.unreadChannels.A = { history_generation: '00000000-0000-4000-8000-000000000515',
      mention_unread_count: 0, main_mention_unread_count: 0,
      id: 'A',
      kind: 'channel', archived: false,
      name: 'A',
      visibility: 'public',
      capabilities: {
        can_add_members: { allowed: false },
        can_remove_members: { allowed: false },
        can_manage_managers: { allowed: false },
        can_leave: { allowed: true }, can_rename: { allowed: false }, can_archive: { allowed: false },
      },
      as_of_seq: 100,
      read_seq: 0,
      unread_count: 1,
      main_unread_count: 1,
    }
    net.replyChains['A:id100'] = ok(replyPage({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([anchor, { ...record(101, 'A'), reply_to: 'id100', reply_root_id: 'id100' }]).at(-1)?.created_seq ?? 0,
      root_id: 'id100',
      messages: [anchor, { ...record(101, 'A'), reply_to: 'id100', reply_root_id: 'id100' }],
      has_more: false,
    }))
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    await settle()

    await session.replies.open('A', anchor)
    await session.unread.enter({ channel: 'A', topicId: null })
    expect(session.unread.get('A').unreadCount).toBe(1)
    expect(session.unread.get('A').entry?.firstUnread?.id).toBe('id100')
    expect(net.sockets).toHaveLength(1)

    const order: string[] = []
    session.unread.subscribe(() => {
      if (!order.includes('unread')) order.push('unread')
    })
    session.replies.subscribe(() => {
      if (!order.includes('replies')) order.push('replies')
    })
    session.topics.subscribe(() => {
      if (!order.includes('topics')) order.push('topics')
    })
    session.sync.subscribe(() => {
      if (!order.includes('sync')) order.push('sync')
    })

    await session.sync.replaceSession('next')
    expect(order).toEqual(['unread', 'replies', 'topics', 'sync'])
    expect(session.unread.get('A').unreadCount).toBeNull()
    expect(session.unread.get('A').entry).toBeNull()
    expect(session.replies.get('A').anchor).toBeNull()

    order.length = 0
    await session.sync.close()
    expect(order).toEqual(['unread', 'replies', 'topics', 'sync'])
    expect(onEnded).not.toHaveBeenCalled()
  } finally {
    session.close()
  }
})

it('forwards capability invalidation reasons (reconcile, periodic, access) and escalates probe failure to access', async () => {
  vi.useFakeTimers()
  const net = fakeNetwork()
  const identity: api.Identity = {
    member: { id: 'me', name: '本人', role: 'member' },
    organization: {
      organization_id: 'org', name: '組織',
      capabilities: {
        can_invite: { allowed: false }, can_manage_roles: { allowed: false },
        can_deactivate_members: { allowed: false }, can_create_channels: { allowed: true },
      },
    },
  }
  const getMe = vi.spyOn(api, 'getOrganizationMe')
    .mockResolvedValueOnce(ok(identity))
    .mockResolvedValueOnce({ ok: false, kind: 'http', status: 503, retryAfterMs: 1_000 })
    .mockResolvedValue(ok(identity))
  const reasons: string[] = []
  const options = net.options()
  const session = createSession({
    selfId: 'me', onEnded: vi.fn(), ...options,
    sync: { ...options.sync, random: () => 0.5 }, initialRole: 'member',
    onIdentityInvalidated: reason => reasons.push(reason),
  })
  try {
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }))
    net.socket.onEvent({ type: 'activity_ready' })
    expect(reasons).toEqual(['reconcile'])
    await vi.advanceTimersByTimeAsync(200)

    // Periodic fires at 0.5 * 30_000 = 15_000 ms (14_800 ms after t=200); its /me returns 503 and escalates to 'access'.
    await vi.advanceTimersByTimeAsync(14_800)
    expect(reasons).toEqual(['reconcile', 'periodic'])
    await vi.advanceTimersByTimeAsync(200)
    expect(reasons).toEqual(['reconcile', 'periodic', 'access'])

    // members_changed invalidates with 'access'.
    net.socket.onEvent({ type: 'members_changed' })
    expect(reasons).toEqual(['reconcile', 'periodic', 'access', 'access'])
  } finally {
    session.close(); getMe.mockRestore(); vi.useRealTimers()
  }
})
