import { describe, expect, it, vi } from 'vitest'
import { createAuthors, senderName } from './authors'
import { createMembers } from './members'
import type { DisplayIdentity, Member, Result } from './api'

const identity = (id: string, deactivated = false): DisplayIdentity => ({ id, name: `名前${id}`, deactivated })
const member = (id: string): Member => ({ id, name: `名前${id}`, role: 'member' })
const ok = (identities: DisplayIdentity[]): Result<{ identities: DisplayIdentity[] }> => ({ ok: true, data: { identities } })
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('author identities', () => {
  it('uses one Map per Member list change and batches new and deactivated authors with duplicates collapsed', async () => {
    const lookup = vi.fn(async () => ok([identity('new'), identity('old', true)]))
    const c = createAuthors('org', vi.fn(), vi.fn(), lookup)
    c.replaceMembers([member('known')])
    const initial = c.get()
    c.watch(['known', 'new', 'old', 'new', 'old'])
    c.watch(['known', 'new', 'old', 'new'])
    expect(c.get()).toBe(initial)
    await settle()
    expect(lookup).toHaveBeenCalledExactlyOnceWith('org', { ids: ['new', 'old'] })
    expect(senderName(c.get().get('new'))).toBe('名前new')
    expect(c.get().get('old')).toEqual(identity('old', true))
    expect(senderName(c.get().get('old'))).toBe('名前old（無効）')
    expect(senderName(undefined)).toBe('メンバー')
    const resolved = c.get()
    c.watch(['known', 'new', 'old'])
    await settle()
    expect(c.get()).toBe(resolved)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('exposes queued and in-flight pending state, notifies on failure, and fences superseded settlement', async () => {
    const finishes: ((result: ReturnType<typeof ok>) => void)[] = []
    const lookup = vi.fn(() => new Promise<ReturnType<typeof ok>>(resolve => { finishes.push(resolve) }))
    const c = createAuthors('org', vi.fn(), vi.fn(), lookup)
    c.replaceMembers([member('known')])
    expect(c.isPending('known')).toBe(false)
    expect(c.isPending('a')).toBe(true)
    c.watch(['a'])
    expect(c.isPending('a')).toBe(true)
    await settle()
    expect(c.isPending('a')).toBe(true)
    c.retry(); await settle()
    finishes[0](ok([identity('a')]))
    await settle()
    expect(c.isPending('a')).toBe(true)
    expect(c.get().has('a')).toBe(false)
    const notify = vi.fn()
    c.subscribe(notify)
    finishes[1]({ ok: false, kind: 'network' })
    await settle()
    expect(c.isPending('a')).toBe(false)
    expect(notify).toHaveBeenCalledOnce()
    c.retry()
    expect(c.isPending('a')).toBe(true)
    await settle()
    finishes[2](ok([]))
    await settle()
    expect(c.isPending('a')).toBe(false)
    c.unavailable()
    expect(c.isPending('new')).toBe(false)
    c.close()
  })

  it('rebuilds cached active and deactivated identities only on a Member list load', async () => {
    const lookup = vi.fn(async () => ok([identity('a', true)]))
    const c = createAuthors('org', vi.fn(), vi.fn(), lookup)
    c.replaceMembers([member('a')]); c.watch(['a']); await settle()
    expect(senderName(c.get().get('a'))).toBe('名前a')
    // Server changes are deliberately invisible until the next directory load.
    c.watch(['a']); c.retry(); await settle()
    expect(lookup).not.toHaveBeenCalled()
    c.replaceMembers([]); await settle()
    expect(c.get().get('a')?.deactivated).toBe(true)
    c.replaceMembers([member('a')]); await settle()
    expect(c.get().get('a')?.deactivated).toBe(false)
    expect(senderName(c.get().get('a'))).toBe('名前a')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('retries omitted ids and network failures only on list load, Channel selection or reconnect', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([identity('a')]))
    const c = createAuthors('org', vi.fn(), vi.fn(), lookup)
    c.watch(['a', 'a']); await settle()
    for (let i = 0; i < 10; i++) { c.watch(['a']); await settle() }
    expect(lookup).toHaveBeenCalledTimes(1)
    c.retry(); await settle() // Channel selection
    c.watch(['a']); await settle()
    expect(lookup).toHaveBeenCalledTimes(2)
    c.retry(); await settle() // reconnect
    expect(lookup).toHaveBeenCalledTimes(3)
    c.replaceMembers([]); await settle()
    expect(lookup).toHaveBeenCalledTimes(4)
    expect(c.get().get('a')).toEqual(identity('a'))
  })

  it('splits at 100 ids and keeps successful batches when another fails or omits ids', async () => {
    const lookup = vi.fn(async (_org, { ids }: { ids: string[] }) =>
      ids[0] === '100' ? { ok: false as const, kind: 'network' as const } : ok(ids.map(id => identity(id))))
    const c = createAuthors('org', vi.fn(), vi.fn(), lookup)
    c.watch(Array.from({ length: 205 }, (_, i) => String(i)))
    await settle()
    expect(lookup.mock.calls.map(call => call[1].ids.length)).toEqual([100, 100, 5])
    expect(c.get().size).toBe(105)
    expect(c.get().has('100')).toBe(false)
    c.watch(Array.from({ length: 205 }, (_, i) => String(i))); await settle()
    expect(lookup).toHaveBeenCalledTimes(3)
  })

  it('fences old lookups after reload and close but preserves Account Session rejection', async () => {
    let finish!: (result: ReturnType<typeof ok>) => void
    const lookup = vi.fn(() => new Promise<ReturnType<typeof ok>>(resolve => { finish = resolve }))
    const ended = vi.fn(), unavailable = vi.fn()
    const c = createAuthors('org', ended, unavailable, lookup)
    c.watch(['a']); await settle()
    const old = finish
    c.replaceMembers([member('a')]); await settle()
    old(ok([identity('a', true)])); await settle()
    expect(c.get().get('a')?.deactivated).toBe(false)
    c.watch(['b']); await settle(); c.close()
    finish({ ok: false, kind: 'http', status: 401 }); await settle()
    expect(ended).toHaveBeenCalledOnce()
    expect(c.get().size).toBe(0)
    expect(unavailable).not.toHaveBeenCalled()
  })

  async function membershipLossAfterFreshness(trigger: 'retry' | 'replaceMembers') {
    const finishes: ((result: ReturnType<typeof ok>) => void)[] = []
    const unavailable = vi.fn()
    const lookup = vi.fn(() => new Promise<ReturnType<typeof ok>>(resolve => { finishes.push(resolve) }))
    const c = createAuthors('org', vi.fn(), unavailable, lookup)
    c.watch(['a']); await settle()
    if (trigger === 'retry') c.retry()
    else c.replaceMembers([member('known')])
    await settle()
    expect(lookup).toHaveBeenCalledTimes(2)
    finishes[0]({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
    await settle()
    expect(unavailable).toHaveBeenCalledOnce()
    finishes[1](ok([identity('a')]))
    c.watch(['b']); c.retry(); c.replaceMembers([])
    await settle()
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(c.get().has('a')).toBe(false)
  }

  it('reports Membership loss after retry advances freshness and stops further lookups', () => membershipLossAfterFreshness('retry'))
  it('reports Membership loss after Member-list replacement advances freshness and stops further lookups', () => membershipLossAfterFreshness('replaceMembers'))

  it('ignores Membership loss from a previous Organization selection', async () => {
    let finish!: (result: ReturnType<typeof ok>) => void
    const unavailable = vi.fn()
    const lookup = vi.fn(() => new Promise<ReturnType<typeof ok>>(resolve => { finish = resolve }))
    const previous = createAuthors('org', vi.fn(), unavailable, lookup)
    previous.watch(['a']); await settle()
    const old = finish
    previous.close()
    const current = createAuthors('org', vi.fn(), unavailable, lookup)
    old({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
    await settle()
    expect(unavailable).not.toHaveBeenCalled()
    current.watch(['b']); await settle(); finish(ok([identity('b')]))
    await settle()
    expect(current.get().get('b')).toEqual(identity('b'))
    current.close()
  })

  it('stops lookups and fences in-flight identities on C10 while retaining cached names and late 401 handling', async () => {
    const finishes: ((result: ReturnType<typeof ok>) => void)[] = []
    const lookup = vi.fn(() => new Promise<ReturnType<typeof ok>>(resolve => { finishes.push(resolve) }))
    const ended = vi.fn(), unavailable = vi.fn()
    const c = createAuthors('org', ended, unavailable, lookup)
    c.replaceMembers([member('known')])
    c.watch(Array.from({ length: 201 }, (_, i) => String(i)))
    await settle()
    finishes[0]({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
    await settle()
    expect(unavailable).toHaveBeenCalledOnce()
    finishes[1](ok([identity('100')]))
    c.watch(['new']); c.retry(); c.replaceMembers([])
    await settle()
    expect(lookup).toHaveBeenCalledTimes(3)
    expect([...c.get().keys()]).toEqual(['known'])
    finishes[2]({ ok: false, kind: 'http', status: 401 })
    await settle()
    expect(ended).toHaveBeenCalledOnce()
  })

  it('exposes each successful Member list fetch as a freshness hook for #315', async () => {
    const listMembers = vi.fn().mockResolvedValueOnce({ ok: true, data: { members: [member('a')] } })
      .mockResolvedValueOnce({ ok: true, data: { members: [] } })
      .mockResolvedValueOnce({ ok: true, data: { members: [member('a')] } })
    const c = createMembers('org', vi.fn(), vi.fn(), {
      listMembers, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    })
    await c.load(); const first = c.authors.get()
    expect(first.get('a')?.deactivated).toBe(false)
    await c.load(); expect(c.authors.get().has('a')).toBe(false)
    await c.load(); expect(c.authors.get()).not.toBe(first)
    expect(c.authors.get().get('a')?.deactivated).toBe(false)
    c.close()
  })

  it('never restores an active cached identity from a superseded Member list fetch', async () => {
    const finishes: ((result: Result<{ members: Member[] }>) => void)[] = []
    const c = createMembers('org', vi.fn(), vi.fn(), {
      listMembers: () => new Promise(resolve => { finishes.push(resolve) }),
      changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    })
    const older = c.load(), newer = c.load()
    finishes[1]({ ok: true, data: { members: [] } }); await newer
    const latest = c.authors.get()
    finishes[0]({ ok: true, data: { members: [member('a')] } }); await older
    expect(c.authors.get()).toBe(latest)
    expect(c.authors.get().has('a')).toBe(false)
    expect(c.get().members).toEqual([])
    c.close()
  })
})
