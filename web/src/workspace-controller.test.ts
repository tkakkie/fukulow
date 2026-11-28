import { expect, it, vi } from 'vitest'
import type { NavigationTarget } from './navigation-url'
import type { SearchTarget } from './search'
import { createWorkspaceController } from './workspace-controller'

const route: NavigationTarget = { organizationId: 'org', channelId: 'A', topicId: null, panel: null }

it('initializes from a ready Channel list and follows only a different Channel in the current Organization URL', () => {
  const workspace = createWorkspaceController()
  const initialize = vi.fn()
  const selectHint = vi.fn()
  const selected = vi.fn(() => 'A')
  workspace.initialize('loading', () => 'org', selected, initialize)
  workspace.initialize('ready', () => '', selected, initialize)
  expect(selected).not.toHaveBeenCalled()
  expect(initialize).not.toHaveBeenCalled()
  workspace.initialize('ready', () => 'org', selected, initialize)
  workspace.initialize('ready', () => 'org', () => null, initialize)
  expect(initialize.mock.calls).toEqual([[route], [{ ...route, channelId: null }]])

  selected.mockClear()
  workspace.syncSelection('loading', () => ({ ...route, channelId: 'B' }), () => 'org', selected, selectHint)
  workspace.syncSelection('ready', () => ({ ...route, organizationId: 'next' }), () => 'org', selected, selectHint)
  workspace.syncSelection('ready', () => ({ ...route, channelId: null }), () => 'org', selected, selectHint)
  expect(selected).not.toHaveBeenCalled()
  workspace.syncSelection('ready', () => route, () => 'org', selected, selectHint)
  expect(selectHint).not.toHaveBeenCalled()
  workspace.syncSelection('ready', () => ({ ...route, channelId: 'B' }), () => 'org', selected, selectHint)
  expect(selectHint).toHaveBeenCalledExactlyOnceWith('B')
})

it('loads navigation metadata for the current Organization, skipping the Reply hint with an alternate anchor', () => {
  const workspace = createWorkspaceController()
  const replyRoute = { ...route, topicId: 'T', panel: 'reply:m' as const }
  const load = vi.fn()
  const inMemoryReplyAnchor = vi.fn(() => null)
  const input = {
    route: replyRoute,
    organizationId: 'org',
    organizationUnavailable: () => false,
    searchReply: () => false,
    replies: () => ({}),
    activeReplyMessageId: () => 'm',
    inMemoryReplyAnchor,
    load,
  }
  workspace.syncNavigationTargets({ ...input, organizationId: 'other' })
  workspace.syncNavigationTargets({ ...input, organizationUnavailable: () => true })
  expect(load).not.toHaveBeenCalled()
  workspace.syncNavigationTargets({ ...input, searchReply: () => true })
  expect(inMemoryReplyAnchor).not.toHaveBeenCalled()
  expect(load).toHaveBeenLastCalledWith({ ...replyRoute, panel: null })
  workspace.syncNavigationTargets({ ...input, replies: () => null })
  workspace.syncNavigationTargets({ ...input, activeReplyMessageId: () => null })
  expect(inMemoryReplyAnchor).not.toHaveBeenCalled()
  expect(load.mock.calls.slice(1)).toEqual([[replyRoute], [replyRoute]])
  workspace.syncNavigationTargets(input)
  expect(load).toHaveBeenLastCalledWith(replyRoute)
  workspace.syncNavigationTargets({ ...input, inMemoryReplyAnchor: () => ({ id: 'm' }) })
  expect(load).toHaveBeenLastCalledWith({ ...replyRoute, panel: null })
})

it('opens a Search anchor before closing the drawer and clears the anchor when leaving a result', () => {
  const workspace = createWorkspaceController()
  const open = vi.fn()
  const close = vi.fn()
  const result = { channelId: 'A', messageId: 'm', createdSeq: 1 }
  workspace.syncSearchAnchor({ open }, result, close)
  expect(open).toHaveBeenCalledWith(result)
  expect(open).toHaveBeenCalledBefore(close)
  workspace.syncSearchAnchor({ open }, undefined, close)
  expect(open).toHaveBeenLastCalledWith(undefined)
  expect(close).toHaveBeenCalledOnce()
  workspace.syncSearchAnchor(undefined, result, close)
  expect(close).toHaveBeenCalledTimes(2)
})

it('selects a recovered DM only while it matches the selected Channel, once per recovery', async () => {
  const workspace = createWorkspaceController()
  let selected = 'A'
  const selectedId = () => selected
  const select = vi.fn()
  workspace.syncRecoveredDm('DM', selectedId, select)
  expect(select).not.toHaveBeenCalled()
  selected = 'DM'
  workspace.syncRecoveredDm('DM', selectedId, select)
  workspace.syncRecoveredDm('DM', selectedId, select)
  expect(select).toHaveBeenCalledExactlyOnceWith('DM')
  workspace.syncRecoveredDm(undefined, selectedId, select)
  workspace.syncRecoveredDm('DM', selectedId, select)
  expect(select).toHaveBeenCalledTimes(2)

  select.mockClear()
  await workspace.openDm(async () => { selected = 'A' }, () => 'DM', selectedId, select)
  await workspace.openDm(async () => { selected = '' }, () => '', selectedId, select)
  expect(select).not.toHaveBeenCalled()
  await workspace.openDm(async () => { selected = 'DM' }, () => 'DM', selectedId, select)
  expect(select).toHaveBeenCalledExactlyOnceWith('DM')
})

it('closes Search before topic navigation and resumes only a stopped same-Topic Unread visit', () => {
  const workspace = createWorkspaceController()
  const closeSearch = vi.fn()
  const closeDrawer = vi.fn()
  const navigate = vi.fn(() => true)
  const enter = vi.fn()
  const input = {
    selected: { id: 'A' },
    organizationId: () => 'org',
    closeSearch,
    currentTopicId: () => 'T',
    phone: () => true,
    navigate,
    unread: () => ({ state: { stopped: false, topics: { T: { stopped: true } } }, enter }),
    closeDrawer,
  }
  workspace.selectTopic('T', { ...input, selected: undefined })
  workspace.selectTopic('T', { ...input, organizationId: () => '' })
  expect(closeSearch).not.toHaveBeenCalled()
  const unread = vi.fn(input.unread)
  workspace.selectTopic('different', { ...input, unread })
  expect(unread).not.toHaveBeenCalled()
  workspace.selectTopic('T', { ...input, unread: () => null })
  workspace.selectTopic('T', { ...input, unread: () => ({ state: { stopped: false, topics: {} }, enter }) })
  expect(enter).not.toHaveBeenCalled()
  workspace.selectTopic('T', input)
  workspace.selectTopic('T', { ...input, unread: () => ({ state: { stopped: true, topics: {} }, enter }) })
  expect(enter.mock.calls).toEqual([['T'], ['T']])
  expect(navigate).toHaveBeenLastCalledWith({ type: 'topic', topicId: 'T', phone: true })
  expect(closeSearch).toHaveBeenCalledBefore(navigate)
  expect(navigate.mock.invocationCallOrder.at(-1)!).toBeLessThan(enter.mock.invocationCallOrder.at(-1)!)
  expect(enter.mock.invocationCallOrder.at(-1)!).toBeLessThan(closeDrawer.mock.invocationCallOrder.at(-1)!)
})

it('closes Channel tabs on a DM and leaves a Reply panel in place', () => {
  const workspace = createWorkspaceController()
  const navigate = vi.fn(() => true)
  workspace.syncDmPanel('channel', () => 'members', navigate)
  workspace.syncDmPanel('dm', () => 'reply:m', navigate)
  workspace.syncDmPanel('dm', () => null, navigate)
  expect(navigate).not.toHaveBeenCalled()
  workspace.syncDmPanel('dm', () => 'members', navigate)
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ type: 'close' })
})

it('fences Search result navigation by Organization, Channel kind, and known Topic availability', () => {
  const workspace = createWorkspaceController()
  const select = vi.fn()
  const target: SearchTarget = { channelId: 'A', messageId: 'm', createdSeq: 1 }
  const topic = { ...target, topicId: 'T' }
  type Inputs = Parameters<typeof workspace.openSearchResult>[2]
  let topics: ReturnType<Inputs['topics']> = {
    topic: () => ({ notFound: false }),
    topics: [],
    list: { asOfSeq: undefined, hasMore: true },
    main: { asOfSeq: undefined, hasMore: true },
  }
  const input: Inputs = {
    currentOrganizationId: 'org',
    organizationUnavailable: () => false,
    isDm: () => false,
    isKnownChannel: () => true,
    topics: () => topics,
    select,
  }
  expect(workspace.openSearchResult('', target, { ...input, currentOrganizationId: '' })).toBe(false)
  expect(workspace.openSearchResult('other', target, input)).toBe(false)
  expect(workspace.openSearchResult('org', target, { ...input, organizationUnavailable: () => true })).toBe(false)
  expect(workspace.openSearchResult('org', target, { ...input, isKnownChannel: () => false })).toBe(false)
  expect(workspace.openSearchResult('org', topic, { ...input, isDm: () => true })).toBe(false)
  expect(workspace.openSearchResult('org', { ...topic, channelKind: 'dm' }, input)).toBe(false)

  const initial = topics
  topics = { ...initial, topic: () => ({ notFound: true }) }
  expect(workspace.openSearchResult('org', topic, input)).toBe(false)
  topics = { ...initial, list: { asOfSeq: 1, hasMore: false } }
  expect(workspace.openSearchResult('org', topic, input)).toBe(false)
  topics = { ...initial, main: { asOfSeq: 1, hasMore: false } }
  expect(workspace.openSearchResult('org', topic, input)).toBe(false)
  expect(select).not.toHaveBeenCalled()

  topics = { ...initial, main: { asOfSeq: undefined, hasMore: false } }
  expect(workspace.openSearchResult('org', topic, input)).toBe(true)
  topics = { ...initial, main: { asOfSeq: 1, hasMore: true } }
  expect(workspace.openSearchResult('org', topic, input)).toBe(true)
  topics = { ...initial, list: { asOfSeq: 1, hasMore: true }, main: { asOfSeq: 1, hasMore: false } }
  expect(workspace.openSearchResult('org', topic, input)).toBe(true)
  topics = { ...topics, list: { asOfSeq: 1, hasMore: false }, topics: [{ topicId: 'T' }] }
  expect(workspace.openSearchResult('org', topic, input)).toBe(true)
  const unknown = { ...target, channelKind: 'dm' as const }
  expect(workspace.openSearchResult('org', unknown, { ...input, isKnownChannel: () => false })).toBe(true)
  expect(workspace.openSearchResult('org', target, { ...input, isDm: () => true, isKnownChannel: () => false })).toBe(true)
  expect(select.mock.calls).toEqual([['A', topic], ['A', topic], ['A', topic], ['A', topic], ['A', unknown], ['A', target]])
})
