import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAuth, type AuthDeps } from './auth.svelte'
import type { ChannelList, Result, TimelinePage } from './api'
import { channelsAdapter } from './channels.svelte'
import { createSession, type SessionOptions } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import { channel, fakeNetwork, ok, record, settle, type FakeNetwork } from './adapter-test-helpers.svelte'
import { deferred, summary } from './topic-test-helpers'
import { dm } from './dm-test-helpers'
import { createNavigation, type NavigationBrowser } from './navigation'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const capabilities = { can_invite: { allowed: true }, can_create_channels: { allowed: true },
  can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true } }
const organization = { organization_id: 'o', name: 'Org', capabilities }
const member = (id: string) => ({ organization, member: { id, name: id, role: 'owner' as const } })
const identity = (id: string) => ({ account: { id, email: `${id}@example.com` }, organizations: [organization] })
const restored = () => vi.fn(async () => ({ screen: 'app' as const, identity: identity('owner') }))
const generation = '00000000-0000-4000-8000-000000000515'
const list = (id: string) => ok<ChannelList>({
  history_generation: generation,
  channels: [{ ...channel(id), history_generation: generation, as_of_seq: 0, read_seq: 0,
    unread_count: 0, main_unread_count: 0, mention_unread_count: 0, main_mention_unread_count: 0 }],
})

function stack(over: Partial<AuthDeps>, sessionOptions?: Partial<SessionOptions>, navigation?: Parameters<typeof createAuth>[1]) {
  const nets: FakeNetwork[] = []
  const sessions: ReturnType<typeof createSession>[] = []
  const auth = createAuth({
    restore: restored(),
    signIn: async () => ok({ identity: identity('new'), expires_in: 60 }),
    setupAndSignIn: vi.fn(),
    signOut: async () => true,
    getOrganization: async () => ok(member('owner')),
    openSession(selfId, onEnded, organizationId, _drafts, _onIdentity, _role, accountSignal, _canCreate, initialChannels, initialSelection) {
      const net = fakeNetwork()
      nets.push(net)
      const options = net.options(selfId)
      const session = createSession({ selfId, onEnded, organizationId, accountSignal, initialChannels,
        ...options, ...sessionOptions, ...initialSelection, sync: { ...options.sync, ...sessionOptions?.sync } })
      sessions.push(session)
      net.socket.onReady()
      return { channels: channelsAdapter(session.channels, session.channelCreation), sync: syncAdapter(session.sync),
        topics: id => topicsAdapter(session.topics, id), close: session.close }
    },
    ...over,
  }, navigation)
  return { auth, nets, sessions }
}

const initialPage = (as_of_seq: number, ...items: TimelinePage['items']) =>
  ok<TimelinePage>({ history_generation: generation, as_of_seq, items, has_more: false })

function testNavigation(id: string, org = 'o') {
  const prefix = 'https://fukulow.invalid/o/' + org + '/c/'
  const location = { href: prefix + id }
  const browser = Object.assign(new EventTarget(), { location, history: {} })
  return {
    navigation: createNavigation(browser as unknown as NavigationBrowser),
    go(id: string) {
      location.href = prefix + id
      browser.dispatchEvent(new Event('popstate'))
    },
  }
}

it('discards a buffered early Timeline when the URL leaves and returns before wasm', async () => {
  const { navigation, go } = testNavigation('A')
  const core = deferred<void>()
  const early = deferred<Result<TimelinePage>>()
  const readInitialTimeline = vi.fn(() => early.promise)
  const s = stack({ coreReady: () => core.promise, readInitialChannels: async () => list('B'), readInitialTimeline }, undefined, navigation)
  try {
    const loading = s.auth.load()
    await settle()
    expect(readInitialTimeline).toHaveBeenCalledExactlyOnceWith('o', 'A', { history_generation: undefined }, undefined, expect.any(AbortSignal))
    early.resolve(initialPage(7, { kind: 'message', message: record(7, 'A') }))
    await settle()
    go('B'); go('A')
    core.resolve(); await loading; await settle()
    expect(s.nets[0].history).toEqual([{ channel: 'A', query: undefined }])
    expect(s.sessions[0].sync.get().channels.A.cursor).toBe(0)
    expect(s.sessions[0].topics.get('A').lines).toEqual([])
    expect(readInitialTimeline).toHaveBeenCalledOnce()
  } finally { navigation.destroy(); await s.auth.signOut() }
})

it('does not let a buffered early Timeline replace a learned Organization generation', async () => {
  const core = deferred<void>()
  const page = initialPage(7)
  if (page.ok) page.data.history_generation = '00000000-0000-4000-8000-000000000516'
  const readInitialTimeline = vi.fn(async () => page)
  const s = stack({ coreReady: () => core.promise, readInitialChannels: async () => list('A'), readInitialTimeline })
  const loading = s.auth.load()
  await settle()
  expect(readInitialTimeline).toHaveBeenCalledOnce()
  core.resolve(); await loading; await settle()
  expect(s.nets[0].history).toEqual([{ channel: 'A', query: undefined }])
  expect(s.sessions[0].sync.get()).toMatchObject({ historyGeneration: generation, historyEpoch: 0, channels: { A: { cursor: 0 } } })
  await s.auth.signOut()
})

it('validates the early Timeline with the same projection checks as an ordinary page', async () => {
  const core = deferred<void>()
  const incomplete = summary('T', 3, 1)
  Reflect.deleteProperty(incomplete, 'mention_unread_count')
  const readInitialTimeline = vi.fn(async () => initialPage(3, { kind: 'topic', topic: incomplete }))
  const s = stack({ coreReady: () => core.promise, readInitialChannels: async () => list('A'), readInitialTimeline })
  const loading = s.auth.load()
  await settle()
  expect(readInitialTimeline).toHaveBeenCalledOnce()
  core.resolve(); await loading; await settle()
  expect(s.nets[0].history).toEqual([])
  expect(s.sessions[0].topics.get('A').lines).toEqual([])
  expect(s.sessions[0].sync.get().channels.A).toMatchObject({ cursor: null, historyError: true })
  await s.auth.signOut()
})

it('switches a pending early Timeline to Message history as soon as DM discovery resolves', async () => {
  const { navigation } = testNavigation('D')
  const core = deferred<void>()
  const early = deferred<Result<TimelinePage>>()
  const readInitialTimeline = vi.fn(() => early.promise)
  const discovered = dm('D', { as_of_seq: 1, read_seq: 0 })
  const s = stack({ coreReady: () => core.promise, readInitialChannels: async () => list('A'), readInitialTimeline }, {
    dmsApi: {
      list: async () => ok({ history_generation: generation, dms: [discovered], next_cursor: null }),
      changes: async () => ok({ dms: [discovered], next_cursor: 'done', caught_up: true }),
      open: vi.fn(),
    },
  }, navigation)
  try {
    const loading = s.auth.load()
    await settle()
    expect(readInitialTimeline).toHaveBeenCalledExactlyOnceWith('o', 'D', { history_generation: undefined }, undefined, expect.any(AbortSignal))
    core.resolve(); await loading; await settle()
    const [net] = s.nets
    const [session] = s.sessions
    expect(net.history).toEqual([])
    const message = record(1, 'D')
    net.pages.D = ok({ history_generation: generation, as_of_seq: 1, messages: [message], has_more: true })
    net.event({ type: 'activity_ready' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(net.history).toEqual([{ channel: 'D', query: { history_generation: generation } }])
    expect(session.sync.get().channels.D).toMatchObject({ cursor: 1, messages: [message], hasOlder: true })
    early.resolve(initialPage(7, { kind: 'message', message: record(7, 'D') }))
    await settle()
    expect(session.sync.get().channels.D.cursor).toBe(1)
    expect(session.topics.get('D').main.asOfSeq).toBeUndefined()
  } finally { navigation.destroy(); await s.auth.signOut() }
})

it('starts the default Timeline after Organization authorization and replays from an empty early snapshot', async () => {
  const core = deferred<void>()
  const membership = deferred<Result<ReturnType<typeof member>>>()
  const readInitialChannels = vi.fn(async () => list('A'))
  const readInitialTimeline = vi.fn(async () => initialPage(7))
  const s = stack({ restore: restored(), getOrganization: () => membership.promise, coreReady: () => core.promise, readInitialChannels, readInitialTimeline })
  const loading = s.auth.load()
  await settle()
  expect(readInitialChannels).not.toHaveBeenCalled()
  expect(readInitialTimeline).not.toHaveBeenCalled()
  membership.resolve(ok(member('owner')))
  await settle()
  expect(readInitialTimeline).toHaveBeenCalledExactlyOnceWith('o', 'A', { history_generation: generation }, undefined, expect.any(AbortSignal))
  expect(s.nets).toHaveLength(0)
  core.resolve(); await loading; await settle()
  const [net] = s.nets
  const [session] = s.sessions
  expect(net.history).toEqual([])
  expect(net.socket.sent).toContainEqual({ type: 'subscribe', channel_id: 'A', after_seq: 7, history_generation: generation })
  net.event({ type: 'message', kind: 'create', seq: 8, message: record(8, 'A') })
  net.subscribed('A', 8)
  await settle()
  expect(session.sync.get().channels.A.cursor).toBe(8)
  expect(session.topics.get('A').lines).toMatchObject([{ kind: 'message', message: { id: 'id8' } }])
  await s.auth.signOut()
})

it.each([
  ['private Channel non-member', 'channel not found'],
  ['ungranted Guest', 'channel not found'],
  ['foreign-Organization Channel', 'channel not found'],
  ['DM non-participant', 'channel not found'],
  ['lost Organization Membership', 'organization_unavailable'],
])('honors the early Timeline denial for %s with an authorized control', async (denial, error) => {
  for (const authorized of [false, true]) {
    const core = deferred<void>()
    const org = denial === 'foreign-Organization Channel' && authorized ? 'owning-org' : 'o'
    const { navigation } = testNavigation('A', org)
    const readInitialTimeline = vi.fn(async (): Promise<Result<TimelinePage>> => authorized
      ? initialPage(3, { kind: 'message', message: record(3, 'A') })
      : { ok: false, kind: 'http', status: 404, error })
    const s = stack({ restore: restored(), coreReady: () => core.promise,
      getOrganization: async id => ok({ ...member('owner'), organization: { ...organization, organization_id: id } }),
      readInitialChannels: async () => list('B'), readInitialTimeline }, undefined, navigation)
    const loading = s.auth.load()
    await settle()
    expect(readInitialTimeline).toHaveBeenCalledExactlyOnceWith(org, 'A', { history_generation: undefined }, undefined, expect.any(AbortSignal))
    expect(s.nets).toHaveLength(0)
    core.resolve(); await loading; await settle()
    if (!authorized && error === 'organization_unavailable') {
      expect(s.auth.organizationStatus).toBe('unavailable')
      expect(s.sessions).toHaveLength(0)
    } else {
      const [session] = s.sessions
      const [net] = s.nets
      expect(net.history).toEqual([])
      expect(session.sync.get().channels.A.cursor).toBe(authorized ? 3 : null)
      expect(session.topics.get('A').lines).toHaveLength(authorized ? 1 : 0)
      expect(net.socket.sent.filter(frame => frame.type === 'subscribe')).toHaveLength(authorized ? 1 : 0)
      if (!authorized) expect(session.sync.get().channels.A.state).toBe('unavailable')
    }
    navigation.destroy()
    await s.auth.signOut()
  }
})

it.each([false, true])('observes a late early Timeline 401 after a switch with Account replacement = %s', async replace => {
  const core = deferred<void>()
  const late = deferred<Result<TimelinePage>>()
  const readInitialTimeline = vi.fn()
    .mockReturnValueOnce(late.promise)
    .mockResolvedValue(initialPage(0))
  const s = stack({ restore: restored(), coreReady: () => core.promise, readInitialTimeline,
    readInitialChannels: async id => list(id === 'o' ? 'A' : 'B') })
  const loading = s.auth.load()
  await settle()
  expect(readInitialTimeline).toHaveBeenCalledOnce()
  const switching = s.auth.selectOrganization('other')
  await settle()
  expect(readInitialTimeline).toHaveBeenCalledTimes(2)
  if (replace) {
    expect(await s.auth.signOut()).toBe(true)
    void s.auth.submitSignIn('new@example.com', 'test')
    await settle()
  }
  late.resolve({ ok: false, kind: 'http', status: 401 })
  await settle()
  expect(s.auth.view.screen).toBe(replace ? 'app' : 'signin')
  core.resolve(); await loading; await switching; await settle()
  expect(s.sessions).toHaveLength(replace ? 1 : 0)
  if (replace) await s.auth.signOut()
})

it('a late early Timeline 401 still ends the same Account Session after Channel selection changes', async () => {
  const core = deferred<void>()
  const late = deferred<Result<TimelinePage>>()
  const readInitialTimeline = vi.fn(() => late.promise)
  const s = stack({ coreReady: () => core.promise, readInitialTimeline, readInitialChannels: async () => list('A') })
  const loading = s.auth.load()
  await settle()
  expect(readInitialTimeline).toHaveBeenCalledOnce()
  core.resolve(); await loading; await settle()
  s.sessions[0].channels.selectHint('B')
  await settle()
  expect(s.sessions[0].sync.get().channels.B.cursor).toBe(0)
  late.resolve({ ok: false, kind: 'http', status: 401 })
  await settle()
  expect(s.auth.view.screen).toBe('signin')
})

it('late early Timeline Membership loss cannot end a different Organization selection', async () => {
  const core = deferred<void>()
  const late = deferred<Result<TimelinePage>>()
  const readInitialTimeline = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue(initialPage(0))
  const s = stack({ coreReady: () => core.promise, readInitialTimeline, readInitialChannels: async () => list('A') })
  const loading = s.auth.load()
  await settle()
  expect(readInitialTimeline).toHaveBeenCalledOnce()
  const switching = s.auth.selectOrganization('other')
  await settle()
  late.resolve({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
  await settle()
  expect(s.auth.organizationStatus).toBe('loading')
  core.resolve(); await loading; await switching; await settle()
  expect(s.auth.selectedOrganizationId).toBe('other')
  expect(s.auth.organizationStatus).toBe('ready')
  expect(s.sessions[0].sync.get().organization).toBe('available')
  expect(s.nets[0].history).toEqual([])
  await s.auth.signOut()
})

it('a newer main projection supersedes a pending early Timeline', async () => {
  const core = deferred<void>()
  const late = deferred<Result<TimelinePage>>()
  const readInitialTimeline = vi.fn(() => late.promise)
  const s = stack({ coreReady: () => core.promise, readInitialTimeline, readInitialChannels: async () => list('A') })
  const loading = s.auth.load()
  await settle()
  expect(readInitialTimeline).toHaveBeenCalledOnce()
  core.resolve(); await loading; await settle()
  const [net] = s.nets
  const [session] = s.sessions
  expect(net.history).toEqual([])
  net.timelines.A = initialPage(8, { kind: 'message', message: record(8, 'A') })
  await session.topics.loadMainLatest('A')
  await settle()
  expect(session.sync.get().channels.A.latest).toBeUndefined()
  late.resolve(initialPage(7, { kind: 'message', message: record(7, 'A') }))
  await settle()
  expect(session.topics.get('A').main.asOfSeq).toBe(8)
  expect(session.topics.get('A').lines).toMatchObject([{ kind: 'message', message: { id: 'id8' } }])
  await s.auth.signOut()
})

it('an expired core bootstrap cannot issue a fresh Timeline from the retired read', async () => {
  const core = deferred<void>()
  const late = deferred<Result<TimelinePage>>()
  const readInitialTimeline = vi.fn(() => late.promise)
  const s = stack({ coreReady: () => core.promise, readInitialTimeline, readInitialChannels: async () => list('A') },
    { sync: { requestTimeoutMs: 50 } })
  const loading = s.auth.load()
  await settle()
  expect(readInitialTimeline).toHaveBeenCalledOnce()
  core.resolve(); await loading; await settle()
  const [net] = s.nets
  const [session] = s.sessions
  await vi.advanceTimersByTimeAsync(50)
  expect(session.sync.get().channels.A.historyError).toBe(true)
  expect(net.history).toEqual([])
  late.resolve(initialPage(7))
  await settle()
  expect(session.topics.get('A').main.asOfSeq).toBeUndefined()
  await session.sync.getTimeline('A').loadLatest()
  expect(net.history).toEqual([{ channel: 'A', query: undefined }])
  expect(session.sync.get().channels.A.cursor).toBe(0)
  await s.auth.signOut()
})

it.each(['selection', 'reconnect', 'history reset', 'revoke and re-grant', 'deadline'])(
  'discards a pending early Timeline across %s', async reason => {
    const core = deferred<void>()
    const late = deferred<Result<TimelinePage>>()
    const readInitialTimeline = vi.fn(() => late.promise)
    const s = stack({ restore: restored(), coreReady: () => core.promise, readInitialTimeline, readInitialChannels: async () => list('A') })
    const loading = s.auth.load()
    await settle()
    expect(readInitialTimeline).toHaveBeenCalledOnce()
    core.resolve(); await loading; await settle()
    const [net] = s.nets
    const [session] = s.sessions
    expect(net.history).toEqual([])
    const earlyRequest = session.sync.get().channels.A.latest!
    const fresh = record(1, 'A')
    net.timelines.A = initialPage(1, { kind: 'message', message: fresh })
    if (reason === 'selection') {
      session.channels.selectHint('B')
      session.channels.selectHint('A')
    } else if (reason === 'reconnect') {
      net.socket.onClose(1006)
    } else if (reason === 'history reset') {
      session.sync.observeHistoryGeneration()
      expect(session.sync.get().historyEpoch).toBe(1)
    } else if (reason === 'revoke and re-grant') {
      net.event({ type: 'channel_access_revoked', channel_id: 'A' })
      net.event({ type: 'channel_access_gained', channel_id: 'A' })
    } else {
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await settle()
    expect(net.history.filter(request => request.channel === 'A')).toHaveLength(1)
    expect(session.sync.request(earlyRequest)).toBeUndefined()
    expect(session.sync.get().channels.A.cursor).toBe(1)
    late.resolve(initialPage(7, { kind: 'message', message: record(7, 'A') }))
    await settle()
    expect(session.sync.get().historyGeneration).toBe(generation)
    expect(session.topics.get('A').lines).toMatchObject([{ kind: 'message', message: { id: fresh.id } }])
    expect(readInitialTimeline).toHaveBeenCalledOnce()
    await s.auth.signOut()
  },
)
