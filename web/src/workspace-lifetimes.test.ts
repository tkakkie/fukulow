import { expect, it, vi } from 'vitest'
import * as api from './api'
import { createChannelMembers } from './channel-members'
import type { NavigationTarget } from './navigation-url'
import { makeSearchHit, createMockSearchSource } from './search-test-helpers'
import type { SearchResponse, SearchSource } from './search-source'
import { channelMemberTarget, createSearchRouteSync, openWorkspaceChannelMembers, openWorkspaceSearch } from './workspace-lifetimes'

const main: NavigationTarget = { organizationId: 'org', channelId: 'A', topicId: null, panel: null }

it('closes Search on main-route changes while retaining the controller across panel changes', async () => {
  const source = createMockSearchSource({ hits: [] })
  const scope = { organizationId: 'org', source }
  const resource = openWorkspaceSearch(scope, {
    onOpenResult: vi.fn(),
    onAnnounce: vi.fn(),
    onChannelRevoked: vi.fn(),
  })
  const search = resource.read(scope)!
  const close = vi.fn(search.close)
  const sync = createSearchRouteSync()
  try {
    await search.submit('query')
    sync(main, close)
    sync({ ...main, panel: 'members' }, close)
    expect(close).not.toHaveBeenCalled()
    expect(search.get().open).toBe(true)

    const topic = { ...main, topicId: 'T' }
    sync(topic, close)
    expect(search.get().open).toBe(false)
    sync({ ...topic, channelId: 'B' }, close)
    sync({ ...topic, channelId: 'B', organizationId: 'next' }, close)
    sync(null, close)
    expect(close).toHaveBeenCalledTimes(4)
    expect(resource.read(scope)).toBe(search)
  } finally {
    resource.dispose()
  }
})

it('scopes Search to its Organization and source, forwards revocation, and detaches before aborting', async () => {
  const hit = makeSearchHit(1, { channel_id: 'A', body: 'query' })
  const find = createMockSearchSource({ hits: [hit] })
  const events: string[] = []
  let revoke: ((id: string) => void) | undefined
  let signal: AbortSignal | undefined
  const source: SearchSource = { search: vi.fn(find.search).mockImplementationOnce(find.search).mockImplementationOnce(request => {
    signal = request.signal
    signal?.addEventListener('abort', () => events.push('abort'))
    return new Promise<SearchResponse>(() => {})
  }) }
  const scope = { organizationId: 'org', source }
  const onOpenResult = vi.fn(() => false)
  const onAnnounce = vi.fn()
  const resource = openWorkspaceSearch(scope, {
    onOpenResult,
    onAnnounce,
    onChannelRevoked(listener) {
      revoke = listener
      return () => { events.push('detach'); revoke = undefined }
    },
  })
  const search = resource.read(scope)!
  expect(resource.read({ ...scope, organizationId: 'next' })).toBeUndefined()
  expect(resource.read({ ...scope, source: find })).toBeUndefined()
  await search.submit('query')
  expect(search.get().items).toEqual([hit])
  const target = { channelId: 'A', messageId: hit.message.id, createdSeq: hit.message.created_seq }
  search.openSearchResult(target)
  expect(onOpenResult).toHaveBeenCalledWith('org', target)
  expect(onAnnounce).toHaveBeenCalledWith(search.get().openNotice)

  revoke?.('A')
  expect(search.get().items).toEqual([])
  const pending = search.submit('next query')
  expect(signal?.aborted).toBe(false)
  resource.dispose()
  await pending
  expect(events).toEqual(['detach', 'abort'])
  expect(revoke).toBeUndefined()
  search.openSearchResult(target)
  expect(onOpenResult).toHaveBeenCalledOnce()
})

it('starts the default Search source for the scoped Organization when no source is provided', async () => {
  const searchMessages = vi.spyOn(api, 'searchMessages').mockResolvedValue({ ok: true, data: { hits: [], next_cursor: null } })
  const scope = { organizationId: 'org', source: undefined }
  const resource = openWorkspaceSearch(scope, {
    onOpenResult: vi.fn(),
    onAnnounce: vi.fn(),
    onChannelRevoked: vi.fn(),
  })
  try {
    await resource.read(scope)!.submit('query')
    expect(searchMessages).toHaveBeenCalledExactlyOnceWith('org', { q: 'query' }, undefined, expect.any(AbortSignal))
  } finally {
    resource.dispose()
    searchMessages.mockRestore()
  }
})

it('opens Channel members only for the selected Channel in the members tab', () => {
  const target = (panelOpen: boolean, tab: NavigationTarget['panel'], id?: string, kind: 'channel' | 'dm' = 'channel') =>
    channelMemberTarget(panelOpen, () => tab === 'members' ? tab : 'topics', () => id, () => kind)
  expect(target(false, 'members', 'A')).toBeNull()
  expect(target(true, 'topics', 'A')).toBeNull()
  expect(target(true, 'members')).toBeNull()
  expect(target(true, 'members', 'A', 'dm')).toBeNull()
  expect(target(true, 'members', 'A')).toBe('A')
  expect(target(true, 'members', 'B')).toBe('B')
})

it('loads the directory before opening Channel members and disposes each scoped controller', () => {
  const events: string[] = []
  const open = vi.fn((id: string) => {
    events.push(`open:${id}`)
    const controller = createChannelMembers('org', id, vi.fn())
    const close = controller.close
    vi.spyOn(controller, 'close').mockImplementation(() => { events.push(`close:${id}`); close() })
    return controller
  })
  const load = () => { events.push('directory') }
  const scope = { session: {}, organizationId: 'org', channelId: 'A' }
  expect(openWorkspaceChannelMembers({ ...scope, channelId: null }, open, load)).toBeUndefined()
  expect(openWorkspaceChannelMembers(scope, undefined, load)).toBeUndefined()
  expect(events).toEqual([])

  const first = openWorkspaceChannelMembers(scope, open, load)!
  expect(first.read(scope)).toBe(open.mock.results[0].value)
  const next = { ...scope, channelId: 'B' }
  expect(first.read(next)).toBeUndefined()
  expect(first.read({ ...scope, organizationId: 'next' })).toBeUndefined()
  expect(first.read({ ...scope, session: {} })).toBeUndefined()
  first.dispose()

  const second = openWorkspaceChannelMembers(next, open, load)!
  expect(second.read(next)).toBe(open.mock.results[1].value)
  second.dispose()
  expect(events).toEqual(['directory', 'open:A', 'close:A', 'directory', 'open:B', 'close:B'])
})
