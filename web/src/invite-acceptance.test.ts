import { expect, it, vi } from 'vitest'
import type { Identity, Member, Result } from './api'
import { signOut } from './auth'
import { createInviteAcceptance, takeInvite } from './invite-acceptance'

const member: Member = { id: 'm', name: 'メンバー', role: 'member' }
const identity: Identity = { member, organization: { organization_id: 'o', name: '組織', capabilities: { can_invite: { allowed: false }, can_deactivate_members: { allowed: false }, can_manage_roles: { allowed: false }, can_create_channels: { allowed: true } } } }
const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const token = 'a'.repeat(64)
const org = '00000000-0000-0000-0000-000000000001'

it('takes an Invite from the URL fragment and removes it from browser history immediately', () => {
  const replace = vi.fn()
  expect(takeInvite(new URL(`https://chat.example/#invite=${org}:${token}`), replace)).toEqual({ organizationId: org, token })
  expect(replace).toHaveBeenCalledWith('/')
  expect(takeInvite(new URL('https://chat.example/#invite=malformed'), replace)).toBeNull()
})

it('acceptance uses the API, keeps failed invitations retryable, and consumes successful ones in memory', async () => {
  const api = vi.fn().mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'invite_sign_in_required' }).mockResolvedValueOnce(ok(identity))
  const c = createInviteAcceptance({ organizationId: org, token }, api)
  const input = { email: 'a@example.com', name: '名前', password: null }
  expect(await c.accept(input)).toBeNull(); expect(c.get().available).toBe(true)
  expect(c.get().error).toContain('ログイン')
  expect(await c.accept(input)).toEqual(identity)
  expect(api).toHaveBeenLastCalledWith(org, { ...input, token })
  expect(c.get().accepted).toBe(true); expect(c.get().available).toBe(false)
  expect(await c.accept(input)).toBeNull(); expect(api).toHaveBeenCalledTimes(2)
})

it.each([204, 401])('Invite session recovery waits for explicit sign-out %i and a manual resubmit with the same Invite', async (status) => {
  const api = vi.fn().mockResolvedValueOnce({ ok: false, kind: 'http', status: 401 }).mockResolvedValueOnce(ok(identity))
  const c = createInviteAcceptance({ organizationId: org, token }, api)
  const ended = vi.fn()
  const input = { email: 'new@example.com', name: '名前', password: 'new account password' }
  let finish!: (r: Response) => void
  const transport = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
  const logout = () => signOut(transport)
  await c.signOutAndContinue(logout)
  expect(transport).not.toHaveBeenCalled()
  await c.accept(input, ended)
  expect(ended).toHaveBeenCalledOnce()
  expect(c.get()).toMatchObject({ sessionRejected: true, available: true, accepted: false })
  expect(transport).not.toHaveBeenCalled()
  const pending = c.signOutAndContinue(logout)
  expect(c.get().sessionRejected).toBe(true)
  expect(c.get().busy).toBe(true)
  await c.signOutAndContinue(logout)
  await c.accept(input)
  expect(transport).toHaveBeenCalledOnce()
  expect(api).toHaveBeenCalledOnce()
  finish(new Response(null, { status }))
  await pending
  expect(c.get()).toMatchObject({ sessionRejected: false, available: true, accepted: false, busy: false, error: '' })
  expect(api).toHaveBeenCalledOnce()
  await c.accept(input)
  expect(api).toHaveBeenLastCalledWith(org, { ...input, token })
  expect(c.get().accepted).toBe(true)
})

it('a rejected sign-out clears Invite busy, shows one actionable error, and permits recovery and manual acceptance', async () => {
  const api = vi.fn().mockResolvedValueOnce({ ok: false, kind: 'http', status: 401 }).mockResolvedValueOnce(ok(identity))
  const c = createInviteAcceptance({ organizationId: org, token }, api)
  const input = { email: 'new@example.com', name: '名前', password: 'new account password' }
  await c.accept(input)
  const logout = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(true)
  const pending = c.signOutAndContinue(logout)
  expect(c.get().busy).toBe(true)
  expect(await pending).toBe(false)
  expect(c.get()).toEqual({
    sessionRejected: true, available: true, accepted: false, busy: false,
    error: 'ログアウトできませんでした。通信状況を確認して、もう一度お試しください。',
  })
  expect(api).toHaveBeenCalledOnce()
  expect(await c.signOutAndContinue(logout)).toBe(true)
  expect(logout).toHaveBeenCalledTimes(2)
  expect(c.get()).toMatchObject({ busy: false, sessionRejected: false, available: true, error: '' })
  expect(api).toHaveBeenCalledOnce()
  expect(await c.accept(input)).toEqual(identity)
  expect(api).toHaveBeenLastCalledWith(org, { ...input, token })
  expect(c.get()).toMatchObject({ busy: false, available: false, accepted: true, error: '' })
})

it('a rejected acceptance clears Invite busy, shows the network error, and permits a later click with the same Invite', async () => {
  const api = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ok(identity))
  const c = createInviteAcceptance({ organizationId: org, token }, api)
  const ended = vi.fn()
  const input = { email: 'new@example.com', name: '名前', password: 'new account password' }
  const pending = c.accept(input, ended)
  expect(c.get().busy).toBe(true)
  expect(await pending).toBeNull()
  expect(c.get()).toEqual({
    sessionRejected: false, available: true, accepted: false, busy: false,
    error: 'サーバーに接続できません。もう一度お試しください。',
  })
  expect(ended).not.toHaveBeenCalled()
  expect(await c.accept(input, ended)).toEqual(identity)
  expect(api).toHaveBeenCalledTimes(2)
  expect(api).toHaveBeenLastCalledWith(org, { ...input, token })
  expect(c.get()).toMatchObject({ busy: false, available: false, accepted: true, error: '' })
})

it.each(['network', 500, 503])('Invite session recovery keeps the Invite and an actionable error after sign-out %s', async (failure) => {
  const api = vi.fn().mockResolvedValue({ ok: false, kind: 'http', status: 401 })
  const c = createInviteAcceptance({ organizationId: org, token }, api)
  await c.accept({ email: 'new@example.com', name: '名前', password: 'new account password' })
  const transport = failure === 'network'
    ? vi.fn().mockRejectedValue(new Error('offline'))
    : vi.fn().mockResolvedValue(new Response(null, { status: failure as number }))
  await c.signOutAndContinue(() => signOut(transport))
  expect(c.get()).toMatchObject({ sessionRejected: true, available: true, accepted: false, busy: false })
  expect(c.get().error).toContain('ログアウトできませんでした')
  expect(api).toHaveBeenCalledOnce()
  await c.signOutAndContinue(async () => true)
  expect(c.get()).toMatchObject({ sessionRejected: false, available: true, error: '' })
  expect(api).toHaveBeenCalledOnce()
})

it.each([
  { ok: false as const, kind: 'network' as const },
  ...[400, 403, 404, 409, 429].map(status => ({ ok: false as const, kind: 'http' as const, status, error: status === 409 ? 'invite_sign_in_required' : 'invite_unavailable' })),
  ok(identity),
])('unrelated Invite errors and valid acceptance never enable or trigger sign-out: %j', async result => {
  const c = createInviteAcceptance({ organizationId: org, token }, vi.fn(async () => result))
  const logout = vi.fn(async () => true), ended = vi.fn()
  await c.accept({ email: 'a@example.com', name: '名前', password: null }, ended)
  expect(c.get().sessionRejected).toBe(false)
  expect(ended).not.toHaveBeenCalled()
  await c.signOutAndContinue(logout)
  expect(logout).not.toHaveBeenCalled()
})
