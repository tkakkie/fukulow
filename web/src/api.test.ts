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
    await listChannels('o', m)
    expect(m).toHaveBeenCalledWith('/api/v1/orgs/o/channels', expect.objectContaining({ credentials: 'same-origin' }))
  })
  it('creates a channel with a JSON body', async () => {
    const m = f()
    await createChannel('o', { name: 'a', visibility: 'public' }, m)
    const [url, init] = m.mock.calls[0]
    expect([url, init.method, init.body]).toEqual(['/api/v1/orgs/o/channels', 'POST', '{"name":"a","visibility":"public"}'])
  })
  it('builds the message query from cursors only', async () => {
    const m = f()
    await listMessages('o', 'c 1', { before_seq: 5, limit: undefined }, m)
    expect(m.mock.calls[0][0]).toBe('/api/v1/orgs/o/channels/c%201/messages?before_seq=5')
    await listMessages('o', 'c', {}, m)
    expect(m.mock.calls[1][0]).toBe('/api/v1/orgs/o/channels/c/messages')
  })
  it('sends a message', async () => {
    const m = f()
    await sendMessage('o', 'c', { body: 'x', client_message_id: 'i' }, m)
    expect(m.mock.calls[0][0]).toBe('/api/v1/orgs/o/channels/c/messages')
    expect(m.mock.calls[0][1].method).toBe('POST')
  })
  it('treats admission 503 as retryable and preserves the send key', async () => {
    const m = vi.fn().mockResolvedValue(new Response('{"error":"send admission unavailable"}', {
      status: 503, headers: { 'Retry-After': '3' },
    }))
    const input = { body: 'x', client_message_id: 'same-key' }
    expect(await sendMessage('o', 'c', input, m)).toEqual({ ok: false, kind: 'network', retryAfterMs: 3000 })
    expect(m.mock.calls[0][0]).toBe('/api/v1/orgs/o/channels/c/messages')
    expect(JSON.parse(m.mock.calls[0][1].body)).toEqual(input)
  })
})

import { getOrganizationMe, isOrganizationUnavailable, postSession } from './api'

it('uses Account sign-in without an Organization and encodes the Organization-scoped identity path', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
  await postSession({ email: 'a@example.com', password: 'passwordpassword' }, fetcher)
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ email: 'a@example.com', password: 'passwordpassword' })
  await getOrganizationMe('o /1', fetcher)
  expect(fetcher.mock.calls[1][0]).toBe('/api/v1/orgs/o%20%2F1/me')
})

it('preserves ErrorBody codes and only the exact 404 organization_unavailable means Membership loss', async () => {
  for (const [status, error, unavailable] of [
    [404, 'organization_unavailable', true],
    [403, 'origin_not_allowed', false],
    [404, 'channel_not_found', false],
    [403, 'organization_unavailable', false],
  ] as const) {
    const result = await getOrganizationMe('o', vi.fn(async () => new Response(JSON.stringify({ error }), { status })))
    expect(result).toEqual({ ok: false, kind: 'http', status, error })
    expect(isOrganizationUnavailable(result)).toBe(unavailable)
  }
})

import { getTopicSummary, listTimeline, listTopics, listTopicMessages } from './api'

it('encodes Topic projection paths and generated query fields, preserving zero W and omitted cursors', async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'))
  await listTimeline('o /1', 'c/2', { as_of_seq: 0, before_position: 8, limit: undefined }, f)
  await listTopics('o /1', 'c/2', { as_of_seq: 10, before_position: 7, limit: 3 }, f)
  await getTopicSummary('o /1', 'c/2', 't /3', f)
  await listTopicMessages('o /1', 'c/2', 't /3', { after_seq: 0, limit: 2 }, f)
  await listTimeline('o', 'c', {}, f)
  expect(f.mock.calls.map(([path]) => path)).toEqual([
    '/api/v1/orgs/o%20%2F1/channels/c%2F2/timeline?as_of_seq=0&before_position=8',
    '/api/v1/orgs/o%20%2F1/channels/c%2F2/topics?as_of_seq=10&before_position=7&limit=3',
    '/api/v1/orgs/o%20%2F1/channels/c%2F2/topics/t%20%2F3',
    '/api/v1/orgs/o%20%2F1/channels/c%2F2/topics/t%20%2F3/messages?after_seq=0&limit=2',
    '/api/v1/orgs/o/channels/c/timeline',
  ])
  for (const [, init] of f.mock.calls) expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
})

import { addChannelMember, changeChannelManager, listChannelMembers, listReplyChain, removeChannelMember } from './api'

it('encodes Reply chain anchors and exclusive continuation using generated query fields', async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'))
  await listReplyChain('o /1', 'c/2', 'm /3', { after_seq: 0, limit: 2 }, f)
  await listReplyChain('o', 'c', 'm', { after_seq: 7, limit: undefined }, f)
  expect(f.mock.calls.map(([path]) => path)).toEqual([
    '/api/v1/orgs/o%20%2F1/channels/c%2F2/messages/m%20%2F3/chain?after_seq=0&limit=2',
    '/api/v1/orgs/o/channels/c/messages/m/chain?after_seq=7',
  ])
  for (const [, init] of f.mock.calls) expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
})

it('encodes Channel Member list, add, remove and manager PATCH with 204 success', async () => {
  const f = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{"members":[{"id":"m1","name":"田中","role":"member","manager":true}]}', { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  expect(await listChannelMembers('o /1', 'c/2', f)).toEqual({
    ok: true,
    data: { members: [{ id: 'm1', name: '田中', role: 'member', manager: true }] },
  })
  expect(await addChannelMember('o /1', 'c/2', { member_id: 'm /3' }, f)).toEqual({ ok: true, data: undefined })
  expect(await removeChannelMember('o /1', 'c/2', 'm /3', f)).toEqual({ ok: true, data: undefined })
  expect(await changeChannelManager('o /1', 'c/2', 'm /3', { manager: true }, f)).toEqual({ ok: true, data: undefined })
  expect(await changeChannelManager('o', 'c', 'm1', { manager: false }, f)).toEqual({ ok: true, data: undefined })
  expect(f.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET', init?.body])).toEqual([
    ['/api/v1/orgs/o%20%2F1/channels/c%2F2/members', 'GET', undefined],
    ['/api/v1/orgs/o%20%2F1/channels/c%2F2/members', 'POST', '{"member_id":"m /3"}'],
    ['/api/v1/orgs/o%20%2F1/channels/c%2F2/members/m%20%2F3', 'DELETE', undefined],
    ['/api/v1/orgs/o%20%2F1/channels/c%2F2/members/m%20%2F3', 'PATCH', '{"manager":true}'],
    ['/api/v1/orgs/o/channels/c/members/m1', 'PATCH', '{"manager":false}'],
  ])
})
