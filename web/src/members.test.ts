import { describe, expect, it, vi } from 'vitest'
import { canDeactivateMember, createMembers, roles } from './members'
import type { Identity, Member, MemberList, Result, Role } from './api'
import { rememberIdentityResponse } from './identity-order'
import { mentionText } from './mentions'

const member: Member = { id: 'm', name: 'メンバー', role: 'member' }
const identity: Identity = { member, organization: { organization_id: 'o', name: '組織', capabilities: { can_invite: { allowed: false }, can_deactivate_members: { allowed: false }, can_manage_roles: { allowed: false }, can_create_channels: { allowed: true } } } }
const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const token = 'a'.repeat(64)
const org = '00000000-0000-0000-0000-000000000001'

describe.each<{ actor: Role; capability: boolean; allowedTargets: Role[] }>([
  { actor: 'owner', capability: true, allowedTargets: ['owner', 'admin', 'member', 'guest'] },
  { actor: 'admin', capability: true, allowedTargets: ['admin', 'member', 'guest'] },
  { actor: 'member', capability: false, allowedTargets: [] },
  { actor: 'guest', capability: false, allowedTargets: [] },
])('deactivation as $actor', ({ actor, capability, allowedTargets }) => {
  const actorIdentity: Identity = {
    member: { ...member, role: actor },
    organization: {
      ...identity.organization,
      capabilities: { ...identity.organization.capabilities, can_deactivate_members: { allowed: capability } },
    },
  }

  it.each(roles)('checks deactivation of another %s', (role) => {
    expect(canDeactivateMember(actorIdentity, { ...member, id: 'other', role })).toBe(allowedTargets.includes(role))
  })

  it('denies self-deactivation', () => {
    expect(canDeactivateMember(actorIdentity, actorIdentity.member)).toBe(false)
  })
})

describe('Members controller', () => {
  it('preserves a newer Message Mention name through another Member Role change and deactivation', async () => {
    const target = { ...member, id: '123e4567-e89b-12d3-a456-426614174000', name: 'Old name' }
    const other = { ...member, id: 'other' }
    const deps = {
      listMembers: vi.fn(async () => ok({ members: [target, other] })),
      changeRole: vi.fn(async () => ok({ ...other, role: 'admin' as const })),
      deactivateMember: vi.fn(async () => ok(undefined)),
      createInvite: vi.fn(), baseUrl: () => 'https://chat.example/',
    }
    const c = createMembers(org, vi.fn(), vi.fn(), deps)
    try {
      await c.load()
      const mentions = [{ member_id: target.id, name: 'New name' }]
      rememberIdentityResponse(mentions)
      const rendered = () => mentionText(`@{member:${target.id}}`, mentions, c.authors.mentionName)
      expect(rendered()).toBe('@New name')
      expect(await c.role(other.id, 'admin')).toBe(true)
      expect(c.get().members.find(m => m.id === other.id)?.role).toBe('admin')
      expect.soft(rendered()).toBe('@New name')
      expect(await c.deactivate(other.id)).toBe(true)
      expect(c.get().members).toEqual([target])
      expect(rendered()).toBe('@New name')
    } finally { c.close() }
  })

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
  it('shows a specific Japanese message when invite_limit_reached is returned', async () => {
    const c = createMembers(org, vi.fn(), vi.fn(), {
      listMembers: vi.fn(),
      changeRole: vi.fn(),
      deactivateMember: vi.fn(),
      createInvite: vi.fn(async () => ({ ok: false as const, kind: 'http' as const, status: 409, error: 'invite_limit_reached' })),
      baseUrl: () => 'https://chat.example/',
    })
    try {
      await c.invite('invited@example.com', 'member')
      expect(c.get().inviteLink).toBe('')
      expect(c.get().error).toBe('有効な招待が上限に達しています。不要な招待を取り消してから、もう一度お試しください。')
      expect(c.get().busy).toBe(false)
    } finally { c.close() }
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
    expect(c.get().members).toEqual([])
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

it('held Member loads coalesce with reconciliation, replace author Maps and reject pre-invalidation responses', async () => {
  const { createActivity } = await import('./activity')
  vi.useFakeTimers()
  const finishes: ((result: Result<{ members: Member[] }>) => void)[] = []
  const listMembers = vi.fn(() => new Promise<Result<{ members: Member[] }>>(resolve => { finishes.push(resolve) }))
  const c = createMembers(org, vi.fn(), vi.fn(), {
    listMembers, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
  })
  const activity = createActivity({ watched: () => false })
  activity.hold('members', c.activityTarget)
  try {
    const first = c.load()
    finishes[0](ok({ members: [member] })); await first
    const initial = c.authors.get()
    expect(initial.get(member.id)?.name).toBe(member.name)
    const pending = c.load()
    activity.notice({ type: 'members_changed' })
    void c.load(); void c.load()
    expect(listMembers).toHaveBeenCalledTimes(2)
    expect(c.get().members).toEqual([])
    finishes[1](ok({ members: [{ ...member, name: 'stale' }] })); await pending
    expect(c.get().members).toEqual([])
    expect(c.authors.get()).toBe(initial)
    await vi.advanceTimersByTimeAsync(200)
    expect(listMembers).toHaveBeenCalledTimes(3)
    finishes[2](ok({ members: [] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(c.authors.get()).not.toBe(initial)
    expect(c.authors.get().has(member.id)).toBe(false)
  } finally { activity.close(); c.close(); vi.useRealTimers() }
})

it('retains or withholds Member directory rows by viewer Role while rejecting stale refetches', async () => {
  vi.useFakeTimers()
  try {
    for (const reason of ['periodic', 'reconcile', 'access'] as const) {
      for (const guest of [false, true]) {
        const self: Member = { id: 'self', name: '本人', role: guest ? 'guest' : 'member' }
        const initial = [self, member]
        const refreshed = [self]
        const displayed = guest ? [] : initial
        const context = `${reason}, guest=${guest}`
        let resolveStale!: (result: Result<MemberList>) => void
        const listMembers = vi.fn()
          .mockResolvedValueOnce(ok({ members: initial }))
          .mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve }))
          .mockResolvedValueOnce({ ok: false, kind: 'http', status: 503, retryAfterMs: 1000 })
          .mockResolvedValueOnce(ok({ members: refreshed }))
        const c = createMembers(org, vi.fn(), vi.fn(), {
          listMembers, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
        }, () => self.role)
        c.activityTarget.held()
        try {
          await c.load()
          expect(c.get().members).toEqual(initial)
          const stale = c.load()
          c.activityTarget.invalidate(reason)
          expect(c.get(), context).toMatchObject({ members: displayed, loading: guest })
          resolveStale(ok({ members: [self, { ...member, name: '古い名前' }] }))
          await stale
          expect(c.get().members, context).toEqual(displayed)
          await vi.advanceTimersByTimeAsync(200)
          expect(c.get(), context).toMatchObject({ members: [], loading: false, retryable: true })
          expect(c.get().error, context).not.toBe('')
          await vi.advanceTimersByTimeAsync(1000)
          expect(c.get(), context).toMatchObject({ members: refreshed, loading: false, error: '' })
        } finally { c.close() }
      }
    }
  } finally { vi.useRealTimers() }
})

it('held Member loads retain Membership loss and late 401 authority across invalidation and shutdown', async () => {
  const { createActivity } = await import('./activity')
  const finishes: ((result: Result<{ members: Member[] }>) => void)[] = []
  const ended = vi.fn(), unavailable = vi.fn(), lookupAuthors = vi.fn()
  const listMembers = vi.fn(() => new Promise<Result<{ members: Member[] }>>(resolve => { finishes.push(resolve) }))
  const c = createMembers(org, ended, unavailable, {
    listMembers, lookupAuthors, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
  })
  const activity = createActivity({ watched: () => false })
  activity.hold('members', c.activityTarget)
  const pending = c.load()
  activity.notice({ type: 'members_changed' })
  finishes[0]({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
  await pending
  expect(unavailable).toHaveBeenCalledOnce()
  await c.load(); c.authors.watch(['unknown']); c.authors.retry()
  await Promise.resolve()
  expect(listMembers).toHaveBeenCalledOnce(); expect(lookupAuthors).not.toHaveBeenCalled()
  activity.close(); c.close()

  const next = createMembers(org, ended, unavailable, {
    listMembers, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
  })
  const late = next.activityTarget.refresh()
  next.close()
  finishes[1]({ ok: false, kind: 'http', status: 401 }); await late
  await Promise.resolve()
  expect(ended).toHaveBeenCalledOnce()
})

it('ignores an older unscoped response after a newer Guest directory load completes', async () => {
  const finishes: ((result: Result<MemberList>) => void)[] = []
  const c = createMembers(org, vi.fn(), vi.fn(), {
    listMembers: () => new Promise(resolve => finishes.push(resolve)),
    lookupAuthors: vi.fn(), changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
  })
  const self: Member = { id: 'self', name: 'ゲスト', role: 'guest' }
  const older = c.load(), newer = c.load()
  finishes[1](ok({ members: [self] })); await newer
  finishes[0](ok({ members: [self, member] })); await older
  expect(c.get().members).toEqual([self])
  expect([...c.authors.get().keys()]).toEqual(['self'])
  c.close()
})

it('defers directory reads across activity invalidations until first activation, coalesces concurrent triggers and keeps Role revalidation', async () => {
  const { createActivity } = await import('./activity')
  vi.useFakeTimers()
  const finishes: ((result: Result<MemberList>) => void)[] = []
  const listMembers = vi.fn(() => new Promise<Result<MemberList>>(resolve => { finishes.push(resolve) }))
  let access: import('./members').MemberListAccess = 'member'
  const c = createMembers(org, vi.fn(), vi.fn(), {
    listMembers, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
  }, () => access)
  const activity = createActivity({ watched: () => false })
  activity.hold('members', c.activityTarget)
  try {
    // Before activation, every activity and access-refresh path is gated.
    activity.notice({ type: 'activity_ready' })
    activity.notice({ type: 'activity_reset' })
    activity.notice({ type: 'members_changed' })
    activity.notice({ type: 'channel_access_revoked', channel_id: 'c1' })
    activity.notice({ type: 'channel_access_gained', channel_id: 'c2' })
    void c.refreshIfActive()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(listMembers).not.toHaveBeenCalled()

    // Activation while Role is revalidating waits for confirmation instead of fetching unverified.
    access = 'revalidating'
    c.scheduleActivate()
    await vi.advanceTimersByTimeAsync(0)
    expect(listMembers).not.toHaveBeenCalled()

    // Confirming Role resumes the activated directory once and coalesces concurrent triggers.
    access = 'member'
    activity.invalidateMemberLists()
    await vi.advanceTimersByTimeAsync(200)
    expect(listMembers).toHaveBeenCalledTimes(1)
    c.activate()
    c.scheduleActivate()
    void c.load()
    void c.refreshIfActive()
    expect(listMembers).toHaveBeenCalledTimes(1)
    finishes[0](ok({ members: [member] }))
    await vi.advanceTimersByTimeAsync(200)
    expect(listMembers).toHaveBeenCalledTimes(2)
    finishes[1](ok({ members: [member] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(c.get().members).toEqual([member])
  } finally { activity.close(); c.close(); vi.useRealTimers() }
})

it('preserves error, empty and unavailable directory views after deferred activation', async () => {
  vi.useFakeTimers()
  const listMembers = vi.fn<typeof import('./api').listMembers>()
    .mockResolvedValueOnce({ ok: false, kind: 'http', status: 503, retryAfterMs: 1_000 })
    .mockResolvedValueOnce(ok({ members: [] }))
  const c = createMembers(org, vi.fn(), vi.fn(), {
    listMembers, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
  }, () => 'member')
  try {
    c.scheduleActivate()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.get()).toMatchObject({ members: [], loading: false, retryable: true })
    expect(c.get().error).not.toBe('')

    await c.retry()
    expect(c.get()).toMatchObject({ members: [], loading: false, error: '', retryable: false })

    c.unavailable()
    expect(c.get()).toMatchObject({ members: [], loading: false, error: '', retryable: false })
    c.activate(); c.scheduleActivate(); await c.load(); await c.retry()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(listMembers).toHaveBeenCalledTimes(2)
  } finally { c.close(); vi.useRealTimers() }
})
