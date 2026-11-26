import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createActivity } from './activity'
import type { ChannelPlacement, CreatedSection, Result, SectionLayout } from './api'
import { createSections } from './sections'
import { advance, client, database, deferred, http, layout, network, ok, row } from './sections-test-helpers'

const clients: ReturnType<typeof client>[] = []
function open(...args: Parameters<typeof client>) {
  const c = client(...args); clients.push(c); return c
}
async function ready(c = open()) {
  c.sections.hold()
  await advance(0)
  await c.ready()
  return c
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  clients.splice(0).forEach(c => c.session.close())
  vi.useRealTimers()
})

it('Ready fences the first layout and Channel-list reads and queues both follow-ups', async () => {
  const oldLayout = deferred<Result<SectionLayout>>()
  const oldList = deferred<Result<{ channels: ReturnType<typeof row>[] }>>()
  const currentList = deferred<Result<{ channels: ReturnType<typeof row>[] }>>()
  const c = open(database(), { initialList: oldList.promise, initialLayout: oldLayout.promise })
  await c.ready()
  c.list.mockReturnValueOnce(currentList.promise)
  oldLayout.resolve(ok(layout('99', ['pre-ready'])))
  oldList.resolve(ok({ channels: [row('pre-ready')] }))
  await advance(0)
  expect(c.groups()).toEqual([[null, []]])
  expect(c.session.channels.get().channels).toEqual([])
  currentList.resolve(ok({ channels: c.db.rows }))
  await advance()
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  expect(c.getLayout).toHaveBeenCalledTimes(2)
  expect(c.list).toHaveBeenCalledTimes(2)
})

it('Ready, section notices and O5 leave an unheld layout unloaded', async () => {
  let current = layout('1')
  const getLayout = vi.fn(async (_signal: AbortSignal): Promise<Result<SectionLayout>> => ok(current))
  const activity = createActivity({
    kind: () => 'channel',
    watched: () => false,
    covered: () => false,
    revoke: () => {},
    access: () => {},
    reconcile: () => {},
    random: () => 0.5,
  })
  const sections = createSections({
    api: {
      layout: getLayout,
      placement: async () => network,
      create: async () => network,
      rename: async () => network,
      reorder: async () => network,
      moveChannel: async () => network,
      reorderChannels: async () => network,
      delete: async () => network,
    },
    activity,
    list: {
      get: () => ({ channels: [row('A')], current: true }),
      subscribe: () => () => true,
      invalidate: () => {},
      disconnected: () => {},
      ready: () => {},
    },
    observeAccess: () => {},
    random: () => 0.5,
  })
  try {
    sections.ready()
    activity.notice({ type: 'activity_ready' })
    current = layout('2')
    activity.notice({ type: 'sections_changed', generation: '2' })
    await advance(50_000)
    expect(getLayout).not.toHaveBeenCalled()
    sections.hold()
    await advance(0)
    expect(sections.get().generation).toBe('2')
  } finally {
    sections.close()
    activity.close()
  }
})

it.each(['activity_reset', 'channel_list_changed', 'periodic'] as const)('%s fences both pending snapshots and leaves one queued follow-up', async trigger => {
  const c = await ready()
  if (trigger === 'periodic') await advance(14_400)
  const oldLayout = deferred<Result<SectionLayout>>(), oldList = deferred<Result<{ channels: typeof c.db.rows }>>()
  c.getLayout.mockClear().mockReturnValueOnce(oldLayout.promise)
  c.list.mockClear().mockReturnValueOnce(oldList.promise)
  c.event({ type: 'channel_list_changed' })
  await advance()
  if (trigger === 'periodic') await advance()
  else c.event({ type: trigger })
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  oldLayout.resolve(ok(layout('99', ['A', 'old'], 'Stale')))
  oldList.resolve(ok({ channels: [row('A', { name: 'Stale' }), row('old')] }))
  c.db.layout = layout('1', ['new', 'A'], 'Current')
  c.db.rows = [row('A'), row('new')]
  await advance(0)
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])
  expect(c.session.channels.get().channels[0]?.name).toBe('A')
  await advance()
  expect(c.getLayout).toHaveBeenCalledTimes(2)
  expect(c.list).toHaveBeenCalledTimes(2)
  expect(c.groups()).toEqual([['S', ['new', 'A']], [null, []]])
})

it('own Sessions converge on section notices including the caller and a socket with zero subscriptions', async () => {
  const shared = database()
  const caller = open(shared), idle = open(shared), other = open(database(), { organizationId: 'elsewhere' })
  await Promise.all([ready(caller), ready(idle), ready(other)])
  await idle.session.sync.unwatch('A')
  expect(caller.session.sync.get().channels.A?.watched).toBe(true)
  expect(idle.session.sync.get().channels.A?.watched).toBe(false)
  const controls = idle.controls.length
  const ack = deferred<Result<undefined>>()
  caller.sectionsApi.delete.mockReturnValueOnce(ack.promise)
  const deleting = caller.sections.delete('S')
  shared.layout = { generation: '2', sections: [], other_channel_ids: ['A'] }
  expect(caller.groups()).toEqual([['S', ['A']], [null, []]])
  for (const c of [caller, idle]) c.event({ type: 'sections_changed', generation: '2' })
  await advance()
  expect(caller.groups()).toEqual([[null, ['A']]])
  expect(idle.groups()).toEqual(caller.groups())
  expect(other.groups()).toEqual([['S', ['A']], [null, []]])
  expect(idle.controls).toHaveLength(controls)
  expect(idle.session.sync.get().channels.A?.watched).toBe(false)
  ack.resolve(ok(undefined))
  await expect(deleting).resolves.toEqual(ok(undefined))
})

it.each(['visible', 'hidden'] as const)('the shared O5 schedule recovers a silently dropped final notice while %s', async visibility => {
  const c = await ready()
  const displayed = vi.fn()
  const unsubscribe = c.sections.subscribe(displayed)
  if (visibility === 'hidden') unsubscribe()
  c.getLayout.mockClear(); c.list.mockClear()
  await advance(12_000)
  c.db.layout = layout('2', ['A'], 'Preceding mutation')
  await c.sections.rename('S', { name: 'Preceding mutation' })
  c.event({ type: 'sections_changed', generation: '2' })
  await advance()
  expect(c.generation()).toBe('2')
  c.db.layout = layout('3', ['A', 'B'], 'Final')
  c.db.rows = [row('A'), row('B')]
  await advance(2799)
  expect(c.generation()).toBe('2')
  expect(c.list).not.toHaveBeenCalled()
  await advance(1)
  expect(c.getLayout).toHaveBeenCalledTimes(2)
  expect(c.list).toHaveBeenCalledOnce()
  expect(c.groups()).toEqual([['S', ['A', 'B']], [null, []]])
  if (visibility === 'hidden') expect(displayed).not.toHaveBeenCalled()
  else expect(displayed).toHaveBeenCalled()
})

it('an early read after restart cannot finish O5 recovery before a delayed COMMIT', async () => {
  const db = database()
  const first = await ready(open(db))
  const commit = deferred<Result<undefined>>()
  first.sectionsApi.rename.mockReturnValueOnce(commit.promise)
  const writing = first.sections.rename('S', { name: 'Committed later' })
  first.session.close()
  await expect(writing).resolves.toMatchObject({ kind: 'inactive' })
  const restarted = await ready(open(db))
  await advance(15_000)
  expect(restarted.generation()).toBe('1')
  db.layout = layout('2', ['A'], 'Committed later')
  commit.resolve(ok(undefined))
  await advance(29_999)
  expect(restarted.generation()).toBe('1')
  await advance(1)
  expect(restarted.generation()).toBe('2')
})

it('reconnect waits for Ready and only the replacement socket can set lower generation floors', async () => {
  const db = database()
  db.layout = layout('50')
  const c = await ready(open(db))
  const oldLayout = deferred<Result<SectionLayout>>(), oldList = deferred<Result<{ channels: typeof db.rows }>>()
  c.getLayout.mockClear().mockReturnValueOnce(oldLayout.promise)
  c.list.mockClear().mockReturnValueOnce(oldList.promise)
  const staleMessage = c.socket().onmessage!
  c.event({ type: 'channel_list_changed' })
  await advance()
  c.event({ type: 'sections_changed', generation: '99' })
  c.socket().onclose?.({ code: 4008 })
  await advance(1500)
  expect(c.sockets).toHaveLength(2)
  c.socket().onopen?.()
  c.sections.retry()
  void c.session.channels.load()
  oldLayout.resolve(ok(layout('100', ['old'])))
  oldList.resolve(ok({ channels: [row('old')] }))
  await advance(500)
  expect(c.getLayout).toHaveBeenCalledOnce()
  expect(c.list).toHaveBeenCalledOnce()
  expect(c.generation()).toBe('50')
  db.layout = layout('2', ['fresh', 'A'])
  db.rows = [row('A'), row('fresh')]
  await c.ready()
  staleMessage({ data: JSON.stringify({ type: 'sections_changed', generation: '100' }) })
  await advance()
  expect(c.getLayout).toHaveBeenCalledTimes(2)
  expect(c.list).toHaveBeenCalledTimes(2)
  expect(c.generation()).toBe('2')
  expect(c.groups()).toEqual([['S', ['fresh', 'A']], [null, []]])
})

it('O5 and notices coalesce under Retry-After and timed-out layout work cannot publish', async () => {
  const c = await ready(open(database(), { timeoutMs: 500 }))
  await advance(14_400)
  const timedOut = deferred<Result<SectionLayout>>()
  c.getLayout.mockClear()
    .mockReturnValueOnce(timedOut.promise)
    .mockResolvedValueOnce({ ...http(429, 'rate limited'), retryAfterMs: 1500 })
  c.event({ type: 'sections_changed', generation: '2' })
  await advance(700)
  expect(c.getLayout.mock.calls[0]?.[0].aborted).toBe(true)
  c.event({ type: 'sections_changed', generation: '3' })
  timedOut.resolve(ok(layout('100', ['forbidden'])))
  await advance(750)
  expect(c.getLayout).toHaveBeenCalledTimes(2)
  expect(c.generation()).toBe('1')
  c.db.layout = layout('3', ['A'], 'Recovered')
  c.event({ type: 'activity_reset' })
  await advance(1499)
  expect(c.getLayout).toHaveBeenCalledTimes(2)
  await advance(1)
  expect(c.getLayout).toHaveBeenCalledTimes(3)
  expect(c.generation()).toBe('3')
})

it('a timed-out mutation fences its overlapping read and recovers without a retry', async () => {
  const c = await ready(open(database(), { timeoutMs: 600 }))
  const late = deferred<Result<CreatedSection>>(), crossed = deferred<Result<SectionLayout>>()
  c.sectionsApi.create.mockReturnValueOnce(late.promise)
  c.getLayout.mockReturnValueOnce(crossed.promise)
  const writing = c.sections.create({ id: 'S2', name: 'New' })
  c.sections.retry()
  await advance(600)
  await expect(writing).resolves.toEqual(network)
  expect(c.sectionsApi.create.mock.calls[0]?.[1].aborted).toBe(true)
  crossed.resolve(ok(layout('99', ['A'], 'Stale')))
  late.resolve(ok({ id: 'S2', generation: '10' }))
  await advance(0)
  expect(c.generation()).toBe('1')
  c.db.layout = layout('2', ['A'], 'Recovered')
  await advance()
  expect(c.generation()).toBe('2')
  expect(c.sectionsApi.create).toHaveBeenCalledOnce()
})

it('hung placement GETs settle and abort at the deadline and on close', async () => {
  const c = await ready(open(database(), { timeoutMs: 600 }))
  const late = deferred<Result<ChannelPlacement>>(), pending = deferred<Result<ChannelPlacement>>()
  c.sectionsApi.placement.mockReturnValueOnce(late.promise).mockReturnValueOnce(pending.promise)
  const settled = vi.fn()
  const reading = c.sections.placement('A').then(settled)
  const signal = c.sectionsApi.placement.mock.calls[0][1]
  await advance(599)
  expect(settled).not.toHaveBeenCalled()
  expect(signal.aborted).toBe(false)
  await advance(1)
  await reading
  expect(settled).toHaveBeenCalledExactlyOnceWith(network)
  expect(signal.aborted).toBe(true)
  late.resolve(http(404, 'channel not found'))
  await advance(0)
  expect(c.groups()).toEqual([['S', ['A']], [null, []]])

  const closing = c.sections.placement('A')
  const closingSignal = c.sectionsApi.placement.mock.calls[1][1]
  c.session.close()
  await expect(closing).resolves.toEqual({ ok: false, kind: 'inactive' })
  expect(closingSignal.aborted).toBe(true)
})

it('an ordinary layout refusal stops retrying and a later invalidation recovers', async () => {
  const c = await ready()
  c.getLayout.mockClear().mockResolvedValueOnce(http(400, 'invalid input'))
  c.event({ type: 'sections_changed', generation: '2' })
  await advance(5000)
  expect(c.getLayout).toHaveBeenCalledOnce()
  expect(c.sections.get().error).toEqual(http(400, 'invalid input'))
  c.db.layout = layout('2')
  c.sections.retry()
  await advance()
  expect(c.generation()).toBe('2')
  expect(c.sections.get().error).toBeUndefined()
})

it.each([4001, 4003, 401, 404])('terminal %i fences layout and writes while an independent Session remains usable', async status => {
  const c = await ready(), control = await ready(open(database(), { organizationId: 'other' }))
  const pending = deferred<Result<SectionLayout>>()
  c.getLayout.mockReturnValueOnce(pending.promise)
  c.sections.retry()
  await advance()
  if (status >= 4000) c.socket().onclose?.({ code: status })
  else pending.resolve(status === 401 ? http(401, 'invalid credentials') : http(404, 'organization_unavailable'))
  await advance(0)
  c.getLayout.mockClear(); c.list.mockClear()
  c.event({ type: 'sections_changed', generation: '9' })
  await expect(c.sections.delete('S')).resolves.toMatchObject({ kind: 'inactive' })
  pending.resolve(ok(layout('9', ['old'])))
  control.db.layout = layout('2')
  control.event({ type: 'sections_changed', generation: '2' })
  await advance(40_000)
  expect(c.getLayout).not.toHaveBeenCalled()
  expect(c.list).not.toHaveBeenCalled()
  expect(c.groups()).toEqual([[null, []]])
  expect(c.onEnded).toHaveBeenCalledTimes(status === 401 || status === 4001 ? 1 : 0)
  expect(control.generation()).toBe('2')
})

it.each([false, true])('an old Organization result cannot affect its replacement, including Account replacement=%s', async replaced => {
  const account = new AbortController()
  const first = await ready(open(database(), { accountSignal: account.signal }))
  const late = deferred<Result<SectionLayout>>()
  first.getLayout.mockReturnValueOnce(late.promise)
  first.sections.retry()
  await advance()
  first.session.close()
  if (replaced) account.abort()
  const current = await ready(open(database(), { organizationId: 'current' }))
  late.resolve(http(401, 'invalid credentials'))
  await advance(0)
  expect(first.onEnded).toHaveBeenCalledTimes(replaced ? 0 : 1)
  expect(first.groups()).toEqual([[null, []]])
  expect(current.groups()).toEqual([['S', ['A']], [null, []]])
})

it('consecutive below-floor section layouts back off without showing an error and converge on reconnect', async () => {
  const c = await ready()
  c.getLayout.mockClear()
  c.event({ type: 'sections_changed', generation: '5' })
  // Server keeps returning generation '1' (below observed floor '5').
  await advance(200); expect(c.getLayout).toHaveBeenCalledTimes(1)
  await advance(200); expect(c.getLayout).toHaveBeenCalledTimes(2)
  await advance(200); expect(c.getLayout).toHaveBeenCalledTimes(3)
  expect(c.sections.get().error).toBeUndefined()
  expect(c.generation()).toBe('1')
  // In A10 backoff (random=0.5 -> 750 ms), no eager 200 ms follow-up fires.
  await advance(749); expect(c.getLayout).toHaveBeenCalledTimes(3)
  await advance(1); expect(c.getLayout).toHaveBeenCalledTimes(4)
  expect(c.sections.get().error).toBeUndefined()
  // Reconnect resets version floors and backoff, converging on a post-restore lower baseline.
  c.socket().onclose?.({ code: 1006 })
  await advance(5000)
  expect(c.getLayout).toHaveBeenCalledTimes(4)
  c.db.layout = layout('2', ['A'])
  c.socket().onopen?.()
  c.event({ type: 'activity_ready' })
  await advance(200)
  expect(c.getLayout).toHaveBeenCalledTimes(5)
  expect(c.generation()).toBe('2')
  expect(c.sections.get().error).toBeUndefined()
})
