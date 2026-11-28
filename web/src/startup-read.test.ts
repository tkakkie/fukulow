import { expect, it, vi } from 'vitest'
import type { ChannelList, Result, StartupResponse, TimelinePage } from './api'
import { startInitialSelection } from './initial-timeline'
import { deferred } from './topic-test-helpers'

const channel = 'c'
const history_generation = 'generation'
const list: ChannelList = { history_generation, channels: [] }
const page: TimelinePage = { history_generation, as_of_seq: 7, items: [], has_more: false }
const identities = [{ id: 'former-member', name: 'Author', deactivated: true }]

function start(loadStartup: () => Promise<Result<StartupResponse>>) {
  const loadChannels = vi.fn(async (): Promise<Result<ChannelList>> => ({ ok: true, data: list }))
  const load = vi.fn(async (): Promise<Result<TimelinePage>> => ({ ok: true, data: page }))
  const onEnded = vi.fn()
  const onUnavailableBeforeSession = vi.fn()
  const onAuthors = vi.fn()
  const selection = startInitialSelection({
    organizationId: 'o',
    route: () => ({ organizationId: 'o', channelId: channel, topicId: null, panel: null }),
    accountSignal: new AbortController().signal,
    load, loadStartup, loadChannels, onEnded, onUnavailableBeforeSession, onAuthors,
  })
  return { ...selection, get unavailable() { return selection.unavailable }, load, loadChannels, onEnded, onUnavailableBeforeSession, onAuthors }
}

it('falls back to the individual startup reads', async () => {
  const s = start(async () => ({ ok: false, kind: 'network' }))
  try {
    const candidate = s.initialTimeline?.take(channel)
    expect(await s.initialChannels).toEqual({ ok: true, data: list })
    expect(await candidate?.result).toEqual({ ok: true, data: page })
    expect(s.loadChannels).toHaveBeenCalledExactlyOnceWith('o', expect.any(AbortSignal))
    expect(s.load).toHaveBeenCalledExactlyOnceWith('o', 'c', { history_generation: undefined }, undefined, expect.any(AbortSignal))
    candidate?.accept?.(page)
    expect(s.onAuthors).not.toHaveBeenCalled()
  } finally { s.close() }
})

it('seeds authors only when the matching startup page is accepted', async () => {
  const s = start(async () => ({ ok: true, data: { channel_list: list, timeline: { channel_id: channel, page, authors: { identities } } } }))
  try {
    const candidate = s.initialTimeline?.take(channel)
    expect(await s.initialChannels).toEqual({ ok: true, data: list })
    expect(await candidate?.result).toEqual({ ok: true, data: page })
    expect(s.onAuthors).not.toHaveBeenCalled()
    candidate?.accept?.(page)
    expect(s.onAuthors).toHaveBeenCalledExactlyOnceWith(identities)
    expect(s.load).not.toHaveBeenCalled()
    expect(s.loadChannels).not.toHaveBeenCalled()
  } finally { s.close() }
})

it('discards the startup page and authors across Channel selection', async () => {
  const held = deferred<Result<StartupResponse>>()
  const s = start(() => held.promise)
  try {
    const candidate = s.initialTimeline?.take(channel)
    s.initialTimeline?.select('other')
    s.initialTimeline?.select(channel)
    held.resolve({ ok: true, data: { channel_list: list, timeline: { channel_id: channel, page, authors: { identities } } } })
    expect(await s.initialChannels).toEqual({ ok: true, data: list })
    expect(await candidate?.result).toBeUndefined()
    candidate?.accept?.(page)
    expect(s.onAuthors).not.toHaveBeenCalled()
  } finally { s.close() }
})

it('observes a late startup 401 after the Organization selection closes', async () => {
  const held = deferred<Result<StartupResponse>>()
  const s = start(() => held.promise)
  s.close()
  held.resolve({ ok: false, kind: 'http', status: 401 })
  await s.startupReady
  expect(s.onEnded).toHaveBeenCalledOnce()
  expect(s.loadChannels).not.toHaveBeenCalled()
  expect(s.load).not.toHaveBeenCalled()
})

it('keeps startup Organization loss terminal within its selection', async () => {
  const s = start(async () => ({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' }))
  try {
    await s.startupReady
    expect(s.onUnavailableBeforeSession).toHaveBeenCalledOnce()
    expect(s.unavailable).toBe(true)
    expect(s.onEnded).not.toHaveBeenCalled()
    expect(s.loadChannels).not.toHaveBeenCalled()
    expect(s.load).not.toHaveBeenCalled()
  } finally { s.close() }
})

it('preserves a startup Channel denial while falling back to the Channel list', async () => {
  const denial = { ok: false, kind: 'http', status: 404, error: 'channel not found' } as const
  const s = start(async () => denial)
  try {
    const candidate = s.initialTimeline?.take(channel)
    expect(await s.initialChannels).toEqual({ ok: true, data: list })
    expect(await candidate?.result).toEqual(denial)
    expect(s.load).not.toHaveBeenCalled()
  } finally { s.close() }
})
