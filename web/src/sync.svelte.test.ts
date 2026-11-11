import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { channel, fakeNetwork, mount, ok, record, sentBy, settle, type FakeNetwork } from './adapter-test-helpers.svelte'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A started session whose Channel list answers with A and B; nothing is watched until the list loads. */
function start(net: FakeNetwork, selfId = 'me') {
  const session = createSession({ selfId, onEnded: vi.fn(), ...net.options(selfId) })
  net.socket.onReady()
  return { session, sync: syncAdapter(session.sync) }
}
async function loadChannels(net: FakeNetwork) {
  net.lists.at(-1)!.resolve(ok({ channels: [channel('A'), channel('B')] }))
  await settle()
}
/** Counts the controller listeners the adapter holds on Channel `id`. */
function countListeners(session: ReturnType<typeof createSession>, id: string) {
  const timeline = session.sync.getTimeline(id)
  const subscribe = timeline.subscribe
  const count = { active: 0 }
  vi.spyOn(timeline, 'subscribe').mockImplementation(listener => {
    count.active++
    const release = subscribe(listener)
    return () => { count.active--; release() }
  })
  return count
}

describe('sync adapter', () => {
  it('shows controller state changes: history, live confirmation, stream, pending and ack', async () => {
    const net = fakeNetwork()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    const { session, sync } = start(net)
    const a = sync.channel('A')
    const view = await mount(() => ({ timeline: a.timeline, live: a.live }))
    expect(view.last).toMatchObject({ timeline: { status: 'loading', messages: [] }, live: false })

    await loadChannels(net)
    expect(view.last).toMatchObject({ timeline: { status: 'ready', messages: [record(100)] }, live: false })

    net.subscribed('A', 100)
    await settle()
    expect(view.last.live).toBe(true)

    net.event({ type: 'message', message: record(101) })
    await settle()
    expect(view.last.timeline.messages.map(m => m.seq)).toEqual([100, 101])

    void a.send('hello')
    await settle()
    expect(view.last.timeline.pending).toMatchObject([{ body: 'hello', status: 'sending' }])
    net.sends[0].resolve(ok(sentBy('me', 102, 'me-c1', 'hello')))
    await settle()
    expect(view.last.timeline).toMatchObject({ pending: [] })
    expect(view.last.timeline.messages.map(m => m.seq)).toEqual([100, 101, 102])
    await view.unmount()
    session.close()
  })

  it('shows failed and retryable pending entries, and forwards retry and discard', async () => {
    const net = fakeNetwork()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    const { session, sync } = start(net)
    const a = sync.channel('A')
    const view = await mount(() => a.timeline)
    await loadChannels(net)
    net.subscribed('A', 100)
    void a.send('first')
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await settle()
    expect(view.last.pending).toMatchObject([{ body: 'first', status: 'failed', retryable: true }])
    const id = view.last.pending[0].clientMessageId
    void a.retry(id)
    await settle()
    expect(net.sends).toHaveLength(2)
    expect(net.sends[1].body.client_message_id).toBe(id) // same key: the send stays idempotent
    net.sends[1].resolve({ ok: false, kind: 'http', status: 400 })
    await settle()
    expect(view.last.pending).toMatchObject([{ status: 'failed', retryable: false }])
    a.discard(id)
    await settle()
    expect(view.last.pending).toEqual([])
    await view.unmount()
    session.close()
  })

  it('releases its listener with the last observer, without closing the controller or dropping sync state', async () => {
    const net = fakeNetwork()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    const { session, sync } = start(net)
    const listeners = countListeners(session, 'A')
    const a = sync.channel('A')
    await loadChannels(net)
    net.subscribed('A', 100)
    await settle()

    const first = await mount(() => a.timeline)
    const second = await mount(() => a.timeline)
    expect(listeners.active).toBe(1) // one controller listener serves all observers
    await first.unmount()
    expect(listeners.active).toBe(1) // another observer remains
    await second.unmount()
    expect(listeners.active).toBe(0)

    const runs = first.values.length + second.values.length
    net.event({ type: 'message', message: record(101) })
    await settle()
    expect(first.values.length + second.values.length).toBe(runs) // nobody is notified
    expect(net.socket.closed).toBe(false)
    expect(net.sockets).toHaveLength(1)
    expect(session.sync.get().channels.A).toMatchObject({ cursor: 101, subscription: { confirmed: true } })
    session.close()
    expect(net.socket.closed).toBe(true) // only ending the session closes it
  })

  it('remount shows the updates made while nothing observed, without refetching or resubscribing', async () => {
    const net = fakeNetwork()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    const { session, sync } = start(net)
    const a = sync.channel('A')
    const first = await mount(() => ({ timeline: a.timeline, live: a.live }))
    await loadChannels(net)
    net.subscribed('A', 100)
    await settle()
    await first.unmount()

    net.event({ type: 'message', message: record(101) })
    void a.send('while away')
    await settle()
    const requests = net.history.length
    const subscribes = net.subscribeCount('A')

    const again = await mount(() => ({ timeline: a.timeline, live: a.live }))
    expect(again.last.live).toBe(true)
    expect(again.last.timeline.messages.map(m => m.seq)).toEqual([100, 101])
    expect(again.last.timeline.pending).toMatchObject([{ body: 'while away' }])
    net.event({ type: 'message', message: record(102) })
    await settle()
    expect(again.last.timeline.messages.map(m => m.seq)).toEqual([100, 101, 102]) // and it keeps updating
    expect(net.history).toHaveLength(requests)
    expect(net.subscribeCount('A')).toBe(subscribes)
    expect(net.sockets).toHaveLength(1)
    await again.unmount()
    session.close()
  })

  it('shows a replaced session as empty and ignores everything the old session still delivers', async () => {
    const net = fakeNetwork()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    const { session, sync } = start(net)
    const a = sync.channel('A')
    const view = await mount(() => a.timeline)
    await loadChannels(net)
    net.subscribed('A', 100)
    void a.send('mine')
    await settle()
    expect(view.last).toMatchObject({ messages: [record(100)], pending: [{ body: 'mine' }] })
    const old = net.socket

    void session.sync.replaceSession('other')
    await settle()
    expect(view.last).toMatchObject({ status: 'loading', messages: [], pending: [] })
    old.onEvent({ type: 'message', message: record(999) })
    old.onReady()
    net.sends[0].resolve(ok(sentBy('me', 101, 'me-c1', 'mine'))) // the old session's late ack
    await settle()
    expect(view.last).toMatchObject({ status: 'loading', messages: [], pending: [] })
    expect(session.sync.get().selfId).toBe('other')
    session.close()
  })
})

describe('sync adapter and the unavailable state (C9)', () => {
  const unavailable = async (refusal: 'event' | 'history') => {
    const net = fakeNetwork()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    const { session, sync } = start(net)
    const a = sync.channel('A')
    const view = await mount(() => a.timeline)
    await loadChannels(net)
    net.subscribed('A', 100)
    await settle()
    if (refusal === 'event') net.event({ type: 'error', channel_id: 'A', code: 'channel_not_found' })
    else {
      net.pages.A = { ok: false, kind: 'http', status: 403 }
      void a.loadLatest()
    }
    await settle()
    expect(view.last.status).toBe('unavailable')
    return { net, session, a, view }
  }

  it.each(['event', 'history'] as const)('a refusal by %s is shown and never retried automatically', async refusal => {
    const { net, session, view } = await unavailable(refusal)
    const history = net.history.length
    const subscribes = net.subscribeCount('A')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await settle()
    expect(view.last.status).toBe('unavailable')
    expect(net.history).toHaveLength(history)
    expect(net.subscribeCount('A')).toBe(subscribes)
    expect(net.sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    await view.unmount()
    session.close()
  })

  it('an explicit retry loads the Channel again, and selecting it again watches it again', async () => {
    const { net, session, a, view } = await unavailable('history')
    const history = net.history.length
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    void a.loadLatest() // the retry button
    await settle()
    expect(net.history).toHaveLength(history + 1)
    expect(view.last.status).toBe('ready')

    net.event({ type: 'error', channel_id: 'A', code: 'subscription_limit' })
    await settle()
    expect(view.last.status).toBe('unavailable')
    const subscribes = net.subscribeCount('A')
    session.channels.select('B')
    await settle()
    session.channels.select('A') // reselect
    await settle()
    expect(net.subscribeCount('A')).toBe(subscribes + 1)
    await view.unmount()
    session.close()
  })

  it('distinguishes unavailable from load error, keeps messages and drafts visible, and disables Composer submit when unavailable', async () => {
    const net = fakeNetwork()
    net.pages.A = ok({ messages: [record(100)], has_more: true })
    const { session, sync } = start(net)
    const a = sync.channel('A')
    const view = await mount(() => a.timeline)
    await loadChannels(net)
    net.subscribed('A', 100)
    await settle()

    a.setDraft('draft kept across failures')
    await settle()

    // Transient history load failure: status is 'error', loaded messages & draft stay visible.
    net.pages.A = { ok: false, kind: 'http', status: 500 }
    await a.loadLatest()
    await settle()
    expect(view.last).toMatchObject({
      status: 'error',
      messages: [record(100)],
      draft: 'draft kept across failures',
    })

    // Terminal Channel refusal (C9): status is 'unavailable', messages & draft stay visible, Composer submit is refused.
    net.pages.A = { ok: false, kind: 'http', status: 404 }
    await a.loadLatest()
    await settle()
    expect(view.last).toMatchObject({
      status: 'unavailable',
      messages: [record(100)],
      draft: 'draft kept across failures',
    })
    expect(await a.submit()).toBe(false)
    expect(net.sends).toHaveLength(0)
    expect(view.last.draft).toBe('draft kept across failures')

    // Replacing the session clears drafts as well as loaded records.
    void session.sync.replaceSession('other')
    await settle()
    expect(view.last.draft).toBe('')

    await view.unmount()
    session.close()
  })

  it('types ChannelSync.send from generated SendMessageRequest without hand-written object literals and forwards topic_name', async () => {
    const src = readFileSync(new URL('./sync.svelte.ts', import.meta.url), 'utf8')
    const sf = ts.createSourceFile('sync.svelte.ts', src, ts.ScriptTarget.Latest, true)
    let sendParamType: ts.TypeNode | undefined
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'send' &&
        ts.isArrowFunction(node.initializer)
      ) {
        sendParamType = node.initializer.parameters[1]?.type
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    expect(sendParamType).toBeDefined()
    expect(ts.isTypeLiteralNode(sendParamType!)).toBe(false)
    expect(sendParamType!.getText(sf)).toContain('SendMessageRequest')

    const net = fakeNetwork()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    const { session, sync } = start(net)
    await loadChannels(net)
    net.subscribed('A', 100)
    await settle()

    const a = sync.channel('A')
    void a.send('hello topic', { topic_name: 'Release' })
    await settle()
    expect(net.sends[0]?.body).toEqual({
      client_message_id: 'me-c1',
      body: 'hello topic',
      topic_name: 'Release',
    })
    net.sends[0].resolve(ok(sentBy('me', 101, 'me-c1', 'hello topic')))
    await settle()
    session.close()
  })
})
