import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createActivity, createActivityTarget, type ActivityNotice } from './activity'
import type { Result } from './api'
const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const held = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const keys = ['channels', 'main:c', 'topic:c:t', 'members', 'channel-members:c', 'capabilities']
for (const trigger of ['notice', 'periodic']) for (const key of keys) for (const kind of ['network', 'deadline', '429', '503'] as const) {
  it(`every_dirty_target_retries_failed_refetch_until_recovery_without_another_notice: ${key} ${kind} ${trigger}`, async () => {
    const late = held<Result<string>>()
    const failure: Result<string> = kind === 'network' ? { ok: false, kind: 'network' }
      : { ok: false, kind: 'http', status: kind === '429' ? 429 : 503, retryAfterMs: kind === '429' ? 5000 : 0 }
    const load = vi.fn<() => Promise<Result<string>>>().mockImplementationOnce(() => kind === 'deadline' ? late.promise : Promise.resolve(failure)).mockResolvedValue(ok('current'))
    const accept = vi.fn(), hide = vi.fn()
    const target = createActivityTarget({ load, accept, hide, random: () => 0, timeoutMs: 1000 })
    const activity = createActivity({ watched: () => true, random: () => 0.9 })
    if (trigger === 'periodic') activity.notice({ type: 'activity_ready' })
    activity.hold(key, target)
    if (trigger === 'notice') target.invalidate('access')
    await vi.advanceTimersByTimeAsync(trigger === 'periodic' ? 27_200 : 200)
    if (kind === 'deadline') await vi.advanceTimersByTimeAsync(1000)
    const calls = load.mock.calls.length
    // Both periodic demand and notice demand must respect the same pending retry.
    target.invalidate('reconcile'); target.invalidate(); target.invalidate('access')
    await vi.advanceTimersByTimeAsync(499)
    expect(load).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(kind === '429' ? 4501 : 1)
    expect(accept).toHaveBeenLastCalledWith('current')
    late.resolve(ok('stale')); await flush()
    expect(accept).toHaveBeenCalledOnce()
    activity.close(); expect(vi.getTimerCount()).toBe(0)
  })
}
it('periodic_reconciliation_spreads_first_runs_and_keeps_an_independent_schedule', async () => {
  const offsets = [0, 0.25, 0.5, 0.999]
  const times: number[] = []
  const activities = offsets.map(offset => {
    const activity = createActivity({ watched: () => false, random: () => offset })
    activity.hold('channels', { invalidate: (_reason, delay) => { if (delay === 200) times.push(Date.now()) }, close() {} })
    activity.notice({ type: 'activity_ready' }); return activity
  })
  const start = Date.now(); times.length = 0
  await vi.advanceTimersByTimeAsync(30_000)
  expect(times.map(t => t - start)).toEqual([0, 7500, 15000, 29970, 30000])
  const independent = activities[1]
  independent.notice({ type: 'channel_activity', channel_id: 'c', seq: 100 })
  await vi.advanceTimersByTimeAsync(8000)
  expect(times).toContain(start + 38_000)
  independent.disconnected()
  const oldCount = times.length
  await vi.advanceTimersByTimeAsync(31_000)
  expect(times.length).toBeGreaterThan(oldCount) // other generations keep their own schedules
  independent.notice({ type: 'activity_ready' })
  activities.forEach(a => a.close()); expect(vi.getTimerCount()).toBe(0)
})
it('periodic_reconciliation_coalesces_refetches_and_loads_only_held_targets', async () => {
  const first = held<Result<string>>(), second = held<Result<string>>()
  const load = vi.fn<() => Promise<Result<string>>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(ok('current'))
  const accept = vi.fn(), target = createActivityTarget({ load, accept })
  const activity = createActivity({ watched: () => false, random: () => 0 })
  const drop = activity.hold('channels', target)
  activity.notice({ type: 'activity_ready' })
  await vi.advanceTimersByTimeAsync(200)
  for (let i = 0; i < 500; i++) activity.notice({ type: 'channel_activity', channel_id: 'c', seq: i + 1 })
  await vi.advanceTimersByTimeAsync(200); expect(load).toHaveBeenCalledOnce()
  first.resolve(ok('old')); await flush(); await vi.advanceTimersByTimeAsync(200)
  expect(load).toHaveBeenCalledTimes(2)
  // An invalidation during the second request fences its response and queues just one follow-up.
  activity.notice({ type: 'activity_reset' }); activity.notice({ type: 'activity_reset' })
  second.resolve(ok('stale')); await flush(); await vi.advanceTimersByTimeAsync(200)
  expect(load).toHaveBeenCalledTimes(3); expect(accept).toHaveBeenLastCalledWith('current')
  drop(); await vi.advanceTimersByTimeAsync(60_000); expect(load).toHaveBeenCalledTimes(3)
  target.close(); activity.close()
})
it('revoked entry disappears at once and a stale response cannot re-add it', async () => {
  const old = held<Result<string[]>>(), accept = vi.fn(), hide = vi.fn(), revoke = vi.fn()
  const target = createActivityTarget({ load: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(ok(['allowed'])), accept, hide })
  const activity = createActivity({ watched: () => false, revoke })
  activity.hold('channels', target); target.refresh()
  activity.notice({ type: 'channel_access_revoked', channel_id: 'removed' })
  expect(revoke).toHaveBeenCalledWith('removed')
  old.resolve(ok(['removed'])); await flush()
  expect(accept).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(200); expect(accept).toHaveBeenCalledWith(['allowed'])
  activity.close()
})
it('regrant starts a new generation and rejects old-generation baselines', async () => {
  const old = held<Result<number>>(), accept = vi.fn()
  const target = createActivityTarget({ load: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(ok(0)), accept })
  const activity = createActivity({ watched: () => false })
  activity.hold('channels', target); target.refresh()
  activity.notice({ type: 'channel_access_revoked', channel_id: 'c' }); activity.notice({ type: 'channel_access_gained', channel_id: 'c' })
  old.resolve(ok(99)); await flush(); await vi.advanceTimersByTimeAsync(200)
  expect(accept).toHaveBeenCalledExactlyOnceWith(0); activity.close()
})
it('fresh_topic_summary_does_not_satisfy_a_stale_channel_aggregate', () => {
  const aggregate = { invalidate: vi.fn(), close() {} }, topic = { invalidate: vi.fn(), close() {} }
  const activity = createActivity({ watched: () => true, covered: () => false })
  activity.hold('channels', aggregate); activity.hold('topic:c:t', topic)
  const notice: ActivityNotice = { type: 'read_position_changed', channel_id: 'c', topic_id: 't', read_seq: 20 }
  activity.notice(notice); activity.notice(notice)
  expect(aggregate.invalidate).toHaveBeenCalledTimes(2); expect(topic.invalidate).toHaveBeenCalledTimes(2)
  activity.close()
})
it('notice burst costs at most one request per debounce', async () => {
  const load = vi.fn(async () => ok(1)), target = createActivityTarget({ load, accept() {} })
  for (let i = 0; i < 1000; i++) { target.invalidate(); await vi.advanceTimersByTimeAsync(0) }
  expect(load).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(200)
  expect(load).toHaveBeenCalledOnce(); target.close()
})
it('guest_last_shared_channel_removal_invalidates_own_directory', async () => {
  const old = held<Result<string[]>>(), accept = vi.fn(), hide = vi.fn()
  const members = createActivityTarget({ load: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: false, kind: 'network' }).mockResolvedValue(ok(['self'])), accept, hide, random: () => 0 })
  const activity = createActivity({ watched: () => false })
  activity.hold('members', members); members.refresh()
  activity.notice({ type: 'channel_access_revoked', channel_id: 'last-shared' })
  expect(hide).toHaveBeenCalledOnce()
  old.resolve(ok(['formerly-shared-member'])); await flush(); expect(accept).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(700); expect(accept).toHaveBeenCalledWith(['self'])
  activity.close()
})
it('delayed_commit_after_successful_recovery_fetch_converges_without_later_mutation', async () => {
  const outcomes = [
    ['send', 'channels', 0, 1], ['mark-read', 'channels', 12, 3], ['grant', 'channels', 0, 1],
    ['Role', 'capabilities', 0, 1], ['directory', 'members', 2, 1],
    ['Channel grants', 'channel-members:c', 2, 1], ['Topic read', 'topic:c:t', 3, 0], ['main summaries', 'main:c', 3, 0],
  ] as const
  for (const [outcome, key, before, after] of outcomes) for (const generation of ['same', 'reconnect', 'replacement']) {
    let committed = false
    const accept = vi.fn(), load = vi.fn(async () => ok(committed ? after : before))
    const open = () => {
      const target = createActivityTarget({ load, accept })
      const activity = createActivity({ watched: () => false, random: () => 0.5 })
      activity.hold(key, target); activity.notice({ type: 'activity_ready' }); return activity
    }
    let activity = open()
    await vi.advanceTimersByTimeAsync(200); expect(accept).toHaveBeenLastCalledWith(before)
    if (generation === 'reconnect') { activity.disconnected(); activity.notice({ type: 'activity_ready' }) }
    if (generation === 'replacement') { activity.close(); activity = open() }
    await vi.advanceTimersByTimeAsync(15_200)
    expect(accept, outcome + generation).toHaveBeenLastCalledWith(before)
    // Neither the ready fetch nor the first successful periodic fetch resolved COMMIT.
    committed = true
    await vi.advanceTimersByTimeAsync(31_000)
    expect(accept, outcome + generation).toHaveBeenLastCalledWith(after)
    activity.close()
  }
})
it('ordinary terminal 4xx stops automatic retry and explicit retry remains possible', async () => {
  const load = vi.fn<() => Promise<Result<number>>>().mockResolvedValueOnce({ ok: false, kind: 'http', status: 400 }).mockResolvedValue(ok(2))
  const accept = vi.fn(), target = createActivityTarget({ load, accept })
  await target.refresh(); await vi.advanceTimersByTimeAsync(90_000); expect(load).toHaveBeenCalledOnce()
  await target.retryNow(); expect(accept).toHaveBeenCalledWith(2); target.close()
})
it('closed generations fence responses and pending retry timers', async () => {
  const accept = vi.fn(), load = vi.fn(async (): Promise<Result<number>> => ({ ok: false, kind: 'http', status: 503 }))
  const target = createActivityTarget({ load, accept })
  await target.refresh(); target.close(); await vi.advanceTimersByTimeAsync(120_000)
  expect(load).toHaveBeenCalledOnce(); expect(accept).not.toHaveBeenCalled()
})

it('a covered Topic skips only its own fetch while two Topics and the aggregate retain independent coverage', () => {
  const aggregate = { invalidate: vi.fn(), close() {} }, covered = { invalidate: vi.fn(), close() {} }, other = { invalidate: vi.fn(), close() {} }
  const activity = createActivity({ watched: () => true, covered: (_notice, target) => target === 'topic:c:t' })
  activity.hold('channels', aggregate); activity.hold('topic:c:t', covered); activity.hold('topic:c:other', other)
  for (let i = 0; i < 2; i++) activity.notice({ type: 'read_position_changed', channel_id: 'c', topic_id: 't', read_seq: 20 })
  activity.notice({ type: 'read_position_changed', channel_id: 'c', topic_id: 'other', read_seq: 30 })
  expect(covered.invalidate).not.toHaveBeenCalled(); expect(aggregate.invalidate).toHaveBeenCalledTimes(3); expect(other.invalidate).toHaveBeenCalledOnce(); activity.close()
})
it('hidden mutations and no mutation have identical independent reconciliation timing and traffic', async () => {
  const traces: number[][] = []
  for (const mutation of [false, true]) {
    vi.setSystemTime(0)
    let committed = false
    const trace: number[] = [], accepted: number[] = []
    const target = createActivityTarget({ load: async () => { trace.push(Date.now()); return ok(committed ? 1 : 0) }, accept: value => accepted.push(value) })
    const activity = createActivity({ watched: () => false, random: () => 0.5 })
    activity.hold('channels', target); activity.notice({ type: 'activity_ready' })
    await vi.advanceTimersByTimeAsync(200); committed = mutation
    await vi.advanceTimersByTimeAsync(76_000)
    expect(accepted.at(-1)).toBe(mutation ? 1 : 0)
    traces.push(trace); activity.close()
  }
  expect(traces[0]).toEqual(traces[1])
})

it('a stale transient failure retains backoff and Retry-After after a periodic invalidation', async () => {
  for (const status of [429, 503]) {
    const old = held<Result<string>>(), accept = vi.fn()
    const load = vi.fn<() => Promise<Result<string>>>().mockReturnValueOnce(old.promise).mockResolvedValue(ok('current'))
    const target = createActivityTarget({ load, accept, random: () => 0 })
    target.refresh(); target.invalidate('reconcile')
    old.resolve({ ok: false, kind: 'http', status, retryAfterMs: status === 429 ? 5000 : 0 }); await flush()
    target.invalidate('reconcile'); target.invalidate('access')
    await vi.advanceTimersByTimeAsync(status === 429 ? 4999 : 499); expect(load).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2); expect(accept).toHaveBeenCalledWith('current')
    target.close()
  }
})

it('notices never move the cursor, fill a gap or settle a pending send', async () => {
  const { controllerClient, record } = await import('./sync-test-helpers')
  const c = controllerClient()
  await c.feed({ type: 'session_start' }); await c.feed({ type: 'connection_ready' })
  const history = (await c.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
  await c.feed({ type: 'history_result', channel: 'A', respond_to: history, messages: [record(1)], has_more: false })
  await c.feed({ type: 'subscribed', channel: 'A', caught_up_seq: 1 })
  await c.feed({ type: 'user_send', channel: 'A', client_message_id: 'pending', body: 'pending text' })
  const before = c.sync.get()
  expect(await c.feed({ type: 'activity_notice', notice: { type: 'channel_activity', channel_id: 'A', seq: 100 } })).toEqual([])
  expect(c.sync.get()).toBe(before)
  expect(c.sync.get().channels.A.cursor).toBe(1); expect(c.sync.get().channels.A.pending).toHaveLength(1)
  await c.sync.close()
})
it('initial summary reads and periodic and notice refetches share one bounded target', async () => {
  const { createTopicSync } = await import('./topic-sync')
  const { summary } = await import('./unread-test-helpers')
  const first = held<Result<import('./api').TopicSummaryResponse>>()
  let active = 0, maximum = 0, calls = 0
  const getTopicSummary = vi.fn(async () => {
    active++; maximum = Math.max(maximum, active)
    const result = ++calls === 1 ? await first.promise : ok({ as_of_seq: 1, topic: summary('T', 1, 1, 0) })
    active--; return result
  })
  let socket!: import('./realtime').RealtimeHandlers
  const activity = createActivity({ watched: () => true, random: () => 0 })
  const c = createTopicSync({ selfId: 'me', activity, connect(h) { socket = h; return { send() {}, close() {} } },
    api: { listMessages: async () => ok({ messages: [], has_more: false }), sendMessage: async () => ({ ok: false, kind: 'network' }) },
    topicsApi: { getTopicSummary,
      listTimeline: async () => ok({ as_of_seq: 1, has_more: false, items: [{ kind: 'topic', topic: summary('T', 1) }] }),
      listTopics: async () => ok({ as_of_seq: 1, has_more: false, topics: [summary('T', 1, 1, 0)] }),
      listTopicMessages: async () => ok({ messages: [], has_more: false }),
    },
  })
  await c.sync.start(); socket.onReady(); await c.sync.watch('A'); await flush()
  const pending = c.topics.loadSummary('A', 'T')
  void c.topics.activitySummary('A', 'T')
  activity.notice({ type: 'read_position_changed', channel_id: 'A', topic_id: 'T', read_seq: 1 })
  activity.notice({ type: 'activity_reset' })
  expect(getTopicSummary).toHaveBeenCalledOnce()
  first.resolve(ok({ as_of_seq: 1, topic: summary('T', 1) })); await pending; await flush(); await vi.advanceTimersByTimeAsync(200)
  expect(maximum).toBe(1); expect(getTopicSummary).toHaveBeenCalledTimes(2)
  expect(c.topics.get('A').topics.find(t => t.topicId === 'T')?.baseline?.summary.read_seq).toBe(1)
  expect(c.sync.get().channels.A.cursor).toBe(1)
  activity.close(); await c.sync.close()
})

it('dropping a held target cancels its queued refetch before it can issue HTTP', async () => {
  const first = held<Result<string>>(), load = vi.fn<() => Promise<Result<string>>>().mockReturnValueOnce(first.promise).mockResolvedValue(ok('late'))
  const target = createActivityTarget({ load, accept() {} })
  const activity = createActivity({ watched: () => false })
  const drop = activity.hold('channels', target)
  target.refresh(); target.invalidate(); drop()
  first.resolve(ok('old')); await flush(); await vi.advanceTimersByTimeAsync(5000)
  expect(load).toHaveBeenCalledOnce(); target.close(); activity.close()
})

it('Session routing never borrows a fresh Topic position to cover the Channel aggregate', async () => {
  const { createSession } = await import('./session')
  const { row, summary } = await import('./unread-test-helpers')
  let socket!: import('./realtime').RealtimeHandlers
  let count = 3
  const listChannels = vi.fn(async () => ok({ channels: [row({ unread_count: count })] }))
  const getTopicSummary = vi.fn(async () => ok({ as_of_seq: 3, topic: summary('T', 3, 2, 0) }))
  const session = createSession({ selfId: 'me', onEnded() {},
    channelsApi: { listChannels, createChannel: async () => ({ ok: false, kind: 'network' }) },
    unreadApi: { listChannels: async () => ok({ channels: [row({ unread_count: count })] }), getTopicSummary, markRead: async () => ({ ok: false, kind: 'network' }) },
    topicsApi: { getTopicSummary,
      listTimeline: async () => ok({ as_of_seq: 3, has_more: false, items: [{ kind: 'topic', topic: summary('T', 3, 2, 0) }] }),
      listTopics: async () => ok({ as_of_seq: 3, has_more: false, topics: [summary('T', 3, 2, 0)] }),
      listTopicMessages: async () => ok({ messages: [], has_more: false }),
    },
    sync: { connect(h) { socket = h; return { send() {}, close() {} } },
      api: { listMessages: async () => ok({ messages: [], has_more: false }), sendMessage: async () => ({ ok: false, kind: 'network' }) },
    },
  })
  socket.onReady(); await flush()
  socket.onEvent({ type: 'subscribed', channel_id: 'A', caught_up_seq: 3 }); await flush()
  await session.topics.loadSummary('A', 'T')
  const lists = listChannels.mock.calls.length, summaries = getTopicSummary.mock.calls.length
  count = 2
  for (let i = 0; i < 2; i++) socket.onEvent({ type: 'read_position_changed', channel_id: 'A', topic_id: 'T', read_seq: 2 })
  await vi.advanceTimersByTimeAsync(200)
  expect(listChannels).toHaveBeenCalledTimes(lists + 1)
  expect(getTopicSummary).toHaveBeenCalledTimes(summaries)
  expect(session.unread.get('A').unreadCount).toBe(2)
  session.close()
})
