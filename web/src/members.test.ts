import { describe, expect, it, vi } from 'vitest'
import { createMembers, createInviteAcceptance, takeInvite } from './members'
import type { Identity, Member, Result } from './api'

const member: Member = { id: 'm', name: 'メンバー', role: 'member' }
const identity: Identity = { member, organization: { organization_id: 'o', name: '組織', capabilities: { can_invite: { allowed: false }, can_manage_roles: { allowed: false }, can_create_channels: { allowed: true } } } }
const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const token = 'a'.repeat(64)
const org = '00000000-0000-0000-0000-000000000001'

describe('Members controller', () => {
  it('lists Members, updates Roles, and creates a fragment-only Invite link through the API', async () => {
    const deps = {
      listMembers: vi.fn(async () => ok({ members: [member] })),
      changeRole: vi.fn(async () => ok({ ...member, role: 'admin' as const })),
      createInvite: vi.fn(async () => ok({ id: 'i', organization_id: org, token, expires_at: 'later' })),
      baseUrl: () => 'https://chat.example/',
    }
    const c = createMembers(org, vi.fn(), vi.fn(), deps)
    await c.load(); expect(c.get().members).toEqual([member])
    await c.role('m', 'admin'); expect(c.get().members[0].role).toBe('admin')
    await c.invite('invited@example.com', 'guest')
    expect(deps.createInvite).toHaveBeenCalledWith(org, { email: 'invited@example.com', role: 'guest' })
    const url = new URL(c.get().inviteLink)
    expect(url.search).toBe(''); expect(url.pathname).toBe('/')
    expect(url.hash).toBe(`#invite=${org}:${token}`)
    c.close(); expect(c.get().inviteLink).toBe('')
  })
  it('does not change a Member after denial and shows last-Owner protection', async () => {
    const c = createMembers(org, vi.fn(), vi.fn(), {
      listMembers: async () => ok({ members: [member] }),
      changeRole: async () => ({ ok: false, kind: 'http', status: 409, error: 'last_owner' }),
      createInvite: vi.fn(), baseUrl: () => '',
    })
    await c.load(); expect(await c.role('m', 'guest')).toBe(false)
    expect(c.get().members).toEqual([member]); expect(c.get().error).toContain('最後のオーナー')
  })
  it('fences a late Invite after close, while a same-Account late 401 still ends its Session', async () => {
    let finish!: (r: Result<import('./api').InviteResponse>) => void
    const ended = vi.fn(), unavailable = vi.fn()
    const c = createMembers(org, ended, unavailable, {
      listMembers: vi.fn(), changeRole: vi.fn(),
      createInvite: () => new Promise(r => { finish = r }), baseUrl: () => 'https://chat.example/',
    })
    const pending = c.invite('a@example.com', 'member'); c.close()
    finish({ ok: false, kind: 'http', status: 401 }); await pending
    expect(ended).toHaveBeenCalledOnce(); expect(unavailable).not.toHaveBeenCalled()
    expect(c.get().inviteLink).toBe('')
  })
})

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
