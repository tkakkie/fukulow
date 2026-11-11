import { afterEach, expect, it, vi } from 'vitest'
import { createChannelMembers, channelMemberError } from './channel-members'
import * as api from './api'

afterEach(() => vi.useRealTimers())
function fixture() {
  const deps = { listChannelMembers: vi.fn().mockResolvedValue({ ok: true, data: { members: [{ id: 'self', name: '本人', role: 'admin' }] } }),
    addChannelMember: vi.fn().mockResolvedValue({ ok: true }), removeChannelMember: vi.fn().mockResolvedValue({ ok: true }) }
  const observed = vi.fn(), left = vi.fn()
  const controller = createChannelMembers('org', 'channel', observed, deps, left)
  return { deps, observed, left, controller }
}
it('loads generated Member records, refreshes after add/remove, and forwards leave without restoring a list', async () => {
  const c = fixture(); await c.controller.load()
  expect(c.controller.get().members[0].id).toBe('self')
  await c.controller.add('other'); expect(c.deps.addChannelMember).toHaveBeenCalledWith('org', 'channel', { member_id: 'other' })
  await c.controller.remove('other'); expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(3)
  await c.controller.remove('self'); expect(c.left).not.toHaveBeenCalled(); expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(4)
})
it('C9 stops automatic Member work and fences late results while same-session late 401 is still observed', async () => {
  const c = fixture()
  let resolve!: (r: api.Result<api.MemberList>) => void
  c.deps.listChannelMembers.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const loading = c.controller.load(); c.controller.unavailable()
  resolve({ ok: true, data: { members: [{ id: 'late', name: '古い結果', role: 'member' }] } }); await loading
  expect(c.controller.get().members).toEqual([])
  await c.controller.load(); await c.controller.add('other'); await c.controller.remove('other')
  expect(c.deps.listChannelMembers).toHaveBeenCalledOnce(); expect(c.deps.addChannelMember).not.toHaveBeenCalled()
  const b = fixture(); let end!: (r: api.Result<api.MemberList>) => void
  b.deps.listChannelMembers.mockImplementationOnce(() => new Promise(r => { end = r }))
  const pending = b.controller.load(); b.controller.close(); end({ ok: false, kind: 'http', status: 401 }); await pending
  expect(b.observed).toHaveBeenCalledWith({ ok: false, kind: 'http', status: 401 })
})
it('explains both private Channel protections in Japanese and preserves the list on refusal', async () => {
  const c = fixture(); await c.controller.load()
  for (const error of ['last_channel_manager', 'last_channel_grant']) {
    c.deps.removeChannelMember.mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error })
    await c.controller.remove('other')
    expect(c.controller.get().error).toBe(channelMemberError({ ok: false, kind: 'http', status: 409, error }))
    expect(c.controller.get().error).toMatch(/最後/); expect(c.controller.get().members).toHaveLength(1)
  }
})
it('times out loading after 10 seconds and never lets a late list replace the retry', async () => {
  vi.useFakeTimers(); const c = fixture(); let late!: (r: api.Result<api.MemberList>) => void
  c.deps.listChannelMembers.mockImplementationOnce(() => new Promise(r => { late = r }))
  const first = c.controller.load(); await vi.advanceTimersByTimeAsync(10_000); await first
  expect(c.controller.get().loading).toBe(false); expect(c.controller.get().error).not.toBe('')
  await c.controller.load(); late({ ok: true, data: { members: [] } }); await Promise.resolve()
  expect(c.controller.get().members[0].id).toBe('self')
})
