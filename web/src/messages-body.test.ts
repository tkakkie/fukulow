import openapiRaw from '../../openapi.json?raw'
import { describe, expect, it, vi } from 'vitest'
import { createSync, MESSAGE_BODY_MAX, messageBodyError } from './sync'

const samples: [string, string][] = [
  ['ASCII', 'a'],
  ['CJK', '漢'],
  ['4-byte', '😀'],
]

describe('message body validation', () => {
  it('matches openapi.json SendMessageRequest.body rules', () => {
    const spec = JSON.parse(openapiRaw)
    const body = spec.components.schemas.SendMessageRequest.properties.body
    expect(body.maxLength).toBe(MESSAGE_BODY_MAX)
    expect(body.minLength).toBe(1)
    expect(body.description).toContain('Unicode scalar values')
    expect(body.description).toContain('no NUL')
    expect(body.description).toContain('Stored without trimming')
  })

  for (const [label, ch] of samples) {
    it(`${label}: 3999 and 4000 scalars pass, 4001 fails`, () => {
      expect(messageBodyError(ch.repeat(3999))).toBeNull()
      expect(messageBodyError(ch.repeat(4000))).toBeNull()
      expect(messageBodyError(ch.repeat(4001))).toMatch(/4000/)
    })
  }

  it('rejects NUL and lone UTF-16 surrogates', () => {
    expect(messageBodyError('\0')).toMatch(/NUL/)
    expect(messageBodyError('hello\0world')).toMatch(/NUL/)
    expect(messageBodyError('a\ud800b')).not.toBeNull()
    expect(messageBodyError('a\udfffb')).not.toBeNull()
  })

  it('keeps draft text and skips HTTP when Composer validation fails, then clears on valid submit', async () => {
    const sendMessage = vi.fn().mockImplementation(async (_channel, req) => ({
      ok: true,
      data: {
        id: 'm1',
        channel_id: 'A',
        sender: 'me',
        client_message_id: req.client_message_id,
        seq: 1,
        body: req.body,
        created_at: '2026-01-01T00:00:00Z',
      },
    }))
    const sync = createSync({
      selfId: 'me',
      newId: () => 'c1',
      connect: () => ({ send() {}, close() {} }),
      api: { listMessages: vi.fn(), sendMessage },
    })
    await sync.start()
    const a = sync.getTimeline('A')

    const overLimit = '😀'.repeat(MESSAGE_BODY_MAX + 1)
    a.setDraft(overLimit)
    expect(await a.submit()).toBe(false)
    expect(a.get().draft).toBe(overLimit)
    expect(a.get().composerError).toMatch(/4000/)
    expect(sendMessage).not.toHaveBeenCalled()

    const withNul = 'bad\0text'
    a.setDraft(withNul)
    expect(a.get().composerError).toBeNull()
    expect(await a.submit()).toBe(false)
    expect(a.get().draft).toBe(withNul)
    expect(a.get().composerError).toMatch(/NUL/)
    expect(sendMessage).not.toHaveBeenCalled()

    expect(await a.send(overLimit)).toBe(false)
    expect(await a.send(withNul)).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()

    const exact = '😀'.repeat(MESSAGE_BODY_MAX)
    a.setDraft(exact)
    expect(a.get().composerError).toBeNull()
    expect(await a.submit()).toBe(true)
    expect(a.get().draft).toBe('')
    expect(a.get().composerError).toBeNull()
    expect(sendMessage).toHaveBeenCalledWith('A', { client_message_id: 'c1', body: exact })
    await sync.close()
  })
})
