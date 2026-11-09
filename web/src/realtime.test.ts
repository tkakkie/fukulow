import { describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from './api'
import { createRealtime, type SocketLike } from './realtime'

class FakeSocket implements SocketLike {
  sent: unknown[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  send(d: string) { this.sent.push(JSON.parse(d)) }
  close() { this.closed = true }
  open() { this.onopen?.() }
  emit(e: ServerEvent | string) { this.onmessage?.({ data: typeof e === 'string' ? e : JSON.stringify(e) }) }
  drop(code: number) { this.onclose?.({ code }) }
}

function setup(cursors: Record<string, number> = {}) {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const onEvent = vi.fn()
  const onSessionEnded = vi.fn()
  const rt = createRealtime({
    onEvent,
    onSessionEnded,
    cursor: (id) => cursors[id] ?? 0,
    open: () => { const s = new FakeSocket(); sockets.push(s); return s },
    delay: (n) => 100 * (n + 1),
    schedule: (fn, ms) => { timers.push({ fn, ms }) },
  })
  return { rt, sockets, timers, onEvent, onSessionEnded, cursors }
}
const sub = (channel_id: string, after_seq: number) => ({ type: 'subscribe', channel_id, after_seq })

describe('realtime', () => {
  it('subscribes from the cursor once connected, and tracks confirmation', () => {
    const { rt, sockets, cursors } = setup({ a: 7 })
    rt.watch('a') // before open: queued
    expect(sockets[0].sent).toEqual([])
    sockets[0].open()
    expect(sockets[0].sent).toEqual([sub('a', 7)])
    expect(rt.get().connected).toBe(true)
    cursors.b = 3
    rt.watch('b')
    rt.watch('b')
    expect(sockets[0].sent).toEqual([sub('a', 7), sub('b', 3)])
    sockets[0].emit({ type: 'subscribed', channel_id: 'a', caught_up_seq: 7 })
    expect([...rt.get().subscribed]).toEqual(['a'])
  })

  it('reconnects at once after 4008 and resubscribes from the then-current cursor', () => {
    const { rt, sockets, timers, cursors } = setup({ a: 7 })
    sockets[0].open()
    rt.watch('a')
    sockets[0].emit({ type: 'subscribed', channel_id: 'a', caught_up_seq: 7 })
    cursors.a = 9 // messages arrived before the overflow
    sockets[0].drop(4008)
    expect(rt.get()).toMatchObject({ connected: false })
    expect(rt.get().subscribed.size).toBe(0)
    expect(timers.map((t) => t.ms)).toEqual([0])
    timers[0].fn()
    sockets[1].open()
    expect(sockets[1].sent).toEqual([sub('a', 9)])
  })

  it('backs off on other closes and resets after a successful open', () => {
    const { sockets, timers } = setup()
    sockets[0].drop(1006)
    timers[0].fn()
    sockets[1].drop(1006)
    expect(timers.map((t) => t.ms)).toEqual([100, 200])
    timers[1].fn()
    sockets[2].open()
    sockets[2].drop(1006)
    expect(timers[2].ms).toBe(100)
  })

  it('on 4001 reports the ended session and never reconnects', () => {
    const { sockets, timers, onSessionEnded } = setup()
    sockets[0].open()
    sockets[0].drop(4001)
    expect(onSessionEnded).toHaveBeenCalledOnce()
    expect(timers).toEqual([])
    expect(sockets).toHaveLength(1)
  })

  it('forwards events, ignores malformed frames, and stops after close', () => {
    const { rt, sockets, timers, onEvent } = setup()
    sockets[0].open()
    sockets[0].emit('not json')
    sockets[0].emit('{"x":1}')
    const ev = { type: 'error', code: 'x' } as ServerEvent
    sockets[0].emit(ev)
    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith(ev)
    rt.close()
    expect(sockets[0].closed).toBe(true)
    sockets[0].drop(1000)
    expect(timers).toEqual([])
  })

  it('unwatch sends unsubscribe and is not resubscribed after reconnect', () => {
    const { rt, sockets, timers } = setup()
    sockets[0].open()
    rt.watch('a')
    rt.unwatch('a')
    expect(sockets[0].sent).toEqual([sub('a', 0), { type: 'unsubscribe', channel_id: 'a' }])
    sockets[0].drop(1006)
    timers[0].fn()
    sockets[1].open()
    expect(sockets[1].sent).toEqual([])
  })
})
