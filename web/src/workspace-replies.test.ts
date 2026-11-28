import { expect, it, vi } from 'vitest'
import type { Message } from './api'
import { initialSearchView } from './search-anchor-view'
import { makeSearchHit } from './search-test-helpers'
import { createWorkspaceReplies, resolveReplyTarget, resolveWorkspaceReplyAnchor } from './workspace-replies'

const root = makeSearchHit(0, { channel_id: 'A' }).message
const child = makeSearchHit(1, { channel_id: 'A', reply_root_id: root.id }).message
const target = { channelId: 'A', messageId: child.id, createdSeq: child.created_seq }
const searchView = { ...initialSearchView(target), reply: child }
const routeReply = { status: 'ready' as const, targetId: child.id, anchor: root }

it('uses a Search Reply anchor in isolation and fences stale route metadata', () => {
  const readSearch = vi.fn(() => searchView)
  const readRoute = vi.fn(() => routeReply)
  expect(resolveReplyTarget(true, readSearch, readRoute, () => child.id)).toEqual({ status: 'loading', anchor: child })
  expect(readRoute).not.toHaveBeenCalled()
  expect(resolveReplyTarget(true, () => ({ ...searchView, status: 'missing' }), readRoute, () => child.id).status).toBe('unavailable')
  expect(resolveReplyTarget(true, () => undefined, readRoute, () => child.id)).toEqual({ status: 'loading', anchor: undefined })
  expect(resolveReplyTarget(false, readSearch, readRoute, () => child.id)).toBe(routeReply)
  expect(resolveReplyTarget(false, readSearch, readRoute, () => root.id)).toEqual({ status: 'idle' })
  expect(resolveReplyTarget(false, readSearch, () => undefined, () => root.id)).toEqual({ status: 'idle' })
  expect(resolveReplyTarget(false, readSearch, () => ({ status: 'loading' }), () => root.id)).toEqual({ status: 'loading' })

  const inMemory = vi.fn(() => root)
  const routeAnchor = vi.fn(() => child)
  expect(resolveWorkspaceReplyAnchor(true, () => undefined, inMemory, routeAnchor)).toBeNull()
  expect(inMemory).not.toHaveBeenCalled()
  expect(resolveWorkspaceReplyAnchor(true, () => child, inMemory, routeAnchor)).toBe(child)
  expect(resolveWorkspaceReplyAnchor(false, () => child, inMemory, routeAnchor)).toBe(root)
  expect(routeAnchor).not.toHaveBeenCalled()
  expect(resolveWorkspaceReplyAnchor(false, () => undefined, () => null, routeAnchor)).toBe(child)
})

it('keeps a cold descendant on the same chain until the reply target changes', () => {
  const controller = createWorkspaceReplies({ get: () => null, set: vi.fn() })
  let activeId: string | null = child.id
  let state = { anchor: null as Message | null, rootId: '', unavailable: false }
  const open = vi.fn((anchor: Message) => {
    state = { anchor, rootId: anchor.reply_root_id ?? anchor.id, unavailable: false }
  })
  const dismiss = vi.fn()
  const input: Parameters<typeof controller.sync>[0] = {
    replies: { open, dismiss },
    selected: () => ({ id: 'A' }),
    activeReplyMessageId: () => activeId,
    state: () => state,
    organizationUnavailable: () => false,
    timelineStatus: () => 'ready',
    resolvedAnchor: () => root,
  }
  controller.sync(input)
  expect(open).toHaveBeenCalledWith(root)
  controller.sync({ ...input, resolvedAnchor: () => child })
  expect(open).toHaveBeenCalledOnce()

  activeId = root.id
  controller.sync(input)
  expect(open).toHaveBeenCalledTimes(2)
  activeId = null
  controller.sync(input)
  expect(dismiss).toHaveBeenCalledOnce()
  activeId = root.id
  controller.sync(input)
  expect(open).toHaveBeenCalledTimes(3)
  state = { ...state, rootId: 'other' }
  controller.sync(input)
  expect(open).toHaveBeenCalledTimes(4)
  state = { ...state, anchor: null }
  controller.sync(input)
  expect(open).toHaveBeenCalledTimes(5)
  state = { ...state, anchor: null }
  activeId = null
  controller.sync(input)
  expect(dismiss).toHaveBeenCalledOnce()
})

it('waits for the selected Channel and an available same-Channel anchor before opening', () => {
  const controller = createWorkspaceReplies({ get: () => null, set: vi.fn() })
  const open = vi.fn()
  const resolvedAnchor = vi.fn(() => root)
  const input: Parameters<typeof controller.sync>[0] = {
    replies: { open, dismiss: vi.fn() },
    selected: () => ({ id: 'A' }),
    activeReplyMessageId: () => root.id,
    state: () => null,
    organizationUnavailable: () => false,
    timelineStatus: () => 'ready',
    resolvedAnchor,
  }
  controller.sync({ ...input, replies: null })
  controller.sync({ ...input, selected: () => undefined })
  controller.sync({ ...input, organizationUnavailable: () => true })
  controller.sync({ ...input, timelineStatus: () => 'unavailable' })
  controller.sync({ ...input, state: () => ({ anchor: root, rootId: root.id, unavailable: true }) })
  expect(resolvedAnchor).not.toHaveBeenCalled()
  controller.sync({ ...input, resolvedAnchor: () => null })
  controller.sync({ ...input, resolvedAnchor: () => ({ ...root, channel_id: 'B' }) })
  expect(open).not.toHaveBeenCalled()
  controller.sync(input)
  expect(open).toHaveBeenCalledOnce()
})

it('remembers the clicked anchor before opening its chain and navigating with the opener', () => {
  let remembered: Message | null = null
  const controller = createWorkspaceReplies({ get: () => remembered, set: message => { remembered = message } })
  const resolve = () => controller.resolveInMemory({ activeReplyMessageId: child.id, selectedChannelId: 'A' })
  const open = vi.fn((message: Message) => { expect(resolve()).toBe(message) })
  const navigate = vi.fn(() => true)
  controller.open(child, open, navigate, null)
  expect(open).toHaveBeenCalledWith(child)
  expect(open).toHaveBeenCalledBefore(navigate)
  expect(navigate).toHaveBeenCalledWith({ type: 'reply', messageId: child.id }, null)
  controller.sync({
    replies: { open, dismiss: vi.fn() },
    selected: () => ({ id: 'A' }),
    activeReplyMessageId: () => child.id,
    state: () => ({ anchor: root, rootId: root.id, unavailable: false }),
    organizationUnavailable: () => false,
    timelineStatus: () => 'ready',
    resolvedAnchor: resolve,
  })
  expect(open).toHaveBeenCalledOnce()
})
