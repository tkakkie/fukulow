import { afterEach, expect, it, vi } from 'vitest'
import type { Message } from './api'
import { makeSearchHit } from './search-test-helpers'
import { createWorkspaceAnnouncements } from './workspace-announcements'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers()
  const onAnnounce = vi.fn()
  let viewId = ''
  const setViewId = vi.fn((id: string) => { viewId = id })
  const controller = createWorkspaceAnnouncements({ onAnnounce }, {
    get: () => viewId,
    set: setViewId,
  })
  const selected = { id: 'A', kind: 'channel' as const }
  const view = {
    selected,
    isChannelListLoading: () => false,
    topicId: (): string | null => null,
    topicName: () => '',
    isTopicLoading: () => false,
    channelName: () => 'General',
    unnamedTopic: 'Unnamed Topic',
  }
  const state = { messages: [] as Message[], status: 'ready' as const }
  const timeline = {
    selected,
    topicId: view.topicId,
    timeline: () => state,
    activeReplyMessageId: (): string | null => null,
    replies: () => null,
    live: () => true,
    selfId: () => 'me',
    resolveSenderName: (id: string) => id.toUpperCase(),
    hasCustomSenderName: () => false,
    isAuthorPending: () => false,
  }
  return { controller, onAnnounce, view, timeline, state, setViewId, viewId: () => viewId }
}

function message(seq: number, overrides: Partial<Message> = {}) {
  return makeSearchHit(seq - 1, { channel_id: 'A', sender: 'alice', body: `message ${seq}`, ...overrides }).message
}

it('publishes a view before wiring its timeline and waits for unnamed Topic metadata', () => {
  const { controller, onAnnounce, view, timeline, state, setViewId, viewId } = fixture()
  const live = vi.fn(() => true)
  controller.syncView({ ...view, isChannelListLoading: () => true })
  controller.syncTimeline({ ...timeline, live })
  expect(onAnnounce).not.toHaveBeenCalled()
  expect(live).not.toHaveBeenCalled()
  controller.syncView(view)
  controller.syncView({ ...view, channelName: () => 'Renamed' })
  expect(setViewId).toHaveBeenCalledExactlyOnceWith('A/')
  const topicId = () => 'T'
  const topicView = { ...view, topicId }
  controller.syncView({ ...topicView, isTopicLoading: () => true })
  controller.syncTimeline({ ...timeline, topicId, live })
  expect(live).not.toHaveBeenCalled()
  expect(onAnnounce.mock.calls).toEqual([['# General']])

  controller.syncView(topicView)
  controller.syncTimeline({ ...timeline, topicId, live, timeline: () => null })
  controller.syncTimeline({ ...timeline, selected: undefined, live })
  expect(live).not.toHaveBeenCalled()
  controller.syncTimeline({ ...timeline, topicId, live })
  state.messages = [message(1, { topic_id: 'T' })]
  controller.syncTimeline({ ...timeline, topicId, live })
  vi.advanceTimersByTime(2_000)
  expect(onAnnounce.mock.calls).toEqual([['# General'], ['Unnamed Topic'], ['ALICE: message 1']])

  controller.syncView({ ...view, selected: undefined })
  expect(viewId()).toBe('')
  controller.syncView({ ...view, selected: { id: 'D', kind: 'dm' }, channelName: () => 'Alice' })
  expect(onAnnounce).toHaveBeenLastCalledWith('Alice')
  controller.syncView({ ...topicView, topicName: () => 'Known', isTopicLoading: () => true })
  expect(onAnnounce).toHaveBeenLastCalledWith('Known')
})

it('wires sender lookup to the two-second window and drops queued announcements on view change or teardown', () => {
  const { controller, onAnnounce, view, timeline, state } = fixture()
  let pending = true
  const input = { ...timeline, isAuthorPending: (id: string) => pending && id === 'alice' }
  state.messages = [message(1)]
  controller.syncView(view)
  controller.syncTimeline(input)
  state.messages.push(message(2, { sender: 'me' }), message(3), message(4, { sender: 'bob' }))
  controller.syncTimeline(input)
  vi.advanceTimersByTime(3_000)
  expect(onAnnounce.mock.calls).toEqual([['# General']])

  pending = false
  controller.syncTimeline(input)
  vi.advanceTimersByTime(1_999)
  expect(onAnnounce).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(1)
  expect(onAnnounce.mock.calls).toEqual([['# General'], ['新着メッセージ 2件']])

  state.messages.push(message(5))
  controller.syncTimeline(input)
  const nextView = { ...view, topicId: () => 'T', topicName: () => 'Topic' }
  controller.syncView(nextView)
  vi.advanceTimersByTime(2_000)
  expect(onAnnounce.mock.calls).toEqual([['# General'], ['新着メッセージ 2件'], ['Topic']])

  controller.syncTimeline({ ...input, topicId: nextView.topicId })
  state.messages.push(message(6, { topic_id: 'T' }))
  controller.syncTimeline({ ...input, topicId: nextView.topicId })
  controller.destroy()
  vi.advanceTimersByTime(2_000)
  expect(onAnnounce).toHaveBeenCalledTimes(3)
})

it('feeds the active Reply chain into the timeline and uses a supplied sender resolver during pending lookups', () => {
  const { controller, onAnnounce, view, timeline, state } = fixture()
  const reply = message(2, { id: 'reply', reply_to: 'root', reply_root_id: 'root' })
  const replies = vi.fn(() => ({ rootId: 'root', messages: [reply] }))
  const isAuthorPending = vi.fn(() => true)
  const input = {
    ...timeline, replies, hasCustomSenderName: () => true, isAuthorPending, resolveSenderName: () => 'Custom',
  }
  controller.syncView(view)
  state.messages = [message(1, { id: 'root' }), reply]
  controller.syncTimeline(input)
  expect(replies).not.toHaveBeenCalled()
  state.messages.push(message(3, { reply_to: 'root', reply_root_id: 'root' }))
  controller.syncTimeline(input)
  vi.advanceTimersByTime(2_000)
  expect(onAnnounce.mock.calls).toEqual([['# General']])

  state.messages.push(message(4, { reply_to: 'root', reply_root_id: 'root' }))
  controller.syncTimeline({ ...input, activeReplyMessageId: () => 'root' })
  vi.advanceTimersByTime(2_000)
  expect(onAnnounce).toHaveBeenLastCalledWith('Custom: message 4')
  state.messages.push(message(5, { reply_to: 'reply' }))
  controller.syncTimeline({ ...input, activeReplyMessageId: () => 'reply', replies: () => ({ rootId: '', messages: [reply] }) })
  vi.advanceTimersByTime(2_000)
  expect(onAnnounce).toHaveBeenLastCalledWith('Custom: message 5')
  expect(isAuthorPending).not.toHaveBeenCalled()
})

it('rechecks pending sender identity against the current member on each timeline update', () => {
  const { controller, onAnnounce, view, timeline, state } = fixture()
  const input = { ...timeline, isAuthorPending: () => true }
  controller.syncView(view)
  controller.syncTimeline(input)
  state.messages = [message(1)]
  controller.syncTimeline(input)
  vi.advanceTimersByTime(2_000)
  expect(onAnnounce).toHaveBeenCalledOnce()
  controller.syncTimeline({ ...input, selfId: () => 'alice' })
  vi.advanceTimersByTime(2_000)
  expect(onAnnounce).toHaveBeenLastCalledWith('ALICE: message 1')
})

it('keeps the reconnect and empty Channel-list timeouts on their original clocks', () => {
  const { controller, onAnnounce, view, timeline } = fixture()
  const update = vi.fn()
  const unsubscribe = controller.subscribe(update)
  const channel = { id: 'A', kind: 'channel' as const, name: 'A', archived: false, visibility: 'public' as const,
    capabilities: { can_add_members: { allowed: false }, can_remove_members: { allowed: false }, can_manage_managers: { allowed: false }, can_leave: { allowed: false }, can_rename: { allowed: false }, can_archive: { allowed: false } } }
  controller.syncChannelList({ status: 'loading', channels: [channel] })
  vi.advanceTimersByTime(10_000)
  controller.syncChannelList({ status: 'ready', channels: [] })
  vi.advanceTimersByTime(10_000)
  expect(update).not.toHaveBeenCalled()

  controller.syncChannelList({ status: 'loading', channels: [] })
  controller.syncView(view)
  controller.syncTimeline(timeline)
  controller.syncTimeline({ ...timeline, live: () => false })
  vi.advanceTimersByTime(1_999)
  expect(controller.get()).toEqual({ reconnecting: false, channelListTimedOut: false })
  vi.advanceTimersByTime(1)
  expect(controller.get().reconnecting).toBe(true)
  expect(onAnnounce).toHaveBeenLastCalledWith('再接続しています…')
  controller.syncTimeline(timeline)
  expect(controller.get().reconnecting).toBe(false)
  expect(onAnnounce).toHaveBeenLastCalledWith('接続しました。')

  vi.advanceTimersByTime(7_999)
  expect(controller.get().channelListTimedOut).toBe(false)
  vi.advanceTimersByTime(1)
  expect(controller.get().channelListTimedOut).toBe(true)
  controller.resetChannelListTimeout()
  expect(controller.get().channelListTimedOut).toBe(false)
  expect(update).toHaveBeenCalledTimes(4)
  controller.syncChannelList({ status: 'loading', channels: [] })
  controller.destroy()
  vi.advanceTimersByTime(10_000)
  expect(update).toHaveBeenCalledTimes(4)
  unsubscribe()
})
