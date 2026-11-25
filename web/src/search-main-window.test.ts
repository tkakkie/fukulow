import { afterEach, expect, it, vi } from 'vitest'
import { record } from './adapter-test-helpers.svelte'
import type { Result, TimelinePage } from './api'
import { moveEvent } from './protocol-test-helpers'
import { deferred } from './topic-test-helpers'
import { flushSearch, isProbe, networkError, records, searchTimelineFixture } from './search-main-test-helpers'

afterEach(() => vi.useRealTimers())

it('shows Topic summary lines outside the live window in normal timeline order while staying cursor-neutral', async () => {
  const f = searchTimelineFixture([
    ...records(1, 5, 'ancient'), ...records(6, 30), ...records(33, 35, 'old'),
    record(40), ...records(47, 48, 'middle'), record(55), record(499), record(500),
  ], 500)
  try {
    await f.open()
    const initial = [...records(6, 30).map(m => `m:${m.created_seq}`), 't:old@35:3', 'm:40', 't:middle@48:2', 'm:55', 'm:499', 'm:500']
    expect(f.lines()).toEqual(initial)
    expect(f.read.mock.calls.slice(0, 3).map(([query]) => [query.as_of_seq, query.after_position, query.before_position])).toEqual([
      [undefined, undefined, undefined], [500, 39, undefined], [500, undefined, 40],
    ])
    expect(f.rawRead.mock.calls.every(([, query]) => query?.after_seq === undefined && query?.before_seq === undefined)).toBe(true)
    await f.anchor.loadOlder()
    expect(f.lines()).toEqual(['t:ancient@5:5', ...initial])
    expect(f.cursor()).toBe(500)
  } finally { f.close() }
})

it('keeps Channel-level rows within bounds in a Topic-heavy Channel using fixed-W timeline pages', async () => {
  const topics = Array.from({ length: 5 }, (_, i) => records(51 + i * 10, 60 + i * 10, `T${i}`)).flat()
  const f = searchTimelineFixture([
    ...records(1, 50), ...topics, record(101), ...records(102, 161, 'heavy'), ...records(162, 200),
  ], 250)
  try {
    await f.open({ channelId: 'A', messageId: 'id101', createdSeq: 101 })
    expect(f.anchor.get()?.messages).toHaveLength(51)
    expect(f.anchor.get()?.lines).toHaveLength(57)
    expect(f.lines()?.filter(line => line.startsWith('t:'))).toEqual(['t:T0@60:10', 't:T1@70:10',
      't:T2@80:10', 't:T3@90:10', 't:T4@100:10', 't:heavy@161:60'])
    expect(f.cursor()).toBe(250)
  } finally { f.close() }
})

it.each([
  'completes the newer side in one after_position read even with 100 hidden Topics under 100 ms latency',
  'completes the newer side in one after_position read over a dense 100-hidden-Topic store under 100 ms latency (data-driven)',
])('%s', async () => {
  vi.useFakeTimers()
  const f = searchTimelineFixture([
    record(30), record(40), ...records(141, 175),
    ...Array.from({ length: 100 }, (_, i) => [{ ...record(41 + i), topic_id: `T${i}` },
      { ...record(201 + i), topic_id: `T${i}` }]).flat(),
  ], 500)
  try {
    f.read.mockImplementation(async query => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return f.serve(query)
    })
    const opening = f.open()
    await vi.advanceTimersByTimeAsync(350)
    await opening
    expect(f.anchor.get()?.status).toBe('ready')
    expect(f.anchor.get()?.messages).toHaveLength(27)
    expect(f.lines()?.some(line => line.startsWith('t:'))).toBe(false)
    expect(f.read.mock.calls.filter(([query]) => query.after_position !== undefined)).toHaveLength(1)
    expect(f.cursor()).toBe(500)
  } finally { f.close() }
})

it('refreshes all visible Topic baselines on Move even when one Topic has more than 101 raw Messages', async () => {
  const big = records(11, 158, 'big'), moved = { ...record(170), topic_id: 'source' }
  const f = searchTimelineFixture([record(10), ...big, record(160), ...records(161, 162, 'source'),
    moved, record(180), record(190)], 250)
  try {
    await f.open({ channelId: 'A', messageId: 'id160', createdSeq: 160 })
    expect(f.lines()).toEqual(['m:10', 't:big@158:148', 'm:160', 't:source@170:3', 'm:180', 'm:190'])
    f.put({ ...moved, topic_id: 'big', version: 251 })
    f.net.event({ ...moveEvent(251, moved.id), source_topic_id: 'source', destination_topic_id: 'big' })
    await flushSearch()
    expect(f.lines()).toEqual(['m:10', 'm:160', 't:source@162:2', 't:big@170:149', 'm:180', 'm:190'])
    expect(f.anchor.get()?.asOfSeq).toBe(251)
    expect(f.cursor()).toBe(251)
  } finally { f.close() }
})

it('refreshes the source Topic count when a non-latest Message moves into an off-window Topic', async () => {
  const moved = { ...record(31), topic_id: 'source' }
  const f = searchTimelineFixture([record(20), moved, { ...record(35), topic_id: 'source' },
    record(40), ...records(41, 75), { ...record(96), topic_id: 'other' }])
  try {
    await f.open()
    expect(f.lines()).toContain('t:source@35:2')
    f.put({ ...moved, topic_id: 'other', version: 101 })
    f.net.event({ ...moveEvent(101, moved.id), source_topic_id: 'source', destination_topic_id: 'other' })
    await flushSearch()
    expect(f.lines()).toContain('t:source@35:1')
    expect(f.lines()?.some(line => line.startsWith('t:other@'))).toBe(false)
  } finally { f.close() }
})

it.each(['move', 'delete'] as const)('coalesces a bounded projection refresh when an off-window %s brings an unheld Topic into the held range', async kind => {
  const off = { ...record(90), topic_id: 'T' }
  const f = searchTimelineFixture([record(20), { ...record(35), topic_id: 'T' }, record(40),
    ...records(41, 75), off])
  const probe = deferred<Result<TimelinePage>>()
  try {
    await f.open()
    expect(f.lines()?.some(line => line.startsWith('t:T@'))).toBe(false)
    const changed = { ...off, topic_id: kind === 'move' ? 'other' : off.topic_id, version: 101, deleted: kind === 'delete' }
    f.put(changed)
    f.read.mockImplementationOnce(async () => probe.promise)
    f.net.event(kind === 'move' ? { ...moveEvent(101, off.id), source_topic_id: 'T', destination_topic_id: 'other' }
      : { type: 'message', kind: 'delete', seq: 101, message: changed })
    await flushSearch()
    const overtaken = f.serve({ limit: 1 })
    for (let seq = 102; seq <= 106; seq++) {
      const tombstone = { ...record(seq - 1), version: seq, deleted: true }
      f.put(tombstone)
      f.net.event({ type: 'message', kind: 'delete', seq, message: tombstone })
    }
    probe.resolve(overtaken)
    await flushSearch()
    expect(f.lines()).toContain('t:T@35:1')
    expect(f.read.mock.calls.filter(([query]) => isProbe(query))).toHaveLength(3)
    expect(f.anchor.get()?.asOfSeq).toBe(106)
  } finally { f.close() }
})

it('refreshes count on non-latest Topic Message delete and hides a deleted latest body even if refresh fails (C1)', async () => {
  const topic = records(31, 35, 'T')
  const f = searchTimelineFixture([record(20), ...topic, record(40)])
  try {
    await f.open()
    expect(f.lines()).toContain('t:T@35:5')
    const remove = { ...topic[0], version: 101, deleted: true }
    f.put(remove)
    f.net.event({ type: 'message', kind: 'delete', seq: 101, message: remove })
    await flushSearch()
    expect(f.lines()).toContain('t:T@35:4')
    f.read.mockResolvedValue(networkError)
    const removeLatest = { ...topic.at(-1)!, version: 102, deleted: true }
    f.put(removeLatest)
    f.net.event({ type: 'message', kind: 'delete', seq: 102, message: removeLatest })
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ status: 'error', pageError: 'refresh', lines: [], messages: [] })
  } finally { f.close() }
})

it('refreshes retained Topic baselines when an expired older continuation adopts a fresh W', async () => {
  const moved = { ...record(35), topic_id: 'source' }
  const f = searchTimelineFixture([...records(1, 30), { ...record(32), topic_id: 'source' }, moved, record(40)])
  try {
    await f.open()
    expect(f.lines()).toContain('t:source@35:2')
    f.put({ ...moved, topic_id: 'destination', version: 101 })
    await f.anchor.loadOlder()
    expect(f.anchor.get()).toMatchObject({ asOfSeq: 101, hasOlder: false })
    expect(f.lines()).toEqual([...records(1, 30).map(m => `m:${m.created_seq}`), 't:source@32:1', 't:destination@35:1', 'm:40'])
    expect(f.cursor()).toBe(100)
  } finally { f.close() }
})

it('leaves no deleted live evidence in a Topic line when a live Topic Message is created and then deleted', async () => {
  const f = searchTimelineFixture([record(20), record(40)])
  try {
    await f.open()
    const create = { ...record(101), topic_id: 'T' }
    f.put(create)
    f.net.event({ type: 'message', kind: 'create', seq: 101, message: create })
    await flushSearch()
    expect(f.lines()).toContain('t:T@101:1')
    const remove = { ...create, deleted: true, version: 102 }
    f.put(remove)
    f.net.event({ type: 'message', kind: 'delete', seq: 102, message: remove })
    expect(f.lines()).not.toContain('t:T@101:1')
    await flushSearch()
    expect(f.lines()).toEqual(['m:20', 'm:40'])
  } finally { f.close() }
})

it('refreshes baselines on Move, follows live Topic activity without patching counts, and clears baselines on cursor clamp', async () => {
  vi.useFakeTimers()
  const start = { ...record(35), topic_id: 'T' }
  const f = searchTimelineFixture([record(20), start, record(40)])
  try {
    await f.open()
    const live = { ...record(101), topic_id: 'T' }
    f.put(live)
    f.net.event({ type: 'message', kind: 'create', seq: 101, message: live })
    await flushSearch()
    expect(f.lines()).toEqual(['m:20', 'm:40', 't:T@101:2'])
    f.put({ ...start, version: 102, topic_id: 'new' })
    f.net.event({ ...moveEvent(102, start.id), source_topic_id: 'T', destination_topic_id: 'new' })
    await flushSearch()
    expect(f.lines()).toEqual(['m:20', 't:new@35:1', 'm:40', 't:T@101:1'])
    f.net.socket.onClose(1001)
    await vi.advanceTimersByTimeAsync(1000)
    f.net.socket.onReady()
    f.net.subscribed('A', 80)
    expect(f.anchor.get()).toMatchObject({ status: 'loading', lines: [], messages: [] })
    await flushSearch()
    expect(f.anchor.get()?.status).toBe('ready')
  } finally { f.close() }
})

it.each([
  'keeps distinct retained Message bodies within reserveSearch (100) across Topic baselines and live arrivals',
  'keeps distinct retained Message bodies within reserveSearch (100) across live updates to 25 held Topic baselines (data-driven)',
])('%s', async () => {
  const topics = Array.from({ length: 25 }, (_, i) => ({ ...record(41 + i), topic_id: `T${i}` }))
  const f = searchTimelineFixture([record(40), ...topics, ...records(66, 90)])
  try {
    await f.open()
    await f.anchor.loadNewer()
    expect(f.anchor.get()?.hasNewer).toBe(false)
    for (let i = 0; i < 25; i++) {
      const live = { ...record(101 + i), topic_id: topics[i].topic_id }
      f.put(live)
      f.net.event({ type: 'message', kind: 'create', seq: live.created_seq, message: live })
    }
    await flushSearch()
    expect(f.anchor.get()?.lines.filter(l => l.kind === 'topic' && l.messageCount === 2)).toHaveLength(25)
    for (const message of records(126, 184)) {
      f.put(message)
      f.net.event({ type: 'message', kind: 'create', seq: message.created_seq, message })
    }
    const lines = f.anchor.get()!.lines
    const bodies = lines.flatMap(l => l.kind === 'message' ? [l.message.id] : [l.latestMessage.id, l.baseline?.summary.latest_message.id])
    expect(new Set(bodies.filter(Boolean)).size).toBe(100)
    expect(f.anchor.get()?.detached).toBe(true)
  } finally { f.close() }
})

it('keeps following the live edge through live Topic Messages and across older paging until the capacity limit', async () => {
  const f = searchTimelineFixture(records(1, 50))
  try {
    await f.open()
    const t = { ...record(101), topic_id: 'T' }
    f.put(t)
    f.net.event({ type: 'message', kind: 'create', seq: 101, message: t })
    await flushSearch()
    await f.anchor.loadOlder()
    expect(f.lines()?.at(-1)).toBe('t:T@101:1')
    expect(f.anchor.get()).toMatchObject({ hasNewer: false, hasOlder: false, detached: false })
    const m = record(102)
    f.put(m)
    f.net.event({ type: 'message', kind: 'create', seq: 102, message: m })
    expect(f.lines()?.at(-1)).toBe('m:102')
    for (const arrival of records(103, 152)) {
      f.put(arrival)
      f.net.event({ type: 'message', kind: 'create', seq: arrival.created_seq, message: arrival })
    }
    expect(f.anchor.get()?.detached).toBe(true)
    expect(f.anchor.get()?.lines).toHaveLength(100)
  } finally { f.close() }
})

it('queues a coalesced refresh behind an in-flight loadOlder when a live Topic Create arrives', async () => {
  const f = searchTimelineFixture(records(1, 40))
  const older = deferred<Result<TimelinePage>>()
  try {
    await f.open()
    const page = f.anchor.loadOlder()
    f.read.mockImplementationOnce(async () => older.promise)
    await flushSearch()
    const arrivals = records(101, 103, 'T')
    for (const message of arrivals) {
      f.put(message)
      f.net.event({ type: 'message', kind: 'create', seq: message.created_seq, message })
    }
    expect(f.read.mock.calls.filter(([query]) => isProbe(query))).toHaveLength(1)
    older.resolve(f.serve({ as_of_seq: 100, before_position: 15, limit: 25 }))
    await page
    await flushSearch()
    expect(f.read.mock.calls.filter(([query]) => isProbe(query))).toHaveLength(2)
    expect(f.anchor.get()).toMatchObject({ hasOlder: false, detached: false, asOfSeq: 103 })
    expect(f.lines()?.at(-1)).toBe('t:T@103:3')
  } finally { f.close() }
})

it('preserves sticky capacity detach across an in-flight refresh when a new Topic overflows during a delayed probe', async () => {
  const existing = { ...record(39), topic_id: 'T-A' }
  const f = searchTimelineFixture([...records(14, 38), existing, record(40), ...records(41, 50)])
  const delayed = deferred<Result<TimelinePage>>()
  const receive = (message: ReturnType<typeof record>) => {
    f.put(message)
    f.net.event({ type: 'message', kind: 'create', seq: message.created_seq, message })
  }
  try {
    await f.open()
    for (const message of records(101, 163)) receive(message)
    expect(f.anchor.get()).toMatchObject({ detached: false })
    expect(f.lines()).toHaveLength(100)
    f.read.mockImplementationOnce(async () => delayed.promise)
    receive({ ...record(164), topic_id: 'T-A' })
    await flushSearch()
    receive({ ...record(165), topic_id: 'T-B' })
    expect(f.anchor.get()?.detached).toBe(true)
    receive({ ...record(166), topic_id: 'T-A' })
    delayed.resolve(f.serve({ limit: 1 }))
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ detached: true, hasNewer: true, asOfSeq: 166 })
    expect(f.lines()?.some(line => line.startsWith('t:T-B@'))).toBe(false)
  } finally { f.close() }
})

it('detaches directly when the live channel exceeds the continuity limit ahead of forwardWatermark', async () => {
  const f = searchTimelineFixture([record(30), record(40)])
  try {
    await f.ready()
    for (const message of records(101, 501, 'busy')) {
      f.net.event({ type: 'message', kind: 'create', seq: message.created_seq, message })
    }
    expect(f.session.sync.get().channels.A.messages[0]?.created_seq).toBe(102)
    f.anchor.open({ channelId: 'A', messageId: 'id40', createdSeq: 40 })
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ status: 'ready', hasNewer: false, detached: true })
    expect(f.lines()).toEqual(['m:30', 'm:40'])
    expect(f.read).toHaveBeenCalledTimes(3)
  } finally { f.close() }
})
