import { afterEach, expect, it, vi } from 'vitest'
import { createMembers, watchMemberAccess } from './members'
import { createSession } from './session'
import { channel, fakeNetwork, ok, settle } from './adapter-test-helpers.svelte'
import type { Member } from './api'

afterEach(() => vi.useRealTimers())

it('remote grant changes converge at the next panel open without channel_access_lost and keep past sender identities', async () => {
  const self: Member = { id: 'me', name: 'ゲスト', role: 'guest' }
  const peer: Member = { id: 'peer', name: '共有メンバー', role: 'member' }
  let shared = false
  const listMembers = vi.fn(async () => ok({ members: shared ? [self, peer] : [self] }))
  const members = createMembers('org', vi.fn(), vi.fn(), {
    listMembers, lookupAuthors: async () => ok({ identities: [{ id: 'peer', name: peer.name, deactivated: false }] }),
    changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
  })
  await members.load()
  shared = true // Another client grants peer; there is no general grant-change event.
  expect(members.get().members).toEqual([self])
  await members.load() // The Organization/Channel member panel's open handler.
  expect(members.get().members).toEqual([self, peer])
  shared = false
  await members.load()
  expect(members.get().members).toEqual([self])
  members.authors.watch(['peer']); await settle()
  expect(members.authors.get().get('peer')?.name).toBe(peer.name)
  expect(members.get().members).toEqual([self])
  members.close()
})

it('refreshes Members on Channel list additions removals access loss and reconnect and detaches on selection teardown', async () => {
  vi.useFakeTimers()
  const net = fakeNetwork()
  const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
  const refresh = vi.fn()
  const stop = watchMemberAccess(session.channels, session.sync, refresh)
  net.socket.onReady(); await settle()
  expect(refresh).toHaveBeenCalledTimes(1)
  net.lists[0].resolve(ok({ channels: [channel('A')] })); await settle()
  expect(refresh).toHaveBeenCalledTimes(2)
  net.subscribed('A', 0); await settle()
  refresh.mockClear()
  // A list reload with the same Channels is not an access change.
  const reload = session.channels.load()
  net.lists.at(-1)!.resolve(ok({ channels: [channel('A')] })); await reload
  expect(refresh).not.toHaveBeenCalled()
  const added = session.channels.load()
  net.lists.at(-1)!.resolve(ok({ channels: [channel('A'), channel('B')] })); await added
  expect(refresh).toHaveBeenCalledTimes(1)
  const removed = session.channels.load()
  net.lists.at(-1)!.resolve(ok({ channels: [channel('A')] })); await removed
  expect(refresh).toHaveBeenCalledTimes(2)
  net.event({ type: 'channel_access_lost', channel_id: 'A' }); await settle()
  expect(refresh).toHaveBeenCalledTimes(3)
  net.socket.onClose(1011); await settle()
  await vi.advanceTimersByTimeAsync(2_000); await settle()
  net.socket.onReady(); await settle()
  expect(refresh).toHaveBeenCalledTimes(4)
  stop()
  const after = session.channels.load()
  net.lists.at(-1)!.resolve(ok({ channels: [] })); await after
  expect(refresh).toHaveBeenCalledTimes(4)
  session.close()
})
