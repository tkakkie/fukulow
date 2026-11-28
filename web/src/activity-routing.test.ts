import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createActivityReference } from '../../load/dms-activity-reference'
import { createActivity, type ActivityNotice, type ActivityTarget } from './activity'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const targetKeys = ['channels', 'sections', 'archived-channels', 'open-channel', 'dms', 'main:c',
  'topic:c:t', 'topic:c:other', 'channel-members:c', 'channel-members:other', 'members', 'capabilities']
const notices: ActivityNotice[] = [
  { type: 'channel_activity', channel_id: 'c', seq: 10 },
  { type: 'read_position_changed', channel_id: 'c', topic_id: null, read_seq: 10 },
  { type: 'read_position_changed', channel_id: 'c', topic_id: 't', read_seq: 10 },
  { type: 'read_position_changed', channel_id: 'c', topic_id: 'unheld', read_seq: 10 },
  { type: 'channel_access_gained', channel_id: 'c' },
  { type: 'channel_access_revoked', channel_id: 'c' },
  { type: 'channel_members_changed', channel_id: 'c' },
  { type: 'channel_members_changed', channel_id: 'unheld' },
  { type: 'dm_list_changed' },
  { type: 'channel_list_changed' },
  { type: 'members_changed' },
  { type: 'sections_changed', generation: '101' },
  { type: 'activity_ready' },
  { type: 'activity_reset' },
]

function observe(
  create: typeof createActivityReference,
  options: Parameters<typeof createActivityReference>[0],
  run: (activity: ReturnType<typeof createActivityReference>) => void,
) {
  const observed: unknown[] = [], start = Date.now()
  const log = (...args: unknown[]) => { observed.push([Date.now() - start, ...args]) }
  const activity = create({
    ...options,
    access: id => log('gain', id),
    revoke: id => log('revoke', id),
    reconcile: () => log('reconcile'),
  })
  for (const key of targetKeys) activity.hold(key, {
    invalidate: (...args) => log('invalidate', key, ...args),
    close: () => log('close', key),
    suspend: () => log('suspend', key),
    notice: event => log('notice', key, event),
    disconnected: () => log('disconnected', key),
    ready: () => { log('ready', key); return key === 'channels' },
  })
  run(activity)
  activity.close()
  return { observed, pendingTimers: vi.getTimerCount() }
}

it('matches the pre-Slice F TypeScript routes across kind, watch and per-target coverage', () => {
  for (const lookup of ['absent', 'unknown', 'dm', 'channel'] as const) {
    for (const watched of [false, true]) {
      for (const listCovered of [false, true]) {
        for (const projectionCovered of [false, true]) {
          const options = {
            kind: lookup === 'absent' ? undefined : () => lookup === 'unknown' ? undefined : lookup,
            watched: () => watched,
            covered: (_notice: ActivityNotice, target?: string) =>
              target === 'dms' || target === 'channels' ? listCovered : projectionCovered,
            random: () => 0.5,
          }
          for (const notice of notices) {
            const run = (activity: ReturnType<typeof createActivityReference>) => activity.notice(notice)
            expect(observe(createActivity, options, run), JSON.stringify({ lookup, watched, listCovered, projectionCovered, notice }))
              .toEqual(observe(createActivityReference, options, run))
          }
        }
      }
    }
  }
})

it('ignores an unrecognised notice type', () => {
  const notice = { type: 'future_notice', channel_id: 'c' } as unknown as ActivityNotice
  const run = (activity: ReturnType<typeof createActivityReference>) => activity.notice(notice)
  const options = { watched: () => false }
  expect(observe(createActivity, options, run)).toEqual(observe(createActivityReference, options, run))
})

it('matches the old Ready, reset, and periodic ordering and timing through disconnect and close', () => {
  const run = (activity: ReturnType<typeof createActivityReference>) => {
    activity.notice({ type: 'activity_ready' })
    vi.advanceTimersByTime(1000)
    activity.notice({ type: 'activity_reset' })
    vi.advanceTimersByTime(63_000)
    activity.disconnected()
    vi.advanceTimersByTime(60_000)
    activity.notice({ type: 'activity_ready' })
    vi.advanceTimersByTime(40_000)
  }
  const options = () => {
    const draws = [0.1, 0.25, 0, 0.9, 0.5, 0.7, 1, 0.3]
    return { watched: () => false, random: () => draws.shift() ?? 0.5 }
  }
  expect(observe(createActivity, options(), run)).toEqual(observe(createActivityReference, options(), run))
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects stale socket callbacks and timers before touching held targets', () => {
  let connection = 2
  const ready = vi.fn(), read = vi.fn(), invalidate = vi.fn()
  const activity = createActivity({
    watched: () => true,
    connectionEpoch: () => connection,
    ready, read, periodMs: 400, random: () => 0.5,
  })
  const target: ActivityTarget = { invalidate, close() {} }
  activity.hold('main:c', target)
  activity.notice({ type: 'activity_ready' }, 1)
  const readNotice = { type: 'read_position_changed', channel_id: 'c', topic_id: null, read_seq: 1 } as const
  activity.notice(readNotice, 1)
  expect(ready).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(invalidate).not.toHaveBeenCalled()

  activity.notice({ type: 'activity_ready' }, 2)
  activity.notice(readNotice, 2)
  expect(ready).toHaveBeenCalledOnce()
  expect(read).toHaveBeenCalledWith(readNotice)
  expect(invalidate.mock.calls).toEqual([['reconcile', 200], ['notice', 200, undefined]])

  connection = 3
  vi.advanceTimersByTime(400)
  expect(invalidate).toHaveBeenCalledTimes(2)
  activity.close()
})

it('reads coverage after Unread observation and checks the scope again before invalidation', () => {
  let retired = false, readSeq = 0
  const activity = createActivity({
    lifetime: () => retired ? 'retired_organization' : 'current',
    watched: () => true,
    read: notice => { readSeq = notice.read_seq },
    topicReadSeq: () => readSeq,
    ready: () => { retired = true },
  })
  const topic = vi.fn(), list = vi.fn()
  activity.hold('topic:c:t', { invalidate: topic, close() {} })
  activity.hold('channels', { invalidate: list, close() {} })
  activity.notice({ type: 'read_position_changed', channel_id: 'c', topic_id: 't', read_seq: 10 })
  expect(list).toHaveBeenCalledOnce()
  expect(topic).not.toHaveBeenCalled()

  activity.notice({ type: 'activity_ready' })
  expect(list).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  activity.close()
})

it('samples the projection watch after list invalidation callbacks', () => {
  let watched = true
  const activity = createActivity({ watched: () => watched, kind: () => 'dm' })
  const topic = vi.fn()
  activity.hold('topic:c:t', { invalidate: topic, close() {} })
  activity.hold('dms', { invalidate() { watched = false }, close() {} })
  const notice = { type: 'read_position_changed', channel_id: 'c', topic_id: 't', read_seq: 10 } as const
  activity.notice(notice)
  expect(topic).not.toHaveBeenCalled()
  activity.hold('dms', { invalidate() { watched = true }, close() {} })
  activity.notice(notice)
  expect(topic).toHaveBeenCalledOnce()
  activity.close()
})
