import { describe, expect, it, vi } from 'vitest'
import { createSession } from './session'
import * as api from './api'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'

function open() {
  const net = fakeNetwork()
  const onEnded = vi.fn()
  const session = createSession({ selfId: 'me', onEnded, ...net.options() })
  net.socket.onReady()
  return { net, session, onEnded }
}
const controls = (net: ReturnType<typeof fakeNetwork>) => net.sockets.flatMap((s) => s.sent).map((m) => `${m.type}:${m.channel_id}`)

describe('session controllers', () => {
  it('watches the selected Channel and moves the watch when the selection changes (unwatch before watch)', async () => {
    const { net, session } = open()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    net.pages.B = ok({ messages: [record(200, 'B')], has_more: false })
    net.lists[0].resolve(ok({ channels: [channel('A'), channel('B')] }))
    await settle()
    expect(session.channels.get().selectedId).toBe('A')
    expect(net.history.map((h) => h.channel)).toEqual(['A'])
    expect(controls(net)).toEqual(['subscribe:A'])

    session.channels.select('B')
    await settle()
    expect(controls(net)).toEqual(['subscribe:A', 'unsubscribe:A', 'subscribe:B'])
    session.channels.select('B') // the same selection is not a new intent
    await settle()
    expect(controls(net)).toEqual(['subscribe:A', 'unsubscribe:A', 'subscribe:B'])
    session.close()
  })

  it('close stops the connection and fences a Channel list that is still loading', async () => {
    const { net, session } = open()
    session.close()
    expect(net.socket.closed).toBe(true)
    net.lists[0].resolve(ok({ channels: [channel('A')] }))
    await settle()
    expect(session.channels.get()).toMatchObject({ status: 'loading', selectedId: null })
    expect(net.history).toEqual([]) // nothing was selected, so nothing was watched
    expect(net.sockets).toHaveLength(1)
  })

  it('close stops following the selection', async () => {
    const { net, session } = open()
    net.lists[0].resolve(ok({ channels: [channel('A'), channel('B')] }))
    await settle()
    session.close()
    const requests = net.history.length
    session.channels.select('B') // a stray caller on the closed session
    await settle()
    expect(net.history).toHaveLength(requests)
    expect(controls(net)).not.toContain('subscribe:B')
  })

  it('a new session does not see the closed session\'s state or late results', async () => {
    const first = open()
    first.session.close()
    const second = open()
    second.net.lists[0].resolve(ok({ channels: [channel('X')] }))
    await settle()
    first.net.lists[0].resolve(ok({ channels: [channel('A')] }))
    await settle()
    expect(second.session.channels.get().channels.map((c) => c.id)).toEqual(['X'])
    expect(second.net.history.map((h) => h.channel)).toEqual(['X'])
    expect(first.net.history).toEqual([])
    second.session.close()
  })

  it('a refusal from the server ends the session through onEnded only (401 on a send)', async () => {
    const { net, session, onEnded } = open()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    void session.sync.getTimeline('A').send('hi')
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'http', status: 401 })
    await settle()
    expect(onEnded).toHaveBeenCalledTimes(1)
    session.close()
  })
})

it('ordinary REST organization_unavailable ends only its Organization', async () => {
  for (const operation of ['history', 'send', 'list', 'create'] as const) {
    vi.useFakeTimers()
    const { net, session, onEnded } = open()
    const other = open()
    try {
      net.pages.A = ok({ messages: [record(100)], has_more: false })
      net.lists[0].resolve(ok({ channels: [channel('A')] }))
      await settle()
      net.subscribed('A', 100)
      void session.sync.getTimeline('A').send('pending')
      await settle()
      const refusal = { ok: false, kind: 'http', status: 404, error: 'organization_unavailable' } as const
      if (operation === 'history') {
        net.pages.A = refusal
        await session.sync.getTimeline('A').loadLatest()
      } else if (operation === 'send') {
        net.sends[0].resolve(refusal)
      } else if (operation === 'list') {
        void session.channels.load()
        net.lists[1].resolve(refusal)
      } else {
        void session.channels.create({ name: 'New', visibility: 'public' })
        net.creates[0].resolve(refusal)
      }
      await settle()
      expect(session.sync.get()).toMatchObject({ organization: 'unavailable', running: false, timers: {},
        channels: { A: { pending: [{ state: 'failed' }] } } })
      expect(net.socket.closed).toBe(true)
      expect(onEnded).not.toHaveBeenCalled()
      expect(other.session.sync.get().organization).toBe('available')
      expect(other.net.socket.closed).toBe(false)
      const requests = [net.history.length, net.sends.length, net.lists.length, net.creates.length]
      await session.sync.getTimeline('A').retry('me-c1')
      await vi.advanceTimersByTimeAsync(120_000)
      expect([net.history.length, net.sends.length, net.lists.length, net.creates.length]).toEqual(requests)
      expect(net.sockets).toHaveLength(1)
    } finally {
      session.close(); other.session.close(); vi.useRealTimers()
    }
  }
})

it('ordinary history channel_not_found stays terminal for the Channel under C9', async () => {
  const { net, session, onEnded } = open()
  net.pages.A = { ok: false, kind: 'http', status: 404, error: 'channel_not_found' }
  net.lists[0].resolve(ok({ channels: [channel('A')] }))
  await settle()
  expect(session.sync.get()).toMatchObject({ organization: 'available', running: true,
    channels: { A: { state: 'unavailable' } } })
  expect(net.socket.closed).toBe(false)
  expect(onEnded).not.toHaveBeenCalled()
  session.close()
})

it('explicitly selecting the current C9 Channel reattempts it while another Organization stays ready', async () => {
  const a = open(), b = open()
  for (const c of [a, b]) {
    c.net.pages.A = ok({ messages: [record(100)], has_more: false })
    c.net.lists[0].resolve(ok({ channels: [channel('A')] })); await settle(); c.net.subscribed('A', 100)
  }
  a.net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
  await settle(); expect(a.session.sync.get().channels.A.state).toBe('unavailable')
  expect(b.session.sync.get().channels.A.state).toBe('ready')
  a.session.channels.select('A'); await settle()
  expect(controls(a.net).filter(c => c === 'subscribe:A')).toHaveLength(2)
  a.net.subscribed('A', 100); await settle(); expect(a.session.sync.get().channels.A.state).toBe('ready')
  a.session.close(); b.session.close()
})

it('a Member panel created during C9 recovers on explicit Channel re-selection', async () => {
  const list = vi.spyOn(api, 'listChannelMembers').mockResolvedValue(ok({
    members: [{ id: 'me', name: '本人', role: 'admin' }],
  }))
  const { net, session } = open()
  try {
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'A' })
    await settle()
    expect(session.sync.get().channels.A.state).toBe('unavailable')

    const panel = session.channelMembers('A')
    expect(panel.get()).toMatchObject({ unavailable: true, loading: false })
    await panel.load()
    expect(list).not.toHaveBeenCalled()

    session.channels.select('A')
    await settle()
    net.subscribed('A', 100)
    await settle()
    expect(session.sync.get().channels.A.state).toBe('ready')
    expect(panel.get()).toMatchObject({ unavailable: false, loading: false,
      members: [{ id: 'me', name: '本人', role: 'admin' }] })
    expect(list).toHaveBeenCalledExactlyOnceWith('', 'A')
  } finally {
    session.close()
    list.mockRestore()
  }
})
