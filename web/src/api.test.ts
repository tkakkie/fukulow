import { describe, expect, it, vi } from 'vitest'
import { checkHealth, lookupAuthors } from './api'

it('looks up display identities in the selected Organization using generated request and response types', async () => {
  const identities = [{ id: 'author', name: '名前', deactivated: true }]
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ identities }), { status: 200 }))
  expect(await lookupAuthors('org/1', { ids: ['author'] }, fetcher)).toEqual({ ok: true, data: { identities } })
  expect(fetcher).toHaveBeenCalledWith('/api/v1/orgs/org%2F1/message-authors', {
    credentials: 'same-origin', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['author'] }),
  })
})

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
  it('preserves 429 ErrorBody and Retry-After with a safe one-second fallback', async () => {
    for (const [header, retryAfterMs] of [
      ['3', 3000], ['1', 1000], [null, 1000], ['', 1000], ['0', 1000], ['-1', 1000],
      ['1.5', 1000], ['NaN', 1000], ['Infinity', 1000], ['1e3', 1000],
      ['Thu, 01 Jan 2099 00:00:00 GMT', 1000], ['999999999999999999999999', 1000],
    ] as const) {
      const m = vi.fn().mockResolvedValue(new Response('{"error":"send_rate_limited"}', {
        status: 429, headers: header === null ? {} : { 'Retry-After': header! },
      }))
      expect(await sendMessage('o', 'c', { body: 'x', client_message_id: 'same-key' }, m)).toEqual({
        ok: false, kind: 'http', status: 429, error: 'send_rate_limited', retryAfterMs,
      })
    }
  })
  it('retains the 429 delay even when ErrorBody is malformed', async () => {
    const m = vi.fn().mockResolvedValue(new Response('broken', { status: 429, headers: { 'Retry-After': '2' } }))
    expect(await sendMessage('o', 'c', { body: 'x', client_message_id: 'same-key' }, m)).toEqual({
      ok: false, kind: 'http', status: 429, retryAfterMs: 2000,
    })
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

it('deactivates a scoped Member with a bodyless POST and accepts empty 204', async () => {
  const { deactivateMember } = await import('./api')
  const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  expect(await deactivateMember('org 1', 'member 1', f)).toEqual({ ok: true, data: undefined })
  expect(f).toHaveBeenCalledWith('/api/v1/orgs/org%201/members/member%201/deactivate', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
  expect(f.mock.calls[0][1].body).toBeUndefined()
})

import { putPassword, revokeOtherSessions } from './api'

it('passes the activity GET cancellation signal to fetch', async () => {
  const { listMembers } = await import('./api')
  const controller = new AbortController()
  const f = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  await getOrganizationMe('o', f, controller.signal)
  await listChannels('o', f, controller.signal)
  await listMembers('o', f, controller.signal)
  await listChannelMembers('o', 'c', f, controller.signal)
  await listTopics('o', 'c', {}, f, controller.signal)
  await getTopicSummary('o', 'c', 't', f, controller.signal)
  expect(f).toHaveBeenCalledTimes(6)
  for (const [, init] of f.mock.calls) expect(init?.signal).toBe(controller.signal)
})

it('uses generated account security bodies with PUT or POST and preserves 403 without ending the session', async () => {
  const current_password = 'current password'
  const passwordBody = { current_password, new_password: 'new password' }
  for (const { run, path, method, body } of [
    { run: (f: typeof fetch) => putPassword(passwordBody, f), path: '/api/v1/me/password', method: 'PUT', body: passwordBody },
    { run: (f: typeof fetch) => revokeOtherSessions({ current_password }, f), path: '/api/v1/me/sessions/revoke-others', method: 'POST', body: { current_password } },
  ]) {
    const f = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'current_password_incorrect' }), { status: 403 }))
    expect(await run(f)).toEqual({ ok: false, kind: 'http', status: 403, error: 'current_password_incorrect' })
    expect(f).toHaveBeenCalledWith(path, expect.objectContaining({ method, credentials: 'same-origin', body: JSON.stringify(body) }))
    f.mockResolvedValue(new Response(null, { status: 204 }))
    expect(await run(f)).toEqual({ ok: true, data: undefined })
  }
})
