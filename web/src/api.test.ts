import { describe, expect, it, vi } from 'vitest'
import { checkHealth } from './api'

describe('checkHealth', () => {
  it('is true when the server responds ok', async () => {
    const f = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    expect(await checkHealth(f)).toBe(true)
    expect(f).toHaveBeenCalledWith('/api/v1/health')
  })

  it('is false on an error status', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    expect(await checkHealth(f)).toBe(false)
  })

  it('is false when the request fails', async () => {
    const f = vi.fn().mockRejectedValue(new Error('network'))
    expect(await checkHealth(f)).toBe(false)
  })
})

import { createChannel, listChannels, listMessages, sendMessage } from './api'

describe('channel and message calls', () => {
  const f = () => vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
  it('lists channels', async () => {
    const m = f()
    await listChannels(m)
    expect(m).toHaveBeenCalledWith('/api/v1/channels', expect.objectContaining({ credentials: 'same-origin' }))
  })
  it('creates a channel with a JSON body', async () => {
    const m = f()
    await createChannel({ name: 'a', visibility: 'public' }, m)
    const [url, init] = m.mock.calls[0]
    expect([url, init.method, init.body]).toEqual(['/api/v1/channels', 'POST', '{"name":"a","visibility":"public"}'])
  })
  it('builds the message query from cursors only', async () => {
    const m = f()
    await listMessages('c 1', { before_seq: 5, limit: undefined }, m)
    expect(m.mock.calls[0][0]).toBe('/api/v1/channels/c%201/messages?before_seq=5')
    await listMessages('c', {}, m)
    expect(m.mock.calls[1][0]).toBe('/api/v1/channels/c/messages')
  })
  it('sends a message', async () => {
    const m = f()
    await sendMessage('c', { body: 'x', client_message_id: 'i' }, m)
    expect(m.mock.calls[0][0]).toBe('/api/v1/channels/c/messages')
    expect(m.mock.calls[0][1].method).toBe('POST')
  })
  it('treats admission 503 as retryable and preserves the send key', async () => {
    const m = vi.fn().mockResolvedValue(new Response('{"error":"send admission unavailable"}', {
      status: 503, headers: { 'Retry-After': '3' },
    }))
    const input = { body: 'x', client_message_id: 'same-key' }
    expect(await sendMessage('c', input, m)).toEqual({ ok: false, kind: 'network' })
    expect(JSON.parse(m.mock.calls[0][1].body)).toEqual(input)
  })
})
