import { describe, expect, it, vi } from 'vitest'
import { createAuthOperations } from './auth-operations'
import type { AuthState, signIn } from './auth'
import type { AccountIdentity, Identity, Result } from './api'
import { createInviteAcceptance } from './members'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const identity: AccountIdentity = { account: { id: 'matching', email: 'matching@example.invalid' }, organizations: [] }
const member: Identity = {
  member: { id: 'member', name: 'Member', role: 'member' },
  organization: { organization_id: 'org', name: 'Org', capabilities: {
    can_invite: { allowed: false }, can_manage_roles: { allowed: false },
    can_deactivate_members: { allowed: false }, can_create_channels: { allowed: true },
  } },
}
const input = { email: identity.account.email, name: 'Member', password: 'test-only password' }
const setup = { ...input, organization_name: 'Org', setup_token: 'test-only' }
const signedIn = { ok: true as const, data: { identity, expires_in: 100 } }
const rejected = { ok: false as const, kind: 'http' as const, status: 401 }

function fixture() {
  let generation = 0
  let view: AuthState = { screen: 'signin' }
  const deps = {
    restore: vi.fn(async (): Promise<AuthState> => ({ screen: 'signin' })),
    setupAndSignIn: vi.fn(async () => ({ state: { screen: 'app' as const, identity } })),
    signIn: vi.fn(async (): ReturnType<typeof signIn> => signedIn),
    signOut: vi.fn(async () => true),
  }
  const account = {
    generation: () => generation,
    selection: () => 0,
    loading: () => { view = { screen: 'loading' } },
    show: vi.fn(async (next: AuthState) => { view = next; generation++ }),
    ended: vi.fn((captured: number) => { if (captured === generation) { generation++; view = { screen: 'signin' } } }),
    accepted: vi.fn(async () => {}),
  }
  const ops = createAuthOperations(deps, account)
  const api = vi.fn(async (): Promise<Result<Identity>> => rejected)
  const invitation = createInviteAcceptance({ organizationId: 'org', token: 'a'.repeat(64) }, api)
  return { deps, account, ops, api, invitation, get view() { return view },
    replace() { generation++; view = { screen: 'app', identity: { ...identity, account: { id: 'new', email: 'new@example.invalid' } } } },
  }
}

describe('shared auth-operation guard', () => {
  it('serializes both operation orders, rejects double clicks and competing operations, then permits each action again', async () => {
    for (const first of ['sign-in', 'recovery'] as const) {
      const s = fixture()
      await s.ops.acceptInvitation(s.invitation, input)
      const login = deferred<typeof signedIn>()
      const logout = deferred<boolean>()
      s.deps.signIn.mockReturnValueOnce(login.promise)
      s.deps.signOut.mockReturnValueOnce(logout.promise)
      const pending = first === 'sign-in' ? s.ops.submitSignIn(input.email, input.password) : s.ops.signOutAndContinue(s.invitation)
      const before = s.invitation.get()
      expect(s.ops.get().busy).toBe(true)
      expect(await s.ops.submitSignIn(input.email, input.password)).toBe(false)
      expect(await s.ops.signOut()).toBe(false)
      expect(await s.ops.submitSetup(setup)).toBe(false)
      await s.ops.signOutAndContinue(s.invitation)
      await s.ops.acceptInvitation(s.invitation, input)
      await s.ops.load()
      expect(s.invitation.get()).toBe(before)
      expect(s.deps.signIn).toHaveBeenCalledTimes(first === 'sign-in' ? 1 : 0)
      expect(s.deps.signOut).toHaveBeenCalledTimes(first === 'recovery' ? 1 : 0)
      expect(s.deps.setupAndSignIn).not.toHaveBeenCalled()
      expect(s.deps.restore).not.toHaveBeenCalled()
      expect(s.api).toHaveBeenCalledOnce()
      expect(s.ops.get().busy).toBe(true)
      if (first === 'sign-in') login.resolve(signedIn)
      else logout.resolve(true)
      await pending
      expect(s.ops.get().busy).toBe(false)
      // No rejected intent is queued to run after the first operation.
      expect(s.deps.signIn).toHaveBeenCalledTimes(first === 'sign-in' ? 1 : 0)
      expect(s.deps.signOut).toHaveBeenCalledTimes(first === 'recovery' ? 1 : 0)
      if (first === 'sign-in') {
        const recovery = s.ops.signOutAndContinue(s.invitation)
        expect(s.deps.signOut).toHaveBeenCalledOnce()
        logout.resolve(true)
        await recovery
      } else {
        const signingIn = s.ops.submitSignIn(input.email, input.password)
        expect(s.deps.signIn).toHaveBeenCalledOnce()
        login.resolve(signedIn)
        expect(await signingIn).toBe(true)
      }
      expect(s.invitation.get().sessionRejected).toBe(false)
      s.api.mockResolvedValueOnce({ ok: true, data: member })
      await s.ops.acceptInvitation(s.invitation, input)
      expect(s.invitation.get().accepted).toBe(true)
      expect(s.account.accepted).toHaveBeenCalledOnce()
      expect(await s.ops.signOut()).toBe(true)
      expect(await s.ops.submitSignIn(input.email, input.password)).toBe(true)
      expect(await s.ops.submitSetup(setup)).toBe(true)
      await s.ops.load()
      expect(s.ops.get().busy).toBe(false)
    }
  })

  it('holds the same guard throughout Invite acceptance, including duplicate submits and session rejection', async () => {
    const s = fixture()
    const acceptance = deferred<Result<Identity>>()
    s.api.mockReturnValueOnce(acceptance.promise)
    const pending = s.ops.acceptInvitation(s.invitation, input)
    await s.ops.acceptInvitation(s.invitation, input)
    await s.ops.signOutAndContinue(s.invitation)
    expect(await s.ops.submitSignIn(input.email, input.password)).toBe(false)
    expect(await s.ops.signOut()).toBe(false)
    expect(s.api).toHaveBeenCalledOnce()
    expect(s.deps.signIn).not.toHaveBeenCalled()
    expect(s.deps.signOut).not.toHaveBeenCalled()
    acceptance.resolve(rejected)
    await pending
    expect(s.invitation.get()).toMatchObject({ sessionRejected: true, busy: false })
    expect(s.ops.get().busy).toBe(false)
    await s.ops.signOutAndContinue(s.invitation)
    expect(s.invitation.get().sessionRejected).toBe(false)
    expect(await s.ops.submitSignIn(input.email, input.password)).toBe(true)
  })

  it('fences stale auth and Invite completions after Account generation changes', async () => {
    for (const action of ['sign-in success', 'sign-in failure', 'sign-out success', 'sign-out failure', 'setup', 'restore', 'recovery success', 'recovery failure', 'Invite success', 'Invite 401', 'Invite 403'] as const) {
      const s = fixture()
      if (action.startsWith('recovery')) await s.ops.acceptInvitation(s.invitation, input)
      const gate = deferred<void>()
      let pending: Promise<unknown>
      if (action.startsWith('sign-in')) {
        s.deps.signIn.mockImplementationOnce(async () => { await gate.promise; return action.endsWith('success') ? signedIn : rejected })
        pending = s.ops.submitSignIn(input.email, input.password)
      } else if (action.startsWith('sign-out') || action.startsWith('recovery')) {
        s.deps.signOut.mockImplementationOnce(async () => { await gate.promise; return action.endsWith('success') })
        pending = action.startsWith('recovery') ? s.ops.signOutAndContinue(s.invitation) : s.ops.signOut()
      } else if (action === 'setup') {
        s.deps.setupAndSignIn.mockImplementationOnce(async () => { await gate.promise; return { state: { screen: 'app', identity } } })
        pending = s.ops.submitSetup(setup)
      } else if (action === 'restore') {
        s.deps.restore.mockImplementationOnce(async () => { await gate.promise; return { screen: 'signin' } })
        pending = s.ops.load()
      } else {
        s.api.mockImplementationOnce(async () => { await gate.promise; return action.endsWith('success') ? { ok: true, data: member } : { ...rejected, status: action.endsWith('401') ? 401 : 403 } })
        pending = s.ops.acceptInvitation(s.invitation, input)
      }
      const inviteState = { ...s.invitation.get(), busy: false }
      const ends = s.account.ended.mock.calls.length
      s.replace()
      const replacement = s.view
      gate.resolve()
      await pending
      expect(s.view).toBe(replacement)
      expect(s.account.show).not.toHaveBeenCalled()
      expect(s.account.accepted).not.toHaveBeenCalled()
      expect(s.account.ended).toHaveBeenCalledTimes(ends)
      expect(s.invitation.get()).toEqual(inviteState)
      expect(s.ops.get()).toEqual({ busy: false, error: '' })
      expect(await s.ops.submitSignIn(input.email, input.password)).toBe(true)
    }
  })

  it('releases the guard after a refused or throwing sign-in so recovery can be retried', async () => {
    const s = fixture()
    await s.ops.acceptInvitation(s.invitation, input)
    s.deps.signIn.mockResolvedValueOnce(rejected)
    expect(await s.ops.submitSignIn(input.email, input.password)).toBe(false)
    expect(s.ops.get().busy).toBe(false)
    s.deps.signIn.mockRejectedValueOnce(new Error('test-only failure'))
    await expect(s.ops.submitSignIn(input.email, input.password)).rejects.toThrow('test-only failure')
    expect(s.ops.get().busy).toBe(false)
    s.deps.signOut.mockResolvedValueOnce(false)
    await s.ops.signOutAndContinue(s.invitation)
    expect(s.invitation.get().error).toContain('ログアウトできませんでした')
    expect(s.ops.get().busy).toBe(false)
    await s.ops.signOutAndContinue(s.invitation)
    expect(s.invitation.get()).toMatchObject({ sessionRejected: false, error: '', busy: false })
  })

  it('a superseded Organization read cannot release a newer cookie mutation guard', async () => {
    const s = fixture()
    const lookup = deferred<void>()
    s.account.show.mockImplementationOnce(async () => { await lookup.promise })
    const signingIn = s.ops.submitSignIn(input.email, input.password)
    await vi.waitFor(() => expect(s.account.show).toHaveBeenCalledOnce())
    expect(s.ops.get().busy).toBe(false)
    const logout = deferred<boolean>()
    s.deps.signOut.mockReturnValueOnce(logout.promise)
    const signingOut = s.ops.signOut()
    expect(s.ops.get().busy).toBe(true)
    lookup.resolve()
    await signingIn
    expect(s.ops.get().busy).toBe(true)
    expect(await s.ops.submitSignIn(input.email, input.password)).toBe(false)
    logout.resolve(true)
    expect(await signingOut).toBe(true)
    expect(s.ops.get().busy).toBe(false)
  })

  it.each(['setup', 'sign-out', 'recovery', 'Invite', 'show', 'accepted', 'restore'] as const)('does not leave auth busy after a throwing %s', async action => {
    const s = fixture()
    const error = new Error('test-only failure')
    let pending: Promise<unknown>
    if (action === 'setup') {
      s.deps.setupAndSignIn.mockRejectedValueOnce(error)
      pending = s.ops.submitSetup(setup)
    } else if (action === 'sign-out' || action === 'recovery') {
      if (action === 'recovery') await s.ops.acceptInvitation(s.invitation, input)
      s.deps.signOut.mockRejectedValueOnce(error)
      pending = action === 'sign-out' ? s.ops.signOut() : s.ops.signOutAndContinue(s.invitation)
    } else if (action === 'Invite' || action === 'accepted') {
      if (action === 'Invite') s.api.mockRejectedValueOnce(error)
      else {
        s.api.mockResolvedValueOnce({ ok: true, data: member })
        s.account.accepted.mockRejectedValueOnce(error)
      }
      pending = s.ops.acceptInvitation(s.invitation, input)
    } else if (action === 'show') {
      s.account.show.mockRejectedValueOnce(error)
      pending = s.ops.submitSignIn(input.email, input.password)
    } else {
      s.deps.restore.mockRejectedValueOnce(error)
      pending = s.ops.load()
    }
    await expect(pending).rejects.toThrow('test-only failure')
    expect(s.ops.get().busy).toBe(false)
    expect(await s.ops.signOut()).toBe(true)
  })
})
