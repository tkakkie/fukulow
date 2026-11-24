import { flushSync, mount, unmount } from 'svelte'
import { afterEach, expect, it, vi } from 'vitest'
import { createChannelMembers, channelMemberError } from './channel-members'
import { channelMembersAdapter } from './channel-members.svelte'
import ChannelMembers from './ChannelMembers.svelte'
import * as api from './api'
import { withMiniDom } from './svelte-dom-test-helpers'

afterEach(() => vi.useRealTimers())
function fixture(memberListRole?: () => api.Role | null) {
  const deps = {
    listChannelMembers: vi.fn().mockResolvedValue({ ok: true, data: { members: [{ id: 'self', name: '本人', role: 'admin', manager: true }] } }),
    addChannelMember: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    removeChannelMember: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    changeChannelManager: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  }
  const observed = vi.fn(), left = vi.fn(), refresh = vi.fn()
  const controller = createChannelMembers('org', 'channel', observed, deps, left, refresh, memberListRole)
  return { deps, observed, left, refresh, controller }
}
it('retains or withholds Channel member rows by viewer Role while rejecting stale refetches', async () => {
  vi.useFakeTimers()
  for (const reason of ['periodic', 'reconcile', 'access'] as const) {
    for (const guest of [false, true]) {
      const { controller, deps } = fixture(() => guest ? 'guest' : 'admin')
      const initial: api.ChannelMember[] = [{ id: 'self', name: '本人', role: guest ? 'guest' : 'admin', manager: false }]
      const refreshed = [{ ...initial[0], name: '新しい名前' }]
      const displayed = guest ? [] : initial
      const context = `${reason}, guest=${guest}`
      let resolveStale!: (result: api.Result<api.ChannelMemberList>) => void
      deps.listChannelMembers
        .mockResolvedValueOnce({ ok: true, data: { members: initial } })
        .mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve }))
        .mockResolvedValueOnce({ ok: false, kind: 'http', status: 503, retryAfterMs: 1000 })
        .mockResolvedValueOnce({ ok: true, data: { members: refreshed } })
      try {
        await controller.load()
        expect(controller.get().members).toEqual(initial)
        const stale = controller.load()
        controller.activityTarget.invalidate(reason)
        expect(controller.get(), context).toMatchObject({ members: displayed, loading: guest })
        resolveStale({ ok: true, data: { members: [{ ...initial[0], name: '古い名前' }] } })
        await stale
        expect(controller.get().members, context).toEqual(displayed)
        await vi.advanceTimersByTimeAsync(200)
        expect(controller.get(), context).toMatchObject({ members: [], loading: false, retryable: true })
        await vi.advanceTimersByTimeAsync(1000)
        expect(controller.get(), context).toMatchObject({ members: refreshed, loading: false, error: '' })
      } finally { controller.close() }
    }
  }
})
it('aborts a timed-out Channel member list before retrying', async () => {
  vi.useFakeTimers()
  const c = fixture()
  const signals: AbortSignal[] = []
  c.deps.listChannelMembers.mockImplementation((_org, _channel, _cursor, signal) => {
    if (signals.length) expect(signals[0].aborted).toBe(true)
    signals.push(signal)
    return new Promise(() => {})
  })
  try {
    void c.controller.load()
    expect(signals).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(signals[0].aborted).toBe(true)
    expect(signals).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(signals).toHaveLength(2)
  } finally { c.controller.close() }
})
it('loads generated Member records, refreshes after add/remove, and forwards leave without restoring a list', async () => {
  const c = fixture(); await c.controller.load()
  expect(c.controller.get().members[0]).toEqual({ id: 'self', name: '本人', role: 'admin', manager: true })
  await c.controller.add('other'); expect(c.deps.addChannelMember).toHaveBeenCalledWith('org', 'channel', { member_id: 'other' })
  await c.controller.remove('other'); expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(3)
  await c.controller.remove('self'); expect(c.left).not.toHaveBeenCalled(); expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(4)
})
it('grants and revokes the Channel manager right, prevents double clicks while pending, and refreshes the list on 204 success', async () => {
  const c = fixture(); await c.controller.load()
  let finish!: (r: api.Result<undefined>) => void
  c.deps.changeChannelManager.mockImplementationOnce(() => new Promise(r => { finish = r }))
  c.deps.listChannelMembers.mockResolvedValueOnce({
    ok: true,
    data: { members: [{ id: 'self', name: '本人', role: 'admin', manager: true }, { id: 'other', name: '佐藤', role: 'member', manager: true }] },
  })
  const first = c.controller.changeManager('other', true)
  expect(c.controller.get().busy).toBe(true)
  // Double click while pending is ignored
  await c.controller.changeManager('other', false)
  await c.controller.add('other')
  await c.controller.remove('other')
  expect(c.deps.changeChannelManager).toHaveBeenCalledTimes(1)
  expect(c.deps.changeChannelManager).toHaveBeenCalledWith('org', 'channel', 'other', { manager: true })
  expect(c.deps.addChannelMember).not.toHaveBeenCalled()
  expect(c.deps.removeChannelMember).not.toHaveBeenCalled()

  finish({ ok: true, data: undefined })
  await first
  expect(c.controller.get().busy).toBe(false)
  expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(2)
  expect(c.refresh).toHaveBeenCalledTimes(1)
  expect(c.controller.get().members).toEqual([
    { id: 'self', name: '本人', role: 'admin', manager: true },
    { id: 'other', name: '佐藤', role: 'member', manager: true },
  ])

  c.deps.listChannelMembers.mockResolvedValueOnce({
    ok: true,
    data: { members: [{ id: 'self', name: '本人', role: 'admin', manager: true }, { id: 'other', name: '佐藤', role: 'member', manager: false }] },
  })
  await c.controller.changeManager('other', false)
  expect(c.deps.changeChannelManager).toHaveBeenLastCalledWith('org', 'channel', 'other', { manager: false })
  expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(3)
  expect(c.refresh).toHaveBeenCalledTimes(2)
  expect(c.controller.get().members[1].manager).toBe(false)
})
it('C9 stops automatic Member work and fences late results while same-session late 401 is still observed', async () => {
  const c = fixture()
  let resolve!: (r: api.Result<api.ChannelMemberList>) => void
  c.deps.listChannelMembers.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const loading = c.controller.load(); c.controller.unavailable()
  resolve({ ok: true, data: { members: [{ id: 'late', name: '古い結果', role: 'member', manager: false }] } }); await loading
  expect(c.controller.get().members).toEqual([])
  await c.controller.load(); await c.controller.add('other'); await c.controller.remove('other'); await c.controller.changeManager('other', true)
  expect(c.deps.listChannelMembers).toHaveBeenCalledOnce(); expect(c.deps.addChannelMember).not.toHaveBeenCalled(); expect(c.deps.changeChannelManager).not.toHaveBeenCalled()
  const b = fixture(); let end!: (r: api.Result<api.ChannelMemberList>) => void
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
it('explains every Channel manager PATCH refusal in Japanese and preserves the list without raw codes', async () => {
  const c = fixture(); await c.controller.load()
  const refusals: Array<[number, string, string]> = [
    [409, 'last_channel_manager', 'このチャンネルを管理できる最後のメンバーです。先に別のオーナー、管理者、またはチャンネル管理者を設定してください。'],
    [400, 'channel_manager_private_only', 'パブリックチャンネルではチャンネル管理者を設定できません。'],
    [400, 'channel_manager_guest', 'ゲストにはチャンネル管理者を設定できません。'],
    [403, 'forbidden', 'この操作の権限がありません。'],
    [404, 'member_not_found', '対象のメンバーが見つかりません。一覧を更新してからもう一度お試しください。'],
    [404, 'channel_grant_not_found', 'このメンバーはチャンネルに参加していません。一覧を更新してからもう一度お試しください。'],
    [404, 'channel not found', 'このチャンネルは利用できません。チャンネル一覧から選び直してください。'],
  ]
  for (const [status, error, expected] of refusals) {
    c.deps.changeChannelManager.mockResolvedValueOnce({ ok: false, kind: 'http', status, error })
    await c.controller.changeManager('other', true)
    expect(c.controller.get().error).toBe(expected)
    expect(c.controller.get().error).not.toContain(error)
    expect(c.controller.get().error).not.toContain(String(status))
    expect(c.controller.get().members).toHaveLength(1)
    expect(c.deps.listChannelMembers).toHaveBeenCalledOnce()
    expect(c.refresh).not.toHaveBeenCalled()
  }
})
it('times out loading after 10 seconds and never lets a late list replace the retry', async () => {
  vi.useFakeTimers(); const c = fixture(); let late!: (r: api.Result<api.ChannelMemberList>) => void
  c.deps.listChannelMembers.mockImplementationOnce(() => new Promise(r => { late = r }))
  const first = c.controller.load(); await vi.advanceTimersByTimeAsync(10_000); await first
  expect(c.controller.get().loading).toBe(false); expect(c.controller.get().error).not.toBe('')
  await c.controller.load(); late({ ok: true, data: { members: [] } }); await Promise.resolve()
  expect(c.controller.get().members[0].id).toBe('self')
})

it('renders チャンネル管理者 in the メンバー tab, hides controls without can_manage_managers, confirms or cancels via Dialog, disables controls while pending, refreshes after 204, and shows Japanese refusals', async () => {
  await withMiniDom(async (doc) => {
    const initialMembers: api.ChannelMember[] = [
      { id: 'self', name: '山田 太郎', role: 'owner', manager: true },
      { id: 'm2', name: '佐藤 花子', role: 'member', manager: false },
      { id: 'g1', name: '鈴木 ゲスト', role: 'guest', manager: false },
    ]
    const deps = {
      listChannelMembers: vi.fn<typeof api.listChannelMembers>().mockResolvedValue({ ok: true, data: { members: initialMembers } }),
      addChannelMember: vi.fn<typeof api.addChannelMember>().mockResolvedValue({ ok: true, data: undefined }),
      removeChannelMember: vi.fn<typeof api.removeChannelMember>().mockResolvedValue({ ok: true, data: undefined }),
      changeChannelManager: vi.fn<typeof api.changeChannelManager>().mockResolvedValue({ ok: true, data: undefined }),
    }
    const refreshChannels = vi.fn()
    const controller = createChannelMembers('org-1', 'ch-1', vi.fn(), deps, () => {}, refreshChannels)
    await controller.load()
    const model = channelMembersAdapter(controller)

    const makeChannel = (canManageManagers: boolean): api.Channel => ({
      id: 'ch-1',
      kind: 'channel', archived: false,
      name: 'secret',
      visibility: 'private',
      capabilities: {
        can_add_members: { allowed: false },
        can_remove_members: { allowed: false },
        can_manage_managers: { allowed: canManageManagers },
        can_leave: { allowed: true }, can_rename: { allowed: false }, can_archive: { allowed: false },
      },
    })

    // 1. Without can_manage_managers: チャンネル管理者 is shown for holders, but grant/revoke controls are hidden
    const hostHidden = doc.createElement('div')
    doc.body.appendChild(hostHidden)
    const instHidden = mount(ChannelMembers, {
      target: hostHidden as unknown as Element,
      props: { model, channel: makeChannel(false), self: 'self', candidates: [] },
    })
    flushSync()
    const rowsHidden = hostHidden.querySelectorAll('li')
    expect(rowsHidden).toHaveLength(3)
    expect(rowsHidden[0].textContent).toContain('山田 太郎')
    expect(rowsHidden[0].textContent).toContain('チャンネル管理者')
    expect(rowsHidden[1].textContent).toContain('佐藤 花子')
    expect(rowsHidden[1].textContent).not.toContain('チャンネル管理者')
    expect(rowsHidden[2].textContent).toContain('鈴木 ゲスト')
    expect(rowsHidden[2].textContent).toContain('ゲスト')
    expect(hostHidden.querySelectorAll('button').map(b => b.textContent.trim())).toEqual(['退出する'])
    await unmount(instHidden)
    hostHidden.remove()

    // 2. With can_manage_managers: grant/revoke buttons appear for Member/Owner rows, but Guest row has no grant button; cancel sends nothing; confirm sends PATCH and refreshes
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    const inst = mount(ChannelMembers, {
      target: host as unknown as Element,
      props: { model, channel: makeChannel(true), self: 'self', candidates: [] },
    })
    flushSync()

    const findButton = (text: string) => host.querySelectorAll('button').find(b => b.textContent.trim() === text)
    expect(findButton('チャンネル管理者を解除する')).toBeDefined()
    expect(findButton('チャンネル管理者にする')).toBeDefined()
    expect(host.querySelectorAll('button').filter(b => b.textContent.trim() === 'チャンネル管理者にする')).toHaveLength(1)
    expect(host.querySelectorAll('li')[2].querySelectorAll('button')).toHaveLength(0)

    // Click grant on 佐藤 花子 -> opens confirm Dialog, then click キャンセル -> sends nothing
    findButton('チャンネル管理者にする')!.click()
    flushSync()
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('チャンネル管理者を付与しますか？')
    findButton('キャンセル')!.click()
    flushSync()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(deps.changeChannelManager).not.toHaveBeenCalled()

    // Click grant on 佐藤 花子 again -> confirm in Dialog -> holds pending (disables buttons against double click) -> resolves 204 -> refreshes list and capabilities
    let resolvePatch!: (r: api.Result<undefined>) => void
    deps.changeChannelManager.mockImplementationOnce(() => new Promise(r => { resolvePatch = r }))
    deps.listChannelMembers.mockResolvedValueOnce({
      ok: true,
      data: {
        members: [
          { id: 'self', name: '山田 太郎', role: 'owner', manager: true },
          { id: 'm2', name: '佐藤 花子', role: 'member', manager: true },
          { id: 'g1', name: '鈴木 ゲスト', role: 'guest', manager: true },
        ],
      },
    })

    findButton('チャンネル管理者にする')!.click()
    flushSync()
    findButton('付与する')!.click()
    flushSync()

    expect(deps.changeChannelManager).toHaveBeenCalledTimes(1)
    expect(deps.changeChannelManager).toHaveBeenCalledWith('org-1', 'ch-1', 'm2', { manager: true })
    // While pending, action buttons are disabled so a double click is prevented
    expect(findButton('チャンネル管理者にする')?.disabled).toBe(true)
    findButton('チャンネル管理者にする')?.click()
    expect(deps.changeChannelManager).toHaveBeenCalledTimes(1)

    resolvePatch({ ok: true, data: undefined })
    for (let i = 0; i < 16; i++) await Promise.resolve()
    flushSync()

    expect(deps.listChannelMembers).toHaveBeenCalledTimes(2)
    expect(refreshChannels).toHaveBeenCalledTimes(1)
    const rowsAfterGrant = host.querySelectorAll('li')
    expect(rowsAfterGrant[1].textContent).toContain('チャンネル管理者')
    // If a Guest row somehow has manager: true, the revoke action remains available
    expect(rowsAfterGrant[2].querySelector('button')?.textContent.trim()).toBe('チャンネル管理者を解除する')

    // 3. Each refusal shows its Japanese copy in the alert banner
    const refusals: Array<[number, string, string]> = [
      [409, 'last_channel_manager', 'このチャンネルを管理できる最後のメンバーです。先に別のオーナー、管理者、またはチャンネル管理者を設定してください。'],
      [400, 'channel_manager_private_only', 'パブリックチャンネルではチャンネル管理者を設定できません。'],
      [400, 'channel_manager_guest', 'ゲストにはチャンネル管理者を設定できません。'],
      [403, 'forbidden', 'この操作の権限がありません。'],
      [404, 'member_not_found', '対象のメンバーが見つかりません。一覧を更新してからもう一度お試しください。'],
      [404, 'channel_grant_not_found', 'このメンバーはチャンネルに参加していません。一覧を更新してからもう一度お試しください。'],
      [404, 'channel not found', 'このチャンネルは利用できません。チャンネル一覧から選び直してください。'],
    ]
    for (const [status, error, copy] of refusals) {
      deps.changeChannelManager.mockResolvedValueOnce({ ok: false, kind: 'http', status, error })
      host.querySelectorAll('button').find(b => b.textContent.trim() === 'チャンネル管理者を解除する')!.click()
      flushSync()
      findButton('解除する')!.click()
      for (let i = 0; i < 8; i++) await Promise.resolve()
      flushSync()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(copy)
    }

    await unmount(inst)
  })
})

it('a committed self notice during a grant mutation fences the list without leaving the action busy', async () => {
  const c = fixture()
  await c.controller.load()
  let release!: (r: api.Result<undefined>) => void
  c.deps.addChannelMember.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const mutation = c.controller.add('target')
  c.controller.activityTarget.invalidate('access')
  release({ ok: true, data: undefined })
  await mutation
  expect(c.controller.get().busy).toBe(false)
  c.controller.close()
})
