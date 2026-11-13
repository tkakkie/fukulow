import { describe, expect, it, vi } from 'vitest'
import { createMembers, createInviteAcceptance, takeInvite } from './members'
import type { Identity, Member, Result } from './api'

const member: Member = { id: 'm', name: 'メンバー', role: 'member' }
const identity: Identity = { member, organization: { organization_id: 'o', name: '組織', capabilities: { can_invite: { allowed: false }, can_deactivate_members: { allowed: false }, can_manage_roles: { allowed: false }, can_create_channels: { allowed: true } } } }
const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const token = 'a'.repeat(64)
const org = '00000000-0000-0000-0000-000000000001'

describe('Members controller', () => {
  it('lists Members, updates Roles, and creates a fragment-only Invite link through the API', async () => {
    const deps = {
      listMembers: vi.fn(async () => ok({ members: [member] })),
      changeRole: vi.fn(async () => ok({ ...member, role: 'admin' as const })),
      deactivateMember: vi.fn(),
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
      deactivateMember: vi.fn(),
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
      deactivateMember: vi.fn(),
      createInvite: () => new Promise(r => { finish = r }), baseUrl: () => 'https://chat.example/',
    })
    const pending = c.invite('a@example.com', 'member'); c.close()
    finish({ ok: false, kind: 'http', status: 401 }); await pending
    expect(ended).toHaveBeenCalledOnce(); expect(unavailable).not.toHaveBeenCalled()
    expect(c.get().inviteLink).toBe('')
  })
  it('reports Membership loss from an overlapping load and stops Member and author requests', async () => {
    const finishes: ((result: Result<{ members: Member[] }>) => void)[] = []
    const listMembers = vi.fn(() => new Promise<Result<{ members: Member[] }>>(resolve => { finishes.push(resolve) }))
    const lookupAuthors = vi.fn(async () => ok({ identities: [] }))
    const ended = vi.fn(), unavailable = vi.fn()
    const c = createMembers(org, ended, unavailable, {
      listMembers, lookupAuthors, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    })
    const older = c.load(), newer = c.load()
    finishes[1](ok({ members: [member] })); await newer
    const late = c.load()
    finishes[0]({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' }); await older
    expect(unavailable).toHaveBeenCalledOnce()
    await c.load()
    c.authors.watch(['unknown']); c.authors.retry(); c.authors.replaceMembers([])
    await Promise.resolve()
    expect(listMembers).toHaveBeenCalledTimes(3)
    expect(lookupAuthors).not.toHaveBeenCalled()
    expect(c.get().members).toEqual([member])
    expect(c.authors.get().get(member.id)?.name).toBe(member.name)
    finishes[2]({ ok: false, kind: 'http', status: 401 }); await late
    expect(ended).toHaveBeenCalledOnce()
  })

  it('ignores Member-list Membership loss from a previous Organization selection', async () => {
    let finish!: (result: Result<{ members: Member[] }>) => void
    const unavailable = vi.fn()
    const deps = {
      listMembers: vi.fn(() => new Promise<Result<{ members: Member[] }>>(resolve => { finish = resolve })),
      changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    }
    const previous = createMembers(org, vi.fn(), unavailable, deps)
    const pending = previous.load()
    const old = finish
    previous.close()
    const current = createMembers(org, vi.fn(), unavailable, deps)
    old({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' }); await pending
    expect(unavailable).not.toHaveBeenCalled()
    const fresh = current.load()
    finish(ok({ members: [member] })); await fresh
    expect(current.get().members).toEqual([member])
    current.close()
  })
  it('explains last-Channel-manager Role denial in Japanese and preserves the Member', async () => {
    const c = createMembers(org, vi.fn(), vi.fn(), {
      listMembers: async () => ok({ members: [member] }),
      changeRole: async () => ({ ok: false, kind: 'http', status: 409, error: 'last_channel_manager' }),
      deactivateMember: vi.fn(),
      createInvite: vi.fn(), baseUrl: () => '',
    })
    await c.load()
    expect(await c.role('m', 'guest')).toBe(false)
    expect(c.get().members).toEqual([member])
    expect(c.get().error).toBe('チャンネルの管理者がいなくなるため、ロールを変更できません。先に別のオーナーまたは管理者を追加してください。')
    expect(c.get().busy).toBe(false)
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

it('deactivates through the API, preserves denied targets, and fences late results and duplicate submits', async () => {
  let finish!: (r: Result<undefined>) => void
  const api = vi.fn(() => new Promise<Result<undefined>>(r => { finish = r }))
  const ended = vi.fn(), unavailable = vi.fn()
  const c = createMembers(org, ended, unavailable, {
    listMembers: async () => ok({ members: [member] }), changeRole: vi.fn(), createInvite: vi.fn(), baseUrl: () => '', deactivateMember: api,
  })
  await c.load()
  for (const error of ['last_channel_manager', 'last_owner', 'member_not_found', 'forbidden']) {
    const pending = c.deactivate(member.id)
    expect(await c.deactivate(member.id)).toBe(false)
    finish({ ok: false, kind: 'http', status: error === 'forbidden' ? 403 : 409, error })
    expect(await pending).toBe(false)
    expect(c.get().members).toEqual([member])
    expect(c.get().error).not.toContain(error)
  }
  const pending = c.deactivate(member.id)
  finish(ok(undefined)); expect(await pending).toBe(true)
  expect(c.get().members).toEqual([])
  expect(api).toHaveBeenLastCalledWith(org, member.id)
  const late = c.deactivate(member.id); c.close()
  finish({ ok: false, kind: 'http', status: 401 })
  expect(await late).toBe(false); expect(ended).toHaveBeenCalledOnce()
  expect(unavailable).not.toHaveBeenCalled()
})
