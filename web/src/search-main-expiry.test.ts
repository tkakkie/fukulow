import { expect, it, vi } from 'vitest'
import { record } from './adapter-test-helpers.svelte'
import type { Message, Result, TimelinePage } from './api'
import { deferred } from './topic-test-helpers'
import { expired, flushSearch, isProbe, networkError, records, searchTimelineFixture, target } from './search-main-test-helpers'

const topic = { ...record(35), topic_id: 'T' }
const deleted = (message: Message, version = 101) => ({ ...message, deleted: true, version })
const empty = { lines: [], messages: [], asOfSeq: undefined }
const store = [record(20), topic, ...records(40, 75)]
const load = (fixture: ReturnType<typeof searchTimelineFixture>, direction: 'older' | 'newer') =>
  direction === 'older' ? fixture.anchor.loadOlder() : fixture.anchor.loadNewer()

it.each(['older', 'newer'] as const)('withholds expired Topic excerpts immediately on %s snapshot_expired before the retry completes (C1)', async direction => {
  // A dense older page keeps both continuation directions available.
  const f = searchTimelineFixture([...records(1, 30), ...store.filter(m => m.id !== 'id20')])
  const retry = deferred<Result<TimelinePage>>()
  try {
    await f.open()
    const visit = f.anchor.get()!.visit
    expect(f.lines()).toContain('t:T@35:1')
    f.put(deleted(topic))
    f.read.mockImplementation(async query => isProbe(query) ? retry.promise : f.serve(query))
    const pending = load(f, direction)
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ ...empty, visit, status: 'loading', paging: true })
    expect(f.read.mock.calls.filter(([query]) => isProbe(query))).toHaveLength(2)
    retry.resolve(f.serve({ limit: 1 }))
    await pending
    expect(f.anchor.get()).toMatchObject({ visit, status: 'ready', asOfSeq: 101 })
    expect(f.lines()).not.toContain('t:T@35:1')
    expect(f.cursor()).toBe(100)
  } finally { f.close() }
})

it.each(['older', 'newer'] as const)('clears expired held Topic excerpts when a %s continuation retry reread fails before a Delete replays (C1)', async direction => {
  const f = searchTimelineFixture([...records(1, 30), ...store.filter(m => m.id !== 'id20')])
  try {
    await f.open()
    expect(f.lines()).toContain('t:T@35:1')
    f.put(deleted(topic))
    f.read.mockImplementation(async query => query.as_of_seq === 101 ? networkError : f.serve(query))
    await load(f, direction)
    expect(f.anchor.get()).toMatchObject({ ...empty, status: 'error', paging: false })
    f.read.mockImplementation(async query => f.serve(query))
    await f.anchor.retry()
    expect(f.anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 101 })
    expect(f.lines()).not.toContain('t:T@35:1')
    expect(f.cursor()).toBe(100)
  } finally { f.close() }
})

it('keeps expired Topic excerpts hidden if Organization access is lost during a snapshot_expired retry (C1)', async () => {
  const f = searchTimelineFixture(store)
  const retry = deferred<Result<TimelinePage>>()
  try {
    await f.open()
    expect(f.lines()).toContain('t:T@35:1')
    f.put(deleted(topic))
    f.read.mockImplementation(async query => isProbe(query) ? retry.promise : f.serve(query))
    const pending = f.anchor.loadNewer()
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ ...empty, status: 'loading' })
    retry.resolve({ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' })
    await pending
    expect(f.session.sync.get().organization).toBe('unavailable')
    expect(f.anchor.get()).toMatchObject({ ...empty, status: 'missing', paging: false, hasOlder: false, hasNewer: false })
  } finally { f.close() }
})

it('never displays the deleted Topic body when Delete replay arrives after the replacement snapshot', async () => {
  const prior = { ...record(33), topic_id: 'T' }
  const remove = deleted(topic)
  const f = searchTimelineFixture([prior, ...store])
  try {
    await f.open()
    expect(f.lines()).toContain('t:T@35:2')
    f.put(remove)
    const observed: string[][] = []
    f.anchor.subscribe(() => observed.push(f.lines() ?? []))
    // Ignore the pre-expiry paging notification. Record every subsequent publication.
    const reading = f.anchor.loadNewer()
    observed.length = 0
    await reading
    expect(f.lines()).toContain('t:T@33:1')
    expect(f.cursor()).toBe(100)
    f.net.event({ type: 'message', kind: 'delete', seq: 101, message: remove })
    await flushSearch()
    expect(f.cursor()).toBe(101)
    expect(f.lines()).toContain('t:T@33:1')
    expect(observed).toContainEqual([])
    expect(observed.flat().some(line => line.startsWith('t:T@35:'))).toBe(false)
  } finally { f.close() }
})

it('drops every old snapshot line and body before retry and keeps them absent when the retry fails', async () => {
  const f = searchTimelineFixture(store)
  const retry = deferred<Result<TimelinePage>>()
  try {
    await f.open()
    expect(f.lines()).toEqual(expect.arrayContaining(['m:20', 't:T@35:1', 'm:40']))
    const seen: { status?: string; bodies: string[] }[] = []
    f.put(deleted(topic))
    f.read.mockImplementation(async query => isProbe(query) ? retry.promise : f.serve(query))
    const paging = f.anchor.loadNewer()
    const stop = f.anchor.subscribe(() => {
      const view = f.anchor.get()
      seen.push({ status: view?.status, bodies: view?.lines.map(line => line.kind === 'topic' ? line.latestMessage.id : line.message.id) ?? [] })
    })
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ ...empty, status: 'loading' })
    retry.resolve(networkError)
    await paging
    expect(f.anchor.get()).toMatchObject({ ...empty, status: 'error' })
    expect(seen.at(-1)?.status).toBe('error')
    expect(seen.every(view => view.bodies.length === 0)).toBe(true)
    stop()
  } finally { f.close() }
})

it('clears expired held excerpts and shows error when the fresh-W probe succeeds but the retried older Topic page fails', async () => {
  const f = searchTimelineFixture([...records(1, 30), ...store.filter(m => m.id !== 'id20')])
  try {
    await f.open()
    f.put(deleted(topic))
    f.read.mockImplementation(async query => query.as_of_seq === 101 && query.before_position !== undefined
      ? networkError : f.serve(query))
    await f.anchor.loadOlder()
    expect(f.anchor.get()).toMatchObject({ ...empty, status: 'error', pageError: 'older' })
    expect(f.read.mock.calls.some(([query]) => query.as_of_seq === 101 && query.after_position !== undefined)).toBe(true)
  } finally { f.close() }
})

it.each([false, true])('retries refresh once at a fresh W after snapshot_expired and never leaves a deleted Topic excerpt visible (retryFails=%s)', async retryFails => {
  const f = searchTimelineFixture([record(20), topic, record(40)])
  const range = deferred<Result<TimelinePage>>()
  const retry = deferred<Result<TimelinePage>>()
  try {
    await f.open()
    const remove = deleted(topic)
    f.put(remove)
    f.read.mockImplementationOnce(async query => f.serve(query))
      .mockReturnValueOnce(range.promise)
      .mockReturnValueOnce(retry.promise)
    f.net.event({ type: 'message', kind: 'delete', seq: 101, message: remove })
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 100, paging: true })
    expect(f.lines()).toEqual(['m:20', 'm:40'])
    range.resolve(expired)
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ ...empty, status: 'loading' })
    retry.resolve(retryFails ? networkError : f.serve({ limit: 1 }))
    await flushSearch()
    expect(f.anchor.get()?.status).toBe(retryFails ? 'error' : 'ready')
    expect(f.lines()).toEqual(retryFails ? [] : ['m:20', 'm:40'])
    expect(f.read.mock.calls.filter(([query]) => isProbe(query))).toHaveLength(3)
  } finally { f.close() }
})

it('withholds unrevalidated Topic excerpts when a first refresh captures a newer W and its retained-range read fails before Delete replay', async () => {
  const f = searchTimelineFixture([record(20), topic, record(40)])
  try {
    await f.open()
    expect(f.lines()).toContain('t:T@35:1')
    const live = { ...record(101), topic_id: 'other' }
    const remove = deleted(topic, 102)
    f.put(live)
    f.put(remove)
    f.read.mockImplementation(async query => query.as_of_seq === 102 ? networkError : f.serve(query))
    f.net.event({ type: 'message', kind: 'create', seq: 101, message: live })
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ ...empty, status: 'error' })
    expect(f.cursor()).toBe(101)
    f.net.event({ type: 'message', kind: 'delete', seq: 102, message: remove })
    f.read.mockImplementation(async query => f.serve(query))
    await f.anchor.retry()
    expect(f.lines()).toEqual(['m:20', 'm:40', 't:other@101:1'])
    expect(f.cursor()).toBe(102)
  } finally { f.close() }
})

it('does not publish a deleted Topic body from an expired snapshot when 110 newer lines arrive before retry', async () => {
  const f = searchTimelineFixture(store)
  try {
    await f.open()
    f.put(deleted(topic))
    for (const message of records(102, 211)) f.put(message)
    const published: string[] = []
    const pending = f.anchor.loadNewer()
    f.anchor.subscribe(() => published.push(...f.lines() ?? []))
    await pending
    expect(f.anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 211 })
    expect(published.some(line => line.startsWith('t:T@35:'))).toBe(false)
    expect(f.anchor.get()!.lines.length).toBeLessThanOrEqual(100)
    expect(f.cursor()).toBe(100)
  } finally { f.close() }
})

it('fences a cancelled read and rechecks snapshot freshness across the helper microtask gap', async () => {
  const switched = searchTimelineFixture([record(30), record(40), record(60), record(70)])
  const mutated = searchTimelineFixture([record(30), topic, record(40)])
  try {
    await switched.ready()
    const switchView = { ...target, messageId: 'id70', createdSeq: 70 }
    const hold = deferred<Result<TimelinePage>>()
    const settleSwitch = switched.session.sync.settleHistory
    vi.spyOn(switched.session.sync, 'settleHistory').mockImplementation((channel, messages) => {
      if (messages.some(message => message.id === 'id30')) {
        queueMicrotask(() => switched.anchor.open(switchView))
        switched.read.mockImplementationOnce(async () => hold.promise)
      }
      return settleSwitch(channel, messages)
    })
    switched.anchor.open(target)
    await flushSearch()
    expect(switched.anchor.get()).toMatchObject({ target: switchView, status: 'loading', ...empty })
    hold.resolve(switched.serve({ limit: 1 }))
    await flushSearch()
    expect(switched.anchor.get()).toMatchObject({ target: switchView, status: 'ready' })

    await mutated.ready()
    const seen: string[] = []
    const settleMutation = mutated.session.sync.settleHistory
    vi.spyOn(mutated.session.sync, 'settleHistory').mockImplementation((channel, messages) => {
      if (messages.some(message => message.id === topic.id)) queueMicrotask(() => {
        const remove = deleted(topic)
        mutated.put(remove)
        mutated.net.event({ type: 'message', kind: 'delete', seq: 101, message: remove })
      })
      return settleMutation(channel, messages)
    })
    mutated.anchor.subscribe(() => seen.push(...mutated.lines() ?? []))
    mutated.anchor.open(target)
    await flushSearch()
    expect(seen).not.toContain('t:T@35:1')
    expect(mutated.anchor.get()).toMatchObject({ status: 'ready', asOfSeq: 101 })
    expect(mutated.lines()).toEqual(['m:30', 'm:40'])
  } finally { switched.close(); mutated.close() }
})
