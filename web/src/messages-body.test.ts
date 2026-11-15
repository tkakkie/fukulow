import type { Message, Result } from './api'
import type { TimelineApi } from './sync'
import openapiRaw from '../../openapi.json?raw'
import { describe, expect, it, vi } from 'vitest'
import { createDraftStore } from './drafts'
import { initialState, step } from './protocol'
import { createSync, MESSAGE_BODY_MAX, messageBodyError, TOPIC_NAME_MAX, topicNameError } from './sync'

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
    const sendMessage = vi.fn<TimelineApi['sendMessage']>().mockImplementation(async (_channel, req) => ({
      ok: true,
      data: {
        mentions: [],
        topic_id: null,
        reply_to: null,
        reply_root_id: null,
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
    expect(a.composer.get().draft).toBe(overLimit)
    expect(a.composer.get().composerError).toMatch(/4000/)
    expect(sendMessage).not.toHaveBeenCalled()

    const withNul = 'bad\0text'
    a.setDraft(withNul)
    expect(a.composer.get().composerError).toBeNull()
    expect(await a.submit()).toBe(false)
    expect(a.composer.get().draft).toBe(withNul)
    expect(a.composer.get().composerError).toMatch(/NUL/)
    expect(sendMessage).not.toHaveBeenCalled()

    expect(await a.send(overLimit)).toBe(false)
    expect(await a.send(withNul)).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()

    const exact = '😀'.repeat(MESSAGE_BODY_MAX)
    a.setDraft(exact)
    expect(a.composer.get().composerError).toBeNull()
    expect(await a.submit()).toBe(true)
    expect(a.composer.get().draft).toBe('')
    expect(a.composer.get().composerError).toBeNull()
    expect(sendMessage).toHaveBeenCalledWith('A', { client_message_id: 'c1', body: exact })
    await sync.close()
  })
})

describe('Topic name validation and Topic Composer sends/drafts', () => {
  it('matches openapi.json SendMessageRequest.topic_name rules', () => {
    const spec = JSON.parse(openapiRaw)
    const topicName = spec.components.schemas.SendMessageRequest.properties.topic_name
    expect(topicName.maxLength).toBe(TOPIC_NAME_MAX)
    expect(topicName.minLength).toBe(1)
    expect(topicName.description).toContain('1..=60 Unicode scalars')
    expect(topicName.description).toContain('no NUL')
    expect(topicName.description).toContain('surrounding/only trim whitespace')
  })

  for (const [label, ch] of samples) {
    it(`${label}: 59 and 60 scalars pass, 61 fails`, () => {
      expect(topicNameError(ch.repeat(59))).toBeNull()
      expect(topicNameError(ch.repeat(60))).toBeNull()
      expect(topicNameError(ch.repeat(61))).toMatch(/60/)
    })
  }

  it('rejects NUL, lone surrogates, and surrounding or whitespace-only Topic names while allowing inner spaces', () => {
    expect(topicNameError('')).not.toBeNull()
    expect(topicNameError(' 日報')).not.toBeNull()
    expect(topicNameError('日報 ')).not.toBeNull()
    expect(topicNameError('\u3000日報')).not.toBeNull()
    expect(topicNameError('   ')).not.toBeNull()
    expect(topicNameError('日\0報')).toMatch(/NUL/)
    expect(topicNameError('a\ud800b')).not.toBeNull()
    expect(topicNameError('週次 ミーティング')).toBeNull()
  })

  it('protocol rejects reply_to combined with topic_name (P7) and preserves topic_name on C6 retry', () => {
    let s = step(initialState(), { type: 'session_start', selfId: 'me' }).state
    const rejected = step(s, {
      type: 'user_send',
      channel: 'A',
      clientMessageId: 'bad-1',
      body: 'hi',
      reply_to: 'parent-1',
      topic_name: '日報',
    })
    expect(rejected.effects).toEqual([])
    expect(rejected.state).toBe(s)

    const sent = step(s, {
      type: 'user_send',
      channel: 'A',
      clientMessageId: 'c-topic',
      body: 'first post',
      topic_name: '日報',
    })
    expect(sent.effects).toEqual([
      {
        type: 'send',
        id: expect.any(Number),
        channel: 'A',
        client_message_id: 'c-topic',
        body: 'first post',
        topic_name: '日報',
      },
    ])
    const reqId = (sent.effects[0] as { id: number }).id
    s = step(sent.state, { type: 'send_failed', request: reqId, status: 'network' }).state
    const retried = step(s, { type: 'user_retry', channel: 'A', clientMessageId: 'c-topic' })
    expect(retried.effects).toEqual([
      {
        type: 'send',
        id: expect.any(Number),
        channel: 'A',
        client_message_id: 'c-topic',
        body: 'first post',
        topic_name: '日報',
      },
    ])
  })

  it('isolates Channel topicDraft and per-Topic drafts, forwards topic_name, and restores on failure', async () => {
    const drafts = createDraftStore()
    let idSeq = 0
    const sendMessage = vi.fn<TimelineApi['sendMessage']>()
    const sync = createSync({
      selfId: 'me',
      organizationId: 'org-1',
      drafts,
      newId: () => `cid-${++idSeq}`,
      connect: () => ({ send() {}, close() {} }),
      api: { listMessages: vi.fn(), sendMessage },
    })
    await sync.start()
    const a = sync.getTimeline('A')
    const topicT = a.topic('topic-1')

    // Invalid surrounding whitespace in topicDraft blocks HTTP and preserves both fields
    a.setTopicDraft(' 日報 ')
    a.setDraft('最初の投稿')
    expect(sync.hasUnsavedChanges()).toBe(true)
    expect(await a.submit()).toBe(false)
    expect(a.composer.get().composerError).toMatch(/60/)
    expect(a.composer.get().draft).toBe('最初の投稿')
    expect(a.composer.get().topicDraft).toBe(' 日報 ')
    expect(sendMessage).not.toHaveBeenCalled()

    // Valid new-Topic submit clears draft + topicDraft, forwards topic_name, and restores both on 400 refusal + restore()
    a.setTopicDraft('日報')
    sendMessage.mockResolvedValueOnce({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    expect(await a.submit()).toBe(true)
    expect(sendMessage).toHaveBeenLastCalledWith('A', {
      client_message_id: 'cid-1',
      body: '最初の投稿',
      topic_name: '日報',
    })
    expect(a.get().pending).toMatchObject([{ clientMessageId: 'cid-1', topicName: '日報', status: 'failed' }])
    expect(a.restore('cid-1')).toBe(true)
    expect(a.composer.get().draft).toBe('最初の投稿')
    expect(a.composer.get().topicDraft).toBe('日報')

    // Per-Topic Composer uses isolated DraftStore key and tags pending sends with topicId
    topicT.setDraft('トピック別下書き')
    expect(drafts.get({ organizationId: 'org-1', channelId: 'A', topicId: 'topic-1' })).toBe('トピック別下書き')
    expect(a.composer.get().draft).toBe('最初の投稿')

    let resolveTopicSend!: (res: Result<Message>) => void
    sendMessage.mockReturnValueOnce(new Promise(r => { resolveTopicSend = r }))
    const submitting = topicT.submit('仕様相談')
    expect(topicT.get().draft).toBe('')
    expect(a.get().pending).toMatchObject([
      { clientMessageId: 'cid-2', body: 'トピック別下書き', topicName: '仕様相談', topicId: 'topic-1', status: 'sending' },
    ])
    resolveTopicSend({
      ok: true,
      data: {
        mentions: [],
        id: 'm-2',
        channel_id: 'A',
        sender: 'me',
        client_message_id: 'cid-2',
        seq: 2,
        body: 'トピック別下書き',
        topic_id: 'topic-1',
        reply_to: null,
        reply_root_id: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    })
    expect(await submitting).toBe(true)
    await sync.close()
  })
})
