import { describe, expect, it, vi } from 'vitest'
import { createInvites } from './invites'
import { listInvites, revokeInvite, type InvitePage, type OutstandingInvite, type Result } from './api'

const row = (n: number): OutstandingInvite => ({ id: `${n}`, email: `${n}@example.invalid`, role: 'member', created_by: 'issuer', expires_at: '2027-01-01T00:00:00Z' })
const ok = <T>(data: T): Result<T> => ({ ok: true, data })

async function stalledRevoke(late: Result<undefined>) {
  vi.useFakeTimers()
  try {
    let finish!: (r: Result<undefined>) => void
    let refresh!: (r: Result<InvitePage>) => void
    const revoke = vi.fn(() => new Promise<Result<undefined>>(resolve => { finish = resolve }))
    const list = vi.fn().mockResolvedValueOnce(ok({ invites: [row(1)] }))
      .mockImplementationOnce(() => new Promise<Result<InvitePage>>(resolve => { refresh = resolve }))
    const ended = vi.fn(), unavailable = vi.fn()
    const c = createInvites('org', ended, unavailable, { listInvites: list, revokeInvite: revoke })
    await c.load()
    const pending = c.revoke('1')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(c.get().busy).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    // Resolving false also lets the confirmation dialog's completion handler close it.
    expect(await pending).toBe(false)
    expect(c.get().busy).toBe(false)
    expect(c.get().invites).toEqual([row(1)])
    expect(c.get().retryable).toBe(false)
    expect(c.get().error).toBe('招待の取消を確認できませんでした。一覧を更新して確認してください。')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(revoke).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledOnce()
    // A late failure arrives before refresh; a late success races the new read.
    const refreshing = late.ok ? c.load() : undefined
    const before = c.get()
    finish(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(c.get()).toEqual(before)
    expect(ended).not.toHaveBeenCalled(); expect(unavailable).not.toHaveBeenCalled()
    const reconciliation = refreshing ?? c.load()
    refresh(ok({ invites: late.ok ? [] : [row(1)] }))
    await reconciliation
    expect(c.get().invites).toEqual(late.ok ? [] : [row(1)])
    expect(c.get().loading).toBe(false); expect(c.get().error).toBe('')
    expect(list).toHaveBeenCalledTimes(2); expect(revoke).toHaveBeenCalledOnce()
    c.close()
  } finally { vi.useRealTimers() }
}

describe('Invite management', () => {
  it('bounds stalled revocation and fences late success while refresh reconciles', async () => {
    await stalledRevoke(ok(undefined))
  })

  it('bounds stalled revocation and fences late failure while refresh reconciles', async () => {
    await stalledRevoke({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
  })

  it('ends the Account Session on a stalled revocation late 401 without changing Invite state', async () => {
    vi.useFakeTimers()
    try {
      let finish!: (r: Result<undefined>) => void
      const revoke = vi.fn(() => new Promise<Result<undefined>>(resolve => { finish = resolve }))
      const ended = vi.fn(), unavailable = vi.fn()
      const c = createInvites('org', ended, unavailable, {
        listInvites: async () => ok({ invites: [row(1)], next_cursor: 'opaque' }), revokeInvite: revoke,
      })
      await c.load()
      const pending = c.revoke('1')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toBe(false)
      expect(c.get().busy).toBe(false)
      expect(c.get().invites).toEqual([row(1)])
      expect(ended).not.toHaveBeenCalled()
      const before = c.get()
      const changed = vi.fn()
      const unsubscribe = c.subscribe(changed)
      finish({ ok: false, kind: 'http', status: 401 })
      await vi.advanceTimersByTimeAsync(0)
      expect(ended).toHaveBeenCalledOnce()
      expect(unavailable).not.toHaveBeenCalled()
      expect(c.get()).toEqual(before)
      expect(changed).not.toHaveBeenCalled()
      expect(revoke).toHaveBeenCalledOnce()
      unsubscribe()
      c.close()
    } finally { vi.useRealTimers() }
  })

  it('loads all 250 Invites across pages and revokes an Invite on the last page', async () => {
    const list = vi.fn(async (_org: string, cursor?: string): Promise<Result<InvitePage>> => {
      const start = Number(cursor ?? 0), end = Math.min(250, start + 100)
      return ok({ invites: Array.from({ length: end - start }, (_, n) => row(start + n)), ...(end < 250 ? { next_cursor: `${end}` } : {}) })
    })
    const revoke = vi.fn(async () => ok(undefined))
    const c = createInvites('org', vi.fn(), vi.fn(), { listInvites: list, revokeInvite: revoke })
    await c.load(); expect(c.get().invites).toHaveLength(100)
    await c.more(); expect(c.get().invites).toHaveLength(200)
    await c.more(); expect(c.get().invites).toHaveLength(250)
    expect(c.get().invites.map(i => i.id)).toEqual(Array.from({ length: 250 }, (_, n) => `${n}`))
    expect(c.get().nextCursor).toBeUndefined()
    await c.more(); expect(list).toHaveBeenCalledTimes(3)
    expect(await c.revoke('249')).toBe(true)
    expect(revoke).toHaveBeenCalledWith('org', '249')
    expect(c.get().invites).toHaveLength(249)
    c.close()
  })

  it('preserves pages on failure and retries the same continuation; refresh resets the cursor', async () => {
    const list = vi.fn().mockResolvedValueOnce(ok({ invites: [row(1)], next_cursor: 'opaque' }))
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce(ok({ invites: [row(2)] }))
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce(ok({ invites: [row(3)] }))
    const c = createInvites('org', vi.fn(), vi.fn(), { listInvites: list, revokeInvite: vi.fn() })
    await c.load(); await c.more()
    expect(c.get().invites).toEqual([row(1)]); expect(c.get().retryable).toBe(true)
    await c.retry(); expect(list.mock.calls[2][1]).toBe('opaque')
    expect(c.get().invites).toEqual([row(1), row(2)])
    await c.load(); expect(list.mock.calls[3][1]).toBeUndefined()
    expect(c.get().invites).toEqual([row(1), row(2)])
    expect(c.get().retryable).toBe(true)
    await c.retry(); expect(list.mock.calls[4][1]).toBeUndefined()
    expect(c.get().invites).toEqual([row(3)])
    c.close()
  })

  it('preserves a refused Invite and guards duplicate revocation submissions', async () => {
    let finish!: (r: Result<undefined>) => void
    const revoke = vi.fn(() => new Promise<Result<undefined>>(resolve => { finish = resolve }))
    const c = createInvites('org', vi.fn(), vi.fn(), { listInvites: async () => ok({ invites: [row(1)] }), revokeInvite: revoke })
    await c.load()
    const first = c.revoke('1'); await c.revoke('1'); await c.more()
    expect(revoke).toHaveBeenCalledOnce(); expect(c.get().busy).toBe(true)
    finish({ ok: false, kind: 'http', status: 404, error: 'invite_unavailable' }); expect(await first).toBe(false)
    expect(c.get().invites).toEqual([row(1)]); expect(c.get().error).toContain('一覧を更新')
    c.close()
  })

  it('fences superseded and closed reads while retaining same-Account late 401 handling', async () => {
    const finishes: ((r: Result<InvitePage>) => void)[] = []
    const ended = vi.fn(), unavailable = vi.fn()
    const list = vi.fn(() => new Promise<Result<InvitePage>>(resolve => finishes.push(resolve)))
    const c = createInvites('org', ended, unavailable, { listInvites: list, revokeInvite: vi.fn() })
    const old = c.load(), fresh = c.load()
    finishes[1](ok({ invites: [row(2)] })); await fresh
    finishes[0](ok({ invites: [row(1)] })); await old
    expect(c.get().invites).toEqual([row(2)])
    const late = c.load(); c.close()
    finishes[2]({ ok: false, kind: 'http', status: 401 }); await late
    expect(ended).toHaveBeenCalledOnce(); expect(unavailable).not.toHaveBeenCalled()
    expect(c.get().invites).toEqual([])
    await c.load(); expect(list).toHaveBeenCalledTimes(3)
  })

  it('clears protected data on permission loss and stops on Organization loss', async () => {
    const unavailable = vi.fn()
    const list = vi.fn().mockResolvedValueOnce(ok({ invites: [row(1)], next_cursor: 'cursor' }))
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 403 })
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
    const c = createInvites('org', vi.fn(), unavailable, { listInvites: list, revokeInvite: vi.fn() })
    await c.load(); await c.more()
    expect(c.get().invites).toEqual([]); expect(c.get().nextCursor).toBeUndefined()
    expect(c.get().retryable).toBe(false); expect(c.get().forbidden).toBe(true)
    await c.load(); expect(unavailable).toHaveBeenCalledOnce()
    await c.load(); expect(list).toHaveBeenCalledTimes(3)
  })

  it('turns a stalled page into a retryable error after ten seconds and ignores its late data', async () => {
    vi.useFakeTimers()
    try {
      let finish!: (r: Result<InvitePage>) => void
      const list = vi.fn(() => new Promise<Result<InvitePage>>(resolve => { finish = resolve }))
      const c = createInvites('org', vi.fn(), vi.fn(), { listInvites: list, revokeInvite: vi.fn() })
      const pending = c.load()
      await vi.advanceTimersByTimeAsync(10_000); await pending
      expect(c.get().loading).toBe(false); expect(c.get().retryable).toBe(true)
      finish(ok({ invites: [row(1)] })); await Promise.resolve()
      expect(c.get().invites).toEqual([])
      c.close()
    } finally { vi.useRealTimers() }
  })
})

it('uses scoped no-store GET with an opaque cursor and bodyless DELETE accepting only 204', async () => {
  const transport = vi.fn(async () => new Response(JSON.stringify({ invites: [] }), { status: 200 }))
  expect(await listInvites('org/1', 'opaque?value', transport)).toEqual(ok({ invites: [] }))
  expect(transport.mock.calls[0]).toEqual(['/api/v1/orgs/org%2F1/invites?cursor=opaque%3Fvalue', { credentials: 'same-origin', cache: 'no-store' }])
  const remove = vi.fn(async () => new Response(null, { status: 204 }))
  expect(await revokeInvite('org/1', 'id/2', remove)).toEqual(ok(undefined))
  expect(remove.mock.calls[0]).toEqual(['/api/v1/orgs/org%2F1/invites/id%2F2', { credentials: 'same-origin', method: 'DELETE' }])
  expect(await revokeInvite('org', 'id', async () => new Response(null, { status: 200 }))).toEqual({ ok: false, kind: 'network' })
})
