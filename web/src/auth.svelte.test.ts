import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuth, type AuthDeps, type SessionModel } from './auth.svelte'
import { channelsAdapter } from './channels.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { channel, fakeNetwork, mount, ok, record, sentBy, settle, type FakeNetwork } from './adapter-test-helpers.svelte'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const member = (id: string) => ({
  member: { id, name: id, role: 'owner' as const },
  organization: { organization_id: 'o', name: 'Org' },
})

const identity = (id: string) => ({ account: { id, email: `${id}@example.com` }, organizations: [{ organization_id: 'o', name: 'Org' }] })

/** Real controllers on fake transports; each opened session gets its own network, like a real page would. */
function stack(over: Partial<AuthDeps> = {}) {
  const nets: FakeNetwork[] = []
  const ended: (() => void)[] = []
  const closes: ReturnType<typeof vi.fn>[] = []
  let signedIn = 'owner'
  const deps: AuthDeps = {
    restore: vi.fn(async () => ({ screen: 'signin' as const })),
    signIn: vi.fn(async (email: string) => { signedIn = email.split('@')[0]; return ok({ identity: identity(signedIn) }) as never }),
    setupAndSignIn: vi.fn(),
    signOut: vi.fn(async () => true),
    getOrganization: vi.fn(async () => ok(member(signedIn))),
    openSession(selfId, onEnded): SessionModel {
      const net = fakeNetwork()
      nets.push(net)
      ended.push(onEnded)
      const session = createSession({ selfId, onEnded, ...net.options(selfId) })
      net.socket.onReady()
      const close = vi.fn(() => session.close())
      closes.push(close)
      return { channels: channelsAdapter(session.channels), sync: syncAdapter(session.sync), close }
    },
    ...over,
  }
  return { auth: createAuth(deps), deps, nets, ended, closes }
}
type Stack = ReturnType<typeof stack>

async function signInAs(s: Stack, id: string) {
  expect(await s.auth.submitSignIn(`${id}@example.com`, 'pw')).toBe(true)
  await settle()
}
/** Opens Channel A with one history Message and confirms the subscription on the newest session. */
async function openChannelA(s: Stack) {
  const net = s.nets.at(-1)!
  net.pages.A = ok({ messages: [record(100)], has_more: false })
  net.lists[0].resolve(ok({ channels: [channel('A')] }))
  await settle()
  net.subscribed('A', 100)
  await settle()
  return net
}

describe('auth adapter: screens', () => {
  it('shows each screen change, and opens the session only for the app screen', async () => {
    const s = stack()
    const view = await mount(() => ({ screen: s.auth.view.screen, session: s.auth.session }))
    expect(view.last).toMatchObject({ screen: 'loading', session: null })
    await s.auth.load()
    await settle()
    expect(view.last).toMatchObject({ screen: 'signin', session: null })
    expect(s.nets).toHaveLength(0)

    await signInAs(s, 'm1')
    expect(view.last.screen).toBe('app')
    expect(view.last.session).not.toBeNull()
    expect(s.nets).toHaveLength(1)

    expect(await s.auth.signOut()).toBe(true)
    await settle()
    expect(view.last).toMatchObject({ screen: 'signin', session: null })
    await view.unmount()
  })

  it('shows sign-in and sign-out failures without leaving the current screen or session', async () => {
    const s = stack({ signIn: vi.fn(async () => ({ ok: false, kind: 'http', status: 401 }) as never) })
    expect(await s.auth.submitSignIn('a@example.com', 'bad')).toBe(false)
    expect(s.auth.error).toBe('メールアドレスまたはパスワードが正しくありません。')
    expect(s.auth.busy).toBe(false)
    expect(s.auth.view.screen).not.toBe('app')

    const ok2 = stack({ signOut: vi.fn(async () => false) })
    await signInAs(ok2, 'm1')
    expect(await ok2.auth.signOut()).toBe(false)
    expect(ok2.auth.error).toBe('サーバーに接続できません。しばらくしてからもう一度お試しください。')
    expect(ok2.auth.view.screen).toBe('app')
    expect(ok2.closes[0]).not.toHaveBeenCalled()
    expect(ok2.nets[0].socket.closed).toBe(false)
  })

  it('setup goes to the app, or back to Sign in with the notice the auth layer chose', async () => {
    const s = stack({ setupAndSignIn: vi.fn(async () => ({ state: { screen: 'app' as const, identity: identity('owner') } })) })
    const req = { organization_name: 'Org', name: 'A', email: 'a@example.com', password: 'x'.repeat(12), setup_token: 'tok' }
    expect(await s.auth.submitSetup(req)).toBe(true)
    expect(s.auth.view.screen).toBe('app')
    const failed = stack({ setupAndSignIn: vi.fn(async () => ({ error: 'failed' })) })
    expect(await failed.auth.submitSetup(req)).toBe(false)
    expect(failed.auth.error).toBe('failed')
    const done = stack({ setupAndSignIn: vi.fn(async () => ({ state: { screen: 'signin' as const, notice: 'n' } })) })
    expect(await done.auth.submitSetup(req)).toBe(true)
    expect(done.auth.view).toMatchObject({ screen: 'signin', notice: 'n' })
  })
})

describe('auth adapter: session lifetime belongs to Sign in .. sign-out / 4001, not to observers', () => {
  it('unmounting every observer keeps the connection and sync state; remounting shows the intervening updates', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const net = await openChannelA(s)
    const a = () => s.auth.session!.sync.channel('A')
    const first = await mount(() => ({ timeline: a().timeline, live: a().live, channels: s.auth.session!.channels.state }))
    expect(first.last).toMatchObject({ live: true, timeline: { messages: [record(100)] } })

    await first.unmount() // what leaving the Workspace does
    expect(s.closes[0]).not.toHaveBeenCalled()
    expect(net.socket.closed).toBe(false)
    net.event({ type: 'message', message: record(101) })
    void a().send('typed while away')
    await settle()
    const requests = net.history.length

    const again = await mount(() => ({ timeline: a().timeline, live: a().live }))
    expect(again.last.live).toBe(true)
    expect(again.last.timeline.messages.map((m) => m.seq)).toEqual([100, 101])
    expect(again.last.timeline.pending).toMatchObject([{ body: 'typed while away' }])
    expect(net.history).toHaveLength(requests)
    expect(net.sockets).toHaveLength(1)
    await again.unmount()
  })

  it('sign-out closes the session and its connection; its observers see nothing more', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const net = await openChannelA(s)
    const old = s.auth.session!
    const view = await mount(() => old.sync.channel('A').timeline)
    expect(await s.auth.signOut()).toBe(true)
    await settle()
    expect(s.closes[0]).toHaveBeenCalledTimes(1)
    expect(net.socket.closed).toBe(true)
    const runs = view.values.length
    net.event({ type: 'message', message: record(101) }) // a late event of the ended session
    await settle()
    expect(view.last.messages.map((m) => m.seq)).not.toContain(101)
    expect(view.values.length).toBe(runs)
    await view.unmount()
  })

  it('4001 ends the session: Sign in with a notice, connection closed, no reconnect', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const net = await openChannelA(s)
    const view = await mount(() => ({ screen: s.auth.view, session: s.auth.session }))
    net.socket.onClose(4001)
    await settle()
    expect(view.last.screen).toMatchObject({ screen: 'signin', notice: 'セッションが終了しました。もう一度ログインしてください。' })
    expect(view.last.session).toBeNull()
    expect(s.closes[0]).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.nets).toHaveLength(1)
    expect(net.sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    await view.unmount()
  })

  it('a 401 on a send ends the session the same way', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const net = await openChannelA(s)
    void s.auth.session!.sync.channel('A').send('hi')
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'http', status: 401 })
    await settle()
    expect(s.auth.view).toMatchObject({ screen: 'signin', notice: expect.any(String) })
    expect(s.auth.session).toBeNull()
    expect(net.socket.closed).toBe(true)
  })

  it('an unavailable Channel stays in the session: no sign-out and no automatic retry', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const net = await openChannelA(s)
    net.event({ type: 'error', channel_id: 'A', code: 'channel_not_found' })
    await settle()
    const history = net.history.length
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(s.auth.view.screen).toBe('app')
    expect(s.auth.session!.sync.channel('A').timeline.status).toBe('unavailable')
    expect(net.history).toHaveLength(history)
    expect(s.closes[0]).not.toHaveBeenCalled()
  })
})

describe('auth adapter: a new session never shows the old one', () => {
  it('replacing the session closes the old one; its Messages, pending sends and late results stay out of the new one', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const first = await openChannelA(s)
    void s.auth.session!.sync.channel('A').send('secret of m1')
    await settle()
    const oldTimeline = s.auth.session!.sync.channel('A')

    await signInAs(s, 'm2') // another Member signs in on the same page without a sign-out in between
    expect(s.closes[0]).toHaveBeenCalledTimes(1)
    expect(first.socket.closed).toBe(true)
    const second = s.nets[1]
    const view = await mount(() => s.auth.session!.sync.channel('A').timeline)
    expect(view.last).toMatchObject({ status: 'loading', messages: [], pending: [] })
    expect(s.auth.session!.sync.channel('A')).not.toBe(oldTimeline)

    second.pages.A = ok({ messages: [record(500)], has_more: false })
    second.lists[0].resolve(ok({ channels: [channel('A')] }))
    await settle()
    second.subscribed('A', 500)
    // everything the old session still delivers
    first.sends[0].resolve(ok(sentBy('m1', 101, 'm1-c1', 'secret of m1')))
    first.socket.onEvent({ type: 'message', message: record(101) })
    first.lists[0].resolve(ok({ channels: [channel('A'), channel('old-only')] }))
    await settle()
    expect(view.last).toMatchObject({ status: 'ready', messages: [record(500)], pending: [] })
    expect(s.auth.session!.channels.state.channels.map((c) => c.id)).toEqual(['A'])
    expect(JSON.stringify(view.last)).not.toContain('secret of m1')
    await view.unmount()
  })

  it('an old session ending after it was replaced does not sign out the new one', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    await signInAs(s, 'm2')
    s.ended[0]() // e.g. the old controller's 401/4001 arriving late
    await settle()
    expect(s.auth.view.screen).toBe('app')
    expect(s.auth.session).not.toBeNull()
    expect(s.closes[1]).not.toHaveBeenCalled()
  })

  it('the Channel list and Channel creation of the previous session are not applied to the next one', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const old = s.auth.session!
    const creating = old.channels.create('general', 'public') // unanswered for now
    await settle()
    expect(await s.auth.signOut()).toBe(true)

    await signInAs(s, 'm2')
    const [first, second] = s.nets
    second.lists[0].resolve(ok({ channels: [channel('mine')] }))
    await settle()
    // The old session's answers arrive after the new session is up.
    first.lists[0].resolve(ok({ channels: [channel('theirs')] }))
    first.creates[0].resolve(ok(channel('general')))
    expect(await creating).toBe('セッションが終了しました。')
    await settle()
    expect(s.auth.session!.channels.state).toMatchObject({ channels: [{ id: 'mine' }], selectedId: 'mine' })
    expect(old.channels.state.channels).toEqual([])
    expect(first.history).toEqual([])
    expect(second.history.map((h) => h.channel)).toEqual(['mine'])
  })
})

describe('Organization selection fences data within one Account Session', () => {
  it('late Messages, send ACKs and Channel REST responses cannot change the selected Organization', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const first = await openChannelA(s)
    void s.auth.session!.sync.channel('A').send('old Organization')
    const oldList = s.auth.session!.channels.load()
    await settle()
    await s.auth.selectOrganization('other')
    const second = s.nets[1]
    second.lists[0].resolve(ok({ channels: [channel('B')] }))
    await settle()
    first.sends[0].resolve(ok(sentBy('m1', 101, 'm1-c1', 'old Organization')))
    first.socket.onEvent({ type: 'message', message: record(102) })
    first.lists[1].resolve(ok({ channels: [channel('old-only')] }))
    await oldList
    await settle()
    expect(first.socket.closed).toBe(true)
    expect(s.auth.selectedOrganizationId).toBe('other')
    expect(s.auth.session!.channels.state.channels.map(c => c.id)).toEqual(['B'])
    expect(s.auth.session!.sync.channel('A').timeline).toMatchObject({ messages: [], pending: [] })
    expect(s.auth.view.screen).toBe('app')
  })

  it('a late send 401 after a switch still signs out the same Account Session', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const first = await openChannelA(s)
    void s.auth.session!.sync.channel('A').send('old request')
    await settle()
    await s.auth.selectOrganization('other')
    first.sends[0].resolve({ ok: false, kind: 'http', status: 401 })
    await settle()
    expect(s.auth.view).toMatchObject({ screen: 'signin', notice: expect.any(String) })
    expect(s.auth.session).toBeNull()
    expect(s.nets[1].socket.closed).toBe(true)
  })

  it('a late Channel REST 401 after a switch still signs out the same Account Session', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const first = s.nets[0]
    await s.auth.selectOrganization('other')
    first.lists[0].resolve({ ok: false, kind: 'http', status: 401 })
    await settle()
    expect(s.auth.view.screen).toBe('signin')
  })

  it('a late 401 from a replaced Account Session is ignored', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const first = await openChannelA(s)
    void s.auth.session!.sync.channel('A').send('old account')
    await settle()
    await signInAs(s, 'm2')
    first.sends[0].resolve({ ok: false, kind: 'http', status: 401 })
    first.lists[0].resolve({ ok: false, kind: 'http', status: 401 })
    await settle()
    expect(s.auth.view.screen).toBe('app')
    expect(s.nets[1].socket.closed).toBe(false)
  })

  it('Membership loss is terminal only for its Organization and switching to another remains possible', async () => {
    const s = stack()
    await signInAs(s, 'm1')
    const first = await openChannelA(s)
    first.socket.onClose(4003)
    await settle()
    expect(s.auth.organizationStatus).toBe('unavailable')
    expect(s.auth.view.screen).toBe('app')
    await s.auth.selectOrganization('other')
    expect(s.auth.organizationStatus).toBe('ready')
    expect(s.nets).toHaveLength(2)
    await s.auth.selectOrganization('o')
    expect(s.auth.organizationStatus).toBe('unavailable')
    expect(s.nets).toHaveLength(2)
  })
})

it('a late Organization identity response is fenced after switching, but its same-Account 401 remains authoritative', async () => {
  let resolve!: (result: Awaited<ReturnType<AuthDeps['getOrganization']>>) => void
  const s = stack({ getOrganization: vi.fn(async (id: string): ReturnType<AuthDeps['getOrganization']> => id === 'held'
    ? new Promise(r => { resolve = r }) : ok(member('m1'))) })
  await signInAs(s, 'm1')
  const old = s.auth.selectOrganization('held')
  await s.auth.selectOrganization('other')
  resolve(ok({ ...member('old'), organization: { organization_id: 'held', name: 'Old' } }))
  await old
  expect(s.auth.selectedOrganizationId).toBe('other')
  expect(s.auth.organization!.member.id).toBe('m1')
  expect(s.nets).toHaveLength(2)

  const unauthorized = s.auth.selectOrganization('held')
  await s.auth.selectOrganization('other')
  resolve({ ok: false, kind: 'http', status: 401 })
  await unauthorized
  expect(s.auth.view.screen).toBe('signin')
  expect(s.auth.session).toBeNull()
})

it('shows context-specific 400 and wait-before-retrying 429 messages on sign-in, and clears sign-out errors on Organization switch', async () => {
  const s400 = stack({ signIn: vi.fn(async () => ({ ok: false, kind: 'http', status: 400 }) as never) })
  expect(await s400.auth.submitSignIn('bad', 'x')).toBe(false)
  expect(s400.auth.error).not.toContain('12文字')
  expect(s400.auth.error).toContain('入力内容を確認してください')

  const s429 = stack({ signIn: vi.fn(async () => ({ ok: false, kind: 'http', status: 429 }) as never) })
  expect(await s429.auth.submitSignIn('a@example.com', 'pw')).toBe(false)
  expect(s429.auth.error).toContain('しばらく待ってから')

  let finishSignOut!: (ok: boolean) => void
  const orgSwitch = stack({
    signOut: vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise(r => { finishSignOut = r })),
  })
  await signInAs(orgSwitch, 'm1')
  expect(await orgSwitch.auth.signOut()).toBe(false)
  expect(orgSwitch.auth.error).not.toBe('')

  await orgSwitch.auth.selectOrganization('other')
  expect(orgSwitch.auth.error).toBe('')
  expect(orgSwitch.auth.selectedOrganizationId).toBe('other')

  // An in-flight failed signOut started before switching Organizations does not re-populate error.
  const pendingSignOut = orgSwitch.auth.signOut()
  await orgSwitch.auth.selectOrganization('o')
  finishSignOut(false)
  expect(await pendingSignOut).toBe(false)
  expect(orgSwitch.auth.error).toBe('')
})

it('a new Account with no Organizations clears the previous unavailable Organization status', async () => {
  const s = stack()
  await signInAs(s, 'm1')
  s.nets[0].socket.onClose(4003)
  await settle()
  expect(s.auth.organizationStatus).toBe('unavailable')
  vi.mocked(s.deps.signIn).mockResolvedValueOnce(ok({ identity: { account: { id: 'empty', email: 'empty@example.com' }, organizations: [] } }) as never)
  await signInAs(s, 'empty')
  expect(s.auth.view.screen).toBe('app')
  expect(s.auth.organizationStatus).toBe('loading')
  expect(s.auth.organization).toBeNull()
  expect(s.auth.selectedOrganizationId).toBe('')
  expect(s.auth.session).toBeNull()
})
