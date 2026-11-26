import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import type { DisplayIdentity, Result, lookupAuthors } from './api'
import { watchAuthorScope } from './author-lookup-scope'
import { createAuthors } from './authors'
import { createSession } from './session'

const historyGeneration = '00000000-0000-4000-8000-000000000515'
const identity = (id: string, name = id): DisplayIdentity => ({ id, name, deactivated: false })

function setup() {
  const net = fakeNetwork()
  const options = net.options()
  const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...options,
    sync: { ...options.sync, random: () => 0 },
  })
  const finishes: ((result: Result<{ identities: DisplayIdentity[] }>) => void)[] = []
  const lookup = vi.fn<typeof lookupAuthors>(() => new Promise(resolve => { finishes.push(resolve) }))
  const authors = createAuthors('org', vi.fn(), vi.fn(), lookup)
  const stop = watchAuthorScope(session.channels, session.sync, authors)
  net.pages.c1 = ok({ history_generation: historyGeneration, as_of_seq: 1, has_more: false, messages: [record(1, 'c1')] })
  net.socket.onReady()
  net.lists[0].resolve(ok({ history_generation: historyGeneration, channels: [channel('c1'), channel('c2')] }))
  return {
    net, session, authors, lookup,
    async start(ids = ['alice']) {
      await settle()
      expect(net.subscribeCount('c1')).toBe(1)
      authors.watch(ids, 'c1')
      await settle()
      expect(lookup).toHaveBeenCalledExactlyOnceWith('org', { ids })
    },
    resolve(index: number, ...identities: DisplayIdentity[]) { finishes[index](ok({ identities })) },
    close() { stop(); authors.close(); session.close() },
  }
}

describe('sender lookup scope', () => {
  let w: ReturnType<typeof setup>
  beforeEach(() => { vi.useFakeTimers(); w = setup() })
  afterEach(() => { w.close(); vi.useRealTimers() })

  it('retries only the IDs omitted by a lookup carried across initial confirmation', async () => {
    await w.start(['alice', 'bob'])
    w.net.subscribed('c1', 1)
    await settle()
    expect(w.lookup).toHaveBeenCalledTimes(1)
    expect(w.authors.isPending('bob')).toBe(true)

    w.resolve(0, identity('alice'))
    await settle()
    expect(w.lookup).toHaveBeenCalledTimes(2)
    expect(w.lookup).toHaveBeenLastCalledWith('org', { ids: ['bob'] })
    expect(w.authors.isPending('bob')).toBe(true)
    w.resolve(1)
    await settle()
    expect(w.lookup).toHaveBeenCalledTimes(2)
    expect(w.authors.isPending('bob')).toBe(false)
    expect(w.authors.get().get('alice')).toEqual(identity('alice'))
  })

  it('fences the prior lookup before the replacement connection confirms', async () => {
    await w.start()
    const oldSocket = w.net.socket
    oldSocket.onClose(1006)
    await vi.advanceTimersByTimeAsync(1)
    expect(w.net.socket).not.toBe(oldSocket)
    w.net.socket.onReady()
    w.resolve(0, identity('alice', 'old socket'))
    await settle()
    expect(w.authors.get().has('alice')).toBe(false)

    w.net.subscribed('c1', 1)
    await settle()
    expect(w.lookup).toHaveBeenCalledTimes(2)
    w.resolve(1, identity('alice'))
    await settle()
    expect(w.authors.get().get('alice')).toEqual(identity('alice'))
  })

  it('fences a pending lookup when the next Channel has the same sender', async () => {
    await w.start()
    w.session.channels.selectHint('c2')
    await settle()
    expect(w.net.subscribeCount('c2')).toBe(1)
    expect(w.lookup).toHaveBeenCalledTimes(1)
    w.authors.watch(['alice'], 'c2')
    await settle()
    expect(w.lookup).toHaveBeenCalledTimes(2)
    w.resolve(0, identity('alice', 'old selection'))
    await settle()
    expect(w.authors.get().has('alice')).toBe(false)
    w.resolve(1, identity('alice'))
    await settle()
    expect(w.authors.get().get('alice')).toEqual(identity('alice'))
  })

  it('fences a pending lookup on Channel access loss', async () => {
    await w.start()
    w.net.subscribed('c1', 1)
    w.net.event({ type: 'channel_access_lost', channel_id: 'c1' })
    expect(w.session.sync.get().channels.c1.state).toBe('unavailable')
    w.resolve(0, identity('alice'))
    await settle()
    expect(w.authors.get().has('alice')).toBe(false)
    expect(w.lookup).toHaveBeenCalledTimes(1)
  })

  it('fences a pending lookup on an Organization Channel revocation notice', async () => {
    await w.start()
    w.net.event({ type: 'channel_access_revoked', channel_id: 'c1' })
    w.resolve(0, identity('alice'))
    await settle()
    expect(w.authors.get().has('alice')).toBe(false)
    expect(w.lookup).toHaveBeenCalledTimes(1)
  })

  it('fences a pending lookup when initial confirmation clamps the cursor', async () => {
    await w.start()
    w.net.subscribed('c1', 0)
    w.resolve(0, identity('alice'))
    await settle()
    expect(w.authors.get().has('alice')).toBe(false)
    expect(w.net.subscribeCount('c1')).toBe(2)
  })

  it('fences a pending lookup when the Organization history generation changes', async () => {
    await w.start()
    const socket = w.net.socket
    w.net.event({ type: 'subscribed', channel_id: 'c1', caught_up_seq: 1,
      history_generation: '00000000-0000-4000-8000-000000001043',
    })
    expect(w.net.socket).not.toBe(socket)
    w.resolve(0, identity('alice'))
    await settle()
    expect(w.authors.get().has('alice')).toBe(false)
  })

  it('fences a carried lookup when the Member list replaces its identities', async () => {
    await w.start()
    w.net.subscribed('c1', 1)
    w.authors.replaceMembers([{ id: 'alice', name: 'directory', role: 'member' }])
    w.resolve(0, identity('alice', 'old lookup'))
    await settle()
    expect(w.authors.get().get('alice')?.name).toBe('directory')
    expect(w.lookup).toHaveBeenCalledTimes(1)
  })
})
