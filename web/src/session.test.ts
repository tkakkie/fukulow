import { describe, expect, it, vi } from 'vitest'
import { createSession } from './session'
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
