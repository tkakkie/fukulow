import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuth, type AuthDeps, type SessionModel } from './auth.svelte'
import { channelsAdapter } from './channels.svelte'
import { createSession } from './session'
import { createInviteAcceptance, createMembers } from './members'
import { inviteAcceptanceAdapter, membersAdapter } from './members.svelte'
import type { lookupAuthors } from './api'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import type { DraftStore } from './drafts'
import { channel, fakeNetwork, mount, ok, record, sentBy, settle, type FakeNetwork } from './adapter-test-helpers.svelte'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const member = (id: string) => ({
  member: { id, name: id, role: 'owner' as const },
  organization: { organization_id: 'o', name: 'Org', capabilities: { can_invite: { allowed: true }, can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true }, can_create_channels: { allowed: true } } },
})

const identity = (id: string) => ({ account: { id, email: `${id}@example.com` }, organizations: [{ organization_id: 'o', name: 'Org', capabilities: { can_invite: { allowed: true }, can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true }, can_create_channels: { allowed: true } } }] })

/** Real controllers on fake transports; each opened session gets its own network, like a real page would. */
function stack(over: Partial<AuthDeps> = {}) {
  const nets: FakeNetwork[] = []
  const ended: (() => void)[] = []
  const closes: ReturnType<typeof vi.fn>[] = []
  const stores: DraftStore[] = []
  let signedIn = 'owner'
  const deps: AuthDeps = {
    restore: vi.fn(async () => ({ screen: 'signin' as const })),
    signIn: vi.fn(async (email: string) => { signedIn = email.split('@')[0]; return ok({ identity: identity(signedIn) }) as never }),
    setupAndSignIn: vi.fn(),
    signOut: vi.fn(async () => true),
    getOrganization: vi.fn(async () => ok(member(signedIn))),
    openSession(selfId, onEnded, organizationId, drafts): SessionModel {
      if (drafts) stores.push(drafts)
      const net = fakeNetwork()
      nets.push(net)
      ended.push(onEnded)
      const session = createSession({ selfId, onEnded, ...net.options(selfId), organizationId, sync: { ...net.options(selfId).sync, drafts } })
      net.socket.onReady()
      const close = vi.fn(() => session.close())
      closes.push(close)
      return { channels: channelsAdapter(session.channels), sync: syncAdapter(session.sync), topics: id => topicsAdapter(session.topics, id), close }
    },
    ...over,
  }
  return { auth: createAuth(deps), deps, nets, ended, closes, stores }
}
type Stack = ReturnType<typeof stack>

async function signInAs(s: Stack, id: string) {
  expect(await s.auth.submitSignIn(`${id}@example.com`, 'pw')).toBe(true)
  await settle()
}
/** Opens Channel A with one history Message and confirms the subscription on the newest session. */
async function openChannelA(s: Stack, hasOlder = false) {
  const net = s.nets.at(-1)!
  net.pages.A = ok({ messages: [record(100)], has_more: hasOlder })
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

  it('author lookup Membership loss preserves the Workspace history draft and pending send until explicit Organization re-selection', async () => {
    vi.useFakeTimers()
    const finishes: ((result: Awaited<ReturnType<typeof lookupAuthors>>) => void)[] = []
    const lookup = vi.fn(() => new Promise<Awaited<ReturnType<typeof lookupAuthors>>>(resolve => { finishes.push(resolve) }))
    const listMembers = vi.fn(async () => ok({ members: [{ id: 'known', name: 'Known', role: 'member' as const }] }))
    const s = stack({
      openMembers: (id, ended, unavailable) => membersAdapter(createMembers(id, ended, unavailable, {
        listMembers, lookupAuthors: lookup,
        changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
      })),
    })
    await signInAs(s, 'm1')
    const net = await openChannelA(s)
    const session = s.auth.session!, members = s.auth.members!
    const ch = session.sync.channel('A')
    void ch.send('pending text')
    await settle()
    ch.setDraft('draft text')
    members.authors.watch(['known', 'unknown'])
    await settle()
    members.authors.watch(['known', 'unknown', 'late'])
    await settle()
    const displayed = await mount(() => ({
      session: s.auth.session, organization: s.auth.organization, status: s.auth.organizationStatus,
      timeline: s.auth.session?.sync.channel('A').timeline,
      draft: s.auth.session?.sync.channel('A').composer.draft,
    }))
    finishes[0]({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
    await settle()
    expect(displayed.last).toMatchObject({
      session, organization: member('m1'), status: 'unavailable', draft: 'draft text',
      timeline: { messages: [record(100)], pending: [{ body: 'pending text', status: 'failed', retryable: false }] },
    })
    expect(s.closes[0]).not.toHaveBeenCalled()
    expect(net.socket.closed).toBe(true)
    const historyCount = net.history.length
    members.authors.watch(['another']); members.authors.retry(); await members.load()
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(listMembers).toHaveBeenCalledTimes(1)
    expect(net.history).toHaveLength(historyCount)
    expect(net.sends).toHaveLength(1)
    expect(net.sockets).toHaveLength(1)
    expect(members.authors.identities.get('known')?.name).toBe('Known')

    await s.auth.selectOrganization('o')
    expect(s.auth.session).not.toBe(session)
    expect(s.auth.organizationStatus).toBe('ready')
    s.auth.members!.authors.watch(['unknown'])
    await settle()
    expect(lookup).toHaveBeenCalledTimes(3)
    // A same-Account late 401 remains authoritative even after explicit re-selection.
    finishes[1]({ ok: false, kind: 'http', status: 401 })
    await settle()
    expect(s.auth.view.screen).toBe('signin')
    await displayed.unmount()
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
    expect(await creating).toEqual({ error: 'セッションが終了しました。' })
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
    vi.mocked(s.deps.getOrganization).mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
    await s.auth.selectOrganization('o')
    expect(s.auth.organizationStatus).toBe('unavailable')
    expect(s.nets).toHaveLength(2)
    const calls = vi.mocked(s.deps.getOrganization).mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.deps.getOrganization).toHaveBeenCalledTimes(calls)
    // Re-invited Membership is checked only after explicit user action; start fresh sync state.
    await s.auth.selectOrganization('o')
    expect(s.auth.organizationStatus).toBe('ready')
    expect(s.nets).toHaveLength(3)
    expect(s.auth.session!.sync.channel('A').timeline.messages).toEqual([])
  })
})

it('a late Organization identity response is fenced after switching, but its same-Account 401 remains authoritative', async () => {
  let resolve!: (result: Awaited<ReturnType<AuthDeps['getOrganization']>>) => void
  const s = stack({ getOrganization: vi.fn(async (id: string): ReturnType<AuthDeps['getOrganization']> => id === 'held'
    ? new Promise(r => { resolve = r }) : ok(member('m1'))) })
  await signInAs(s, 'm1')
  const old = s.auth.selectOrganization('held')
  await s.auth.selectOrganization('other')
  resolve(ok({ ...member('old'), organization: { ...member('old').organization, organization_id: 'held', name: 'Old' } }))
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

it('accepting an Invite rechecks Membership in the current Account Session; replaced-Account acceptance is fenced', async () => {
  const s = stack()
  await signInAs(s, 'm1')
  s.nets[0].socket.onClose(4003)
  await settle()
  const invitation = inviteAcceptanceAdapter(createInviteAcceptance({ organizationId: 'o', token: 'a'.repeat(64) }, vi.fn(async () => ok(member('m1')))))
  await s.auth.acceptInvitation(invitation, { email: 'm1@example.com', name: 'Member', password: null })
  expect(s.auth.organizationStatus).toBe('ready')
  expect(s.nets).toHaveLength(2)
  let finish!: (result: Awaited<ReturnType<AuthDeps['getOrganization']>>) => void
  const late = inviteAcceptanceAdapter(createInviteAcceptance({ organizationId: 'old', token: 'b'.repeat(64) }, () => new Promise(r => { finish = r })))
  const accepting = s.auth.acceptInvitation(late, { email: 'm1@example.com', name: 'Member', password: null })
  await signInAs(s, 'm2')
  finish(ok(member('m1')))
  await accepting
  expect(s.auth.organization!.member.id).toBe('m2')
  expect(s.nets).toHaveLength(3)
})

it('Account Session drafts survive Organization re-selection and A to B to A with the same Channel id', async () => {
  const s = stack()
  await signInAs(s, 'm1')
  await openChannelA(s)
  s.auth.session!.sync.channel('A').setDraft('組織Aの下書き')
  await s.auth.selectOrganization('other')
  expect(s.auth.session!.sync.channel('A').composer.draft).toBe('')
  s.auth.session!.sync.channel('A').setDraft('組織Bの下書き')
  await s.auth.selectOrganization('o')
  expect(s.auth.session!.sync.channel('A').composer.draft).toBe('組織Aの下書き')
  await s.auth.selectOrganization('o')
  expect(s.auth.session!.sync.channel('A').composer.draft).toBe('組織Aの下書き')
  await s.auth.selectOrganization('other')
  expect(s.auth.session!.sync.channel('A').composer.draft).toBe('組織Bの下書き')
  await s.auth.signOut()
})

it('sign-out, expiry, 401 and Account replacement drop every Organization draft', async () => {
  for (const end of ['sign-out', 'expiry', '401', 'Account replacement'] as const) {
    const s = stack()
    await signInAs(s, 'm1')
    await openChannelA(s)
    s.auth.session!.sync.channel('A').setDraft('組織Aの下書き')
    await s.auth.selectOrganization('other')
    const net = await openChannelA(s)
    const a = s.auth.session!.sync.channel('A')
    a.setDraft('組織Bの下書き')
    expect(s.auth.hasUnsavedChanges()).toBe(true)
    if (end === 'sign-out') await s.auth.signOut()
    else if (end === 'expiry') net.socket.onClose(4001)
    else if (end === '401') {
      void a.send('401になる送信')
      await settle()
      net.sends[0].resolve({ ok: false, kind: 'http', status: 401 })
    } else await signInAs(s, 'm2')
    await settle()
    // Check before signing in again: that must not mask a failure to clear on Session end.
    expect(s.auth.hasUnsavedChanges(), end).toBe(false)
    if (end !== 'Account replacement') await signInAs(s, 'm1')
    expect(s.auth.session!.sync.channel('A').composer.draft, end).toBe('')
    await s.auth.selectOrganization('other')
    expect(s.auth.session!.sync.channel('A').composer.draft, end).toBe('')
    await s.auth.signOut()
  }
})

it.each(['sign-out', '4001', '401', 'Account change'] as const)(
  'late send completions and old draft intents cannot repopulate drafts after %s', async end => {
    for (const outcome of ['refusal', 'ACK'] as const) {
      const s = stack()
      await signInAs(s, 'm1')
      const net = await openChannelA(s)
      const old = s.auth.session!.sync.channel('A')
      old.setDraft('送信する本文')
      const pending = old.submit()
      const send = net.sends[0]
      expect(old.timeline.pending).toHaveLength(1)
      if (end === 'sign-out') await s.auth.signOut()
      else if (end === '4001') net.socket.onClose(4001)
      else if (end === '401') {
        void old.send('別の送信')
        net.sends[1].resolve({ ok: false, kind: 'http', status: 401 })
      } else await signInAs(s, 'm2')
      await settle()
      expect(s.auth.hasUnsavedChanges()).toBe(false)
      send.resolve(outcome === 'refusal' ? { ok: false, kind: 'http', status: 400 }
        : ok(sentBy('m1', 101, send.body.client_message_id, send.body.body)))
      await pending
      await settle()
      expect(s.stores[0].hasDrafts()).toBe(false)
      expect(s.auth.hasUnsavedChanges()).toBe(false)
      if (end !== 'Account change') await signInAs(s, 'm1')
      const current = s.auth.session!.sync.channel('A')
      expect(current.composer.draft).toBe('')
      // Retained old adapters must not restore, insert or erase the new Session's drafts.
      expect(old.restore(send.body.client_message_id)).toBe(false)
      old.setDraft('古いセッションの下書き')
      expect(s.auth.hasUnsavedChanges()).toBe(false)
      current.setDraft('新しいセッションの下書き')
      old.setDraft('')
      expect(s.stores.at(-1)!.get({ organizationId: 'o', channelId: 'A' })).toBe('新しいセッションの下書き')
      await s.auth.selectOrganization('o')
      expect(s.auth.session!.sync.channel('A').composer.draft).toBe('新しいセッションの下書き')
      await s.auth.signOut()
    }
  },
)

it('a late refusal after an Organization switch restores only its unedited draft and leaves the selected Organization alone', async () => {
  for (const edit of ['untouched', 'typed then cleared', 'new text', 'reopened then cleared', 'settled', 'Channel access lost'] as const) {
    const s = stack()
    await signInAs(s, 'm1')
    const net = await openChannelA(s)
    const a = s.auth.session!.sync.channel('A')
    a.setDraft('送信する本文')
    const pending = a.submit()
    const send = net.sends[0]
    if (edit === 'typed then cleared' || edit === 'new text') a.setDraft('編集中の下書き')
    if (edit === 'typed then cleared') a.setDraft('')
    if (edit === 'settled') {
      net.event({ type: 'message', message: sentBy('m1', 101, send.body.client_message_id, send.body.body) })
      await settle()
      expect(a.timeline.pending).toHaveLength(0)
    }
    if (edit === 'Channel access lost') {
      net.event({ type: 'channel_access_lost', channel_id: 'A' })
      await settle()
      expect(a.timeline.status).toBe('unavailable')
    }
    await s.auth.selectOrganization('other')
    const b = s.auth.session!.sync.channel('A')
    b.setDraft('組織Bの下書き')
    if (edit === 'reopened then cleared') {
      await s.auth.selectOrganization('o')
      const reopened = s.auth.session!.sync.channel('A')
      reopened.setDraft('新しく編集した下書き')
      reopened.setDraft('')
      await s.auth.selectOrganization('other')
    }
    send.resolve({ ok: false, kind: 'http', status: 400 })
    await pending
    await settle()
    const expected = edit === 'untouched' ? '送信する本文' : edit === 'new text' ? '編集中の下書き' : ''
    expect(s.stores[0].get({ organizationId: 'o', channelId: 'A' }), edit).toBe(expected)
    expect(s.stores.at(-1)!.get({ organizationId: 'other', channelId: 'A' }), edit).toBe('組織Bの下書き')
    expect(s.auth.session!.sync.channel('A').composer.draft, edit).toBe('組織Bの下書き')
    await s.auth.selectOrganization('o')
    expect(s.auth.session!.sync.channel('A').composer.draft, edit).toBe(expected)
    expect(s.auth.hasUnsavedChanges()).toBe(true)
    await s.auth.signOut()
  }
})

/** Return before the old send answers, with an observed Composer and a cached Channel extra. */
async function returnWithPendingSend(timedOut = false, target: 'channel' | 'new topic' | 'topic' = 'channel') {
  const s = stack()
  await signInAs(s, 'm1')
  const first = await openChannelA(s)
  const old = s.auth.session!.sync.channel('A')
  const oldComposer = target === 'topic' ? old.topic('T') : old
  oldComposer.setDraft('送信する本文')
  if (target === 'new topic') old.setTopicDraft('仕様相談')
  const pending = target === 'topic' ? old.topic('T').submit('仕様相談') : old.submit()
  if (timedOut) {
    await vi.advanceTimersByTimeAsync(30_000)
    expect(old.timeline.pending).toMatchObject([{ status: 'failed', retryable: true }])
  }
  await s.auth.selectOrganization('other')
  await openChannelA(s)
  s.auth.session!.sync.channel('A').setDraft('組織Bの下書き')
  await s.auth.selectOrganization('o')
  const returned = await openChannelA(s, true)
  const current = s.auth.session!.sync.channel('A')
  // Topic bootstrap exposes only W to sync. Load an unfiltered window with older history
  // before exercising sync's older-page error (projection paging has separate state).
  await current.loadLatest()
  // Keep a non-draft extra cached: a store-only write must update it and notify the adapter.
  returned.pages.A = { ok: false, kind: 'network' }
  await current.loadOlder()
  await settle()
  const composer = await mount(() => target === 'topic'
    ? { ...current.timeline, ...current.composer, ...current.topic('T').composer }
    : { ...current.timeline, ...current.composer })
  expect(composer.last).toMatchObject({ draft: '', olderError: true, pending: [] })
  // Closing cancels the old wait; cancellation alone never restores text.
  expect(await pending).toBe(true)
  return { s, send: first.sends[0], current, composer }
}

it('A to B to A shows a late 409 restore in the current Composer without user action', async () => {
  const { s, send, composer } = await returnWithPendingSend()
  send.resolve({ ok: false, kind: 'http', status: 409 })
  await settle()
  expect(composer.last).toMatchObject({ draft: '送信する本文', olderError: true, pending: [] })
  expect(s.stores.at(-1)!.get({ organizationId: 'o', channelId: 'A' })).toBe('送信する本文')
  expect(s.stores.at(-1)!.get({ organizationId: 'other', channelId: 'A' })).toBe('組織Bの下書き')
  await composer.unmount()
  await s.auth.signOut()
})

it.each(['new text', 'typed then cleared'] as const)(
  'A to B to A preserves current Composer edits after a late 409: %s', async edit => {
    const { s, send, current, composer } = await returnWithPendingSend()
    current.setDraft('新しく編集した下書き')
    if (edit === 'typed then cleared') current.setDraft('')
    await settle()
    const expected = edit === 'new text' ? '新しく編集した下書き' : ''
    expect(composer.last.draft).toBe(expected)
    send.resolve({ ok: false, kind: 'http', status: 409 })
    await settle()
    expect(composer.last.draft).toBe(expected)
    expect(s.stores.at(-1)!.get({ organizationId: 'o', channelId: 'A' })).toBe(expected)
    await composer.unmount()
    await s.auth.signOut()
  },
)

it.each(['ACK', 'network', 'timeout', '503'] as const)(
  'A to B to A never restores an ACK or unknown outcome in the current Composer: %s', async outcome => {
    const { s, send, composer } = await returnWithPendingSend(outcome === 'timeout')
    send.resolve(outcome === 'ACK' ? ok(sentBy('m1', 101, send.body.client_message_id, send.body.body))
      : outcome === 'network' ? { ok: false, kind: 'network' }
        : { ok: false, kind: 'http', status: outcome === 'timeout' ? 409 : 503 })
    await settle()
    expect(composer.last).toMatchObject({ draft: '', pending: [] })
    expect(s.stores.at(-1)!.get({ organizationId: 'o', channelId: 'A' })).toBe('')
    await composer.unmount()
    await s.auth.signOut()
  },
)

it.each(['new topic', 'topic'] as const)(
  'A to B to A restores a late refusal into the current %s Composer with its Topic intent', async target => {
    const { s, send, current, composer } = await returnWithPendingSend(false, target)
    if (target === 'topic') current.setDraft('チャンネルに残す下書き')
    send.resolve({ ok: false, kind: 'http', status: 409 })
    await settle()
    expect(composer.last).toMatchObject({ draft: '送信する本文', olderError: true, pending: [] })
    expect(composer.last.topicDraft).toBe(target === 'new topic' ? '仕様相談' : '')
    expect(current.composer.draft).toBe(target === 'topic' ? 'チャンネルに残す下書き' : '送信する本文')
    expect(current.topic('other-topic').composer.draft).toBe('')
    expect(s.stores.at(-1)!.get({ organizationId: 'other', channelId: 'A' })).toBe('組織Bの下書き')
    await composer.unmount()
    // Restored text and Topic intent must survive another controller lifetime.
    await s.auth.selectOrganization('other')
    await s.auth.selectOrganization('o')
    const reopened = s.auth.session!.sync.channel('A')
    expect(target === 'topic' ? reopened.topic('T').composer.draft : reopened.composer.draft).toBe('送信する本文')
    expect(reopened.composer.topicDraft).toBe(target === 'new topic' ? '仕様相談' : '')
    await s.auth.signOut()
  },
)

it.each(['new topic', 'topic'] as const)(
  'A to B to A protects edits to the current %s draft from an old refusal', async target => {
    for (const clear of [false, true]) {
      const { s, send, current, composer } = await returnWithPendingSend(false, target)
      if (target === 'topic') {
        current.topic('T').setDraft('新しい本文')
        if (clear) current.topic('T').setDraft('')
      } else {
        // Editing only the Topic name must advance the shared draft revision too.
        current.setTopicDraft('新しいトピック')
        if (clear) current.setTopicDraft('')
      }
      await settle()
      send.resolve({ ok: false, kind: 'http', status: 409 })
      await settle()
      expect(composer.last.draft).toBe(target === 'topic' && !clear ? '新しい本文' : '')
      expect(composer.last.topicDraft).toBe(target === 'new topic' && !clear ? '新しいトピック' : '')
      await composer.unmount()
      await s.auth.signOut()
    }
  },
)

it.each(['new topic', 'topic'] as const)(
  'A to B to A never restores an ACK or unknown send into the %s Composer', async target => {
    for (const outcome of ['ACK', 'network', 'timeout', '503'] as const) {
      const { s, send, composer } = await returnWithPendingSend(outcome === 'timeout', target)
      send.resolve(outcome === 'ACK' ? ok({ ...sentBy('m1', 101, send.body.client_message_id, send.body.body), topic_id: 'T' })
        : outcome === 'network' ? { ok: false, kind: 'network' }
          : { ok: false, kind: 'http', status: outcome === 'timeout' ? 409 : 503 })
      await settle()
      expect(composer.last).toMatchObject({ draft: '', topicDraft: '', pending: [] })
      await composer.unmount()
      await s.auth.signOut()
    }
  },
)

it('Topic drafts and Channel topicDraft survive Organization switches, including a Topic name without a body', async () => {
  const s = stack()
  await signInAs(s, 'm1')
  const old = s.auth.session!.sync.channel('A')
  old.setTopicDraft('仕様相談')
  await s.auth.selectOrganization('other')
  // A Topic name alone is still an unsaved draft, outside the old controller.
  expect(s.auth.hasUnsavedChanges()).toBe(true)
  await s.auth.selectOrganization('o')
  expect(s.auth.session!.sync.channel('A').composer).toMatchObject({ draft: '', topicDraft: '仕様相談' })
  s.auth.session!.sync.channel('A').topic('T').setDraft('トピックの下書き')
  await s.auth.selectOrganization('other')
  expect(s.auth.hasUnsavedChanges()).toBe(true)
  const other = s.auth.session!.sync.channel('A')
  expect(other.composer.topicDraft).toBe('')
  expect(other.topic('T').composer.draft).toBe('')
  other.setTopicDraft('組織Bのトピック')
  other.topic('T').setDraft('組織Bの下書き')
  await s.auth.selectOrganization('o')
  expect(s.auth.session!.sync.channel('A').composer).toMatchObject({ draft: '', topicDraft: '仕様相談' })
  expect(s.auth.session!.sync.channel('A').topic('T').composer.draft).toBe('トピックの下書き')
  await s.auth.signOut()
})

it.each(['new topic', 'topic'] as const)(
  'settlement, Channel access loss and Account Session end fence late %s draft restores', async target => {
    for (const end of ['settled', 'Channel access lost', 'sign-out', '4001', '401', 'Account change'] as const) {
      const s = stack()
      await signInAs(s, 'm1')
      const net = await openChannelA(s)
      const old = s.auth.session!.sync.channel('A')
      const oldComposer = target === 'topic' ? old.topic('T') : old
      oldComposer.setDraft('送信する本文')
      if (target === 'new topic') old.setTopicDraft('仕様相談')
      const pending = target === 'topic' ? old.topic('T').submit('仕様相談') : old.submit()
      const send = net.sends[0]
      if (end === 'settled') {
        net.event({ type: 'message', message: { ...sentBy('m1', 101, send.body.client_message_id, send.body.body), topic_id: 'T' } })
        await settle()
        expect(old.timeline.pending).toEqual([])
      } else if (end === 'Channel access lost') {
        net.event({ type: 'channel_access_lost', channel_id: 'A' })
        await settle()
        expect(old.timeline.status).toBe('unavailable')
      }
      await s.auth.selectOrganization('other')
      if (end === 'sign-out') await s.auth.signOut()
      else if (end === '4001') s.nets.at(-1)!.socket.onClose(4001)
      else if (end === '401') {
        void s.auth.session!.sync.channel('A').send('401になる送信')
        s.nets.at(-1)!.sends[0].resolve({ ok: false, kind: 'http', status: 401 })
      } else if (end === 'Account change') await signInAs(s, 'm2')
      await settle()
      send.resolve({ ok: false, kind: 'http', status: 409 })
      expect(await pending).toBe(true)
      await settle()
      expect(s.stores.at(-1)!.hasDrafts(), end).toBe(false)
      if (end === 'sign-out' || end === '4001' || end === '401') await signInAs(s, 'm1')
      await s.auth.selectOrganization('o')
      const current = s.auth.session!.sync.channel('A')
      expect(current.timeline, end).toMatchObject({ pending: [] })
      expect(current.composer, end).toMatchObject({ draft: '', topicDraft: '' })
      expect(current.topic('T').composer.draft, end).toBe('')
      // Old adapters may not insert or erase the current Account Session's Topic intent.
      if (end !== 'settled' && end !== 'Channel access lost') {
        current.setTopicDraft('新しいトピック')
        current.topic('T').setDraft('新しい本文')
        old.setTopicDraft('古いトピック')
        oldComposer.setDraft('古い本文')
        await s.auth.selectOrganization('other')
        await s.auth.selectOrganization('o')
        expect(s.auth.session!.sync.channel('A').composer.topicDraft, end).toBe('新しいトピック')
        expect(s.auth.session!.sync.channel('A').topic('T').composer.draft, end).toBe('新しい本文')
      }
      await s.auth.signOut()
    }
  },
)

it('checks a direct-link Organization through the API even when it is absent from the Account membership list', async () => {
  vi.stubGlobal('window', { location: { href: '/o/unknown/c/channel' } })
  try {
    const s = stack({
      restore: vi.fn(async () => ({ screen: 'app' as const, identity: { ...identity('m1'), organizations: [] } })),
      getOrganization: vi.fn(async () => ({ ok: false as const, kind: 'http' as const, status: 404, error: 'organization_unavailable' })),
    })
    await s.auth.load()
    expect(s.deps.getOrganization).toHaveBeenCalledWith('unknown')
    expect(s.auth.organizationStatus).toBe('unavailable')
    expect(s.auth.session).toBeNull()
  } finally { vi.unstubAllGlobals() }
})

it('C10 Organization re-selection restores Topic state and its retained draft', async () => {
  const s = stack()
  await signInAs(s, 'm1')
  const net = await openChannelA(s)
  const original = s.auth.session!
  const topicMessage = { ...record(101), topic_id: 'T' }
  net.event({ type: 'message', message: topicMessage })
  net.topicMessages['A:T'] = ok({ messages: [topicMessage], has_more: false })
  await original.topics('A').loadTopic('T')
  original.sync.channel('A').topic('T').setDraft('Topic draft survives C10')
  net.socket.onClose(4003); await settle()
  expect(s.auth.organizationStatus).toBe('unavailable')
  expect(original.topics('A').state.unavailable).toBe(true)
  expect(await original.sync.channel('A').topic('T').submit('Topic T')).toBe(false)
  await s.auth.selectOrganization('o')
  const recoveredNet = s.nets.at(-1)!
  const olderTopicMessage = { ...record(99), topic_id: 'T' }
  recoveredNet.topicMessages['A:T'] = ok({ messages: [olderTopicMessage, topicMessage], has_more: false })
  recoveredNet.pages.A = ok({ messages: [record(100), topicMessage], has_more: false })
  recoveredNet.lists[0].resolve(ok({ channels: [channel('A')] }))
  await settle(); recoveredNet.subscribed('A', 101); await settle()
  const recovered = s.auth.session!
  await recovered.topics('A').loadTopic('T')
  expect(recovered).not.toBe(original)
  expect(s.auth.organizationStatus).toBe('ready')
  expect(recovered.topics('A').state.unavailable).toBe(false)
  expect(recovered.topics('A').state.topic('T').messages).toEqual([olderTopicMessage, topicMessage])
  expect(recovered.topics('A').state.topic('T')).toMatchObject({ initialized: true, loading: false, hasMore: false })
  expect(recovered.topics('A').state.lines.map(l => l.kind === 'message' ? l.message.seq : [l.topicId, l.position])).toEqual([100, ['T', 101]])
  expect(recovered.sync.channel('A').topic('T').composer.draft).toBe('Topic draft survives C10')
  recovered.close()
})

import { createAccountSecurity } from './account-security'
import type { Result } from './api'

it('account settings 403 preserves the live session, while 401 closes it and its drafts', async () => {
  const putPassword = vi.fn(async (): Promise<Result<undefined>> => ({ ok: false, kind: 'http', status: 403, error: 'current_password_incorrect' }))
  const s = stack({ openSecurity: ended => createAccountSecurity(ended, { putPassword, revokeOtherSessions: putPassword }) })
  await signInAs(s, 'owner')
  const session = s.auth.session
  const security = s.auth.security!
  await security.changePassword({ current_password: 'wrong password', new_password: 'new password' })
  expect(s.auth.view.screen).toBe('app')
  expect(s.auth.session).toBe(session)
  expect(s.closes[0]).not.toHaveBeenCalled()
  expect(security.state.error).toBe('incorrect')
  putPassword.mockResolvedValueOnce({ ok: false, kind: 'http', status: 401 })
  await security.revokeOthers({ current_password: 'current password' })
  expect(s.auth.view.screen).toBe('signin')
  expect(s.auth.security).toBeNull()
  expect(s.closes[0]).toHaveBeenCalledOnce()
})

it('an old account settings 401 cannot end a replacement Account session', async () => {
  let finish!: (result: Result<undefined>) => void
  const putPassword = vi.fn(() => new Promise<Result<undefined>>(resolve => { finish = resolve }))
  const s = stack({ openSecurity: ended => createAccountSecurity(ended, { putPassword, revokeOtherSessions: putPassword }) })
  await signInAs(s, 'owner')
  const pending = s.auth.security!.changePassword({ current_password: 'current password', new_password: 'new password' })
  await signInAs(s, 'replacement')
  const replacement = s.auth.session
  finish({ ok: false, kind: 'http', status: 401 })
  await pending
  expect(s.auth.view.screen).toBe('app')
  expect(s.auth.session).toBe(replacement)
  expect(s.closes[1]).not.toHaveBeenCalled()
})
