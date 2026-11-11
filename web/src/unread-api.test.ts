import { expect, it, vi } from 'vitest'
import { listChannels, markChannelRead, markTopicRead } from './api'
import { unreadApi } from './unread'

it('calls generated Unread endpoints with cookie auth encoded scope PUT fixed body and no-store list', async () => {
  const f = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{"read_seq":7}'))
  expect(await markChannelRead('o /', 'c /', { read_seq: 7 }, f)).toEqual({ ok: true, data: { read_seq: 7 } })
  await markTopicRead('o /', 'c /', 't /', { read_seq: 7 }, f); await listChannels('o /', f)
  expect(f.mock.calls.map(call => call[0])).toEqual(['/api/v1/orgs/o%20%2F/channels/c%20%2F/read',
    '/api/v1/orgs/o%20%2F/channels/c%20%2F/topics/t%20%2F/read', '/api/v1/orgs/o%20%2F/channels'])
  expect(f.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: '{"read_seq":7}', credentials: 'same-origin' })
  expect(f.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: '{"read_seq":7}', credentials: 'same-origin' })
  expect(f.mock.calls[2][1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
  f.mockClear(); vi.stubGlobal('fetch', f)
  try {
    const client = unreadApi('o')
    await client.markRead({ channel: 'c', topicId: null }, { read_seq: 7 })
    await client.markRead({ channel: 'c', topicId: 't' }, { read_seq: 7 })
    await client.listChannels(); await client.getTopicSummary('c', 't')
    expect(f.mock.calls.map(call => call[0])).toEqual(['/api/v1/orgs/o/channels/c/read', '/api/v1/orgs/o/channels/c/topics/t/read',
      '/api/v1/orgs/o/channels', '/api/v1/orgs/o/channels/c/topics/t'])
  } finally { vi.unstubAllGlobals() }
})
it('preserves server denials and Retry-After seconds or HTTP date for uncertain Unread requests', async () => {
  const f = vi.fn(async () => new Response('{"error":"topic_not_found"}', { status: 404 }))
  expect(await markTopicRead('o', 'c', 't', { read_seq: 7 }, f)).toEqual({ ok: false, kind: 'http', status: 404, error: 'topic_not_found' })
  const date = new Date(Date.now() + 5000).toUTCString()
  for (const header of ['3', date, 'invalid']) {
    const r = await markChannelRead('o', 'c', { read_seq: 7 }, async () => new Response('', { status: 503, headers: { 'Retry-After': header } }))
    if (header === 'invalid') expect(r).toEqual({ ok: false, kind: 'network' })
    else { expect(r).toMatchObject({ ok: false, kind: 'network' }); if (!r.ok && r.kind === 'network') expect(r.retryAfterMs).toBeGreaterThanOrEqual(3000) }
  }
})
