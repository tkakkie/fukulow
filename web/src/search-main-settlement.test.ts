import { expect, it } from 'vitest'
import { ok, record } from './adapter-test-helpers.svelte'
import type { Result, TimelinePage } from './api'
import { deferred } from './topic-test-helpers'
import { flushSearch, isProbe, networkError, records, searchTimelineFixture, target } from './search-main-test-helpers'

type Fixture = ReturnType<typeof searchTimelineFixture>
async function lostSend(f: Fixture, seq: number, topic_id: string | null = null) {
  const pending = f.session.sync.getTimeline('A').send('lost acknowledgement')
  f.net.sends.at(-1)!.resolve(networkError)
  await pending
  const [send] = f.session.sync.get().channels.A.pending
  expect(send.state).toBe('unknown')
  return { ...record(seq), sender: 'me', topic_id, client_message_id: send.clientMessageId }
}
const pending = (f: Fixture) => f.session.sync.get().channels.A.pending

it('settles unknown own sends from main search reads and from the fresh-W limit:1 probe without moving the cursor', async () => {
  const f = searchTimelineFixture([...records(1, 30), record(40), record(90)])
  try {
    await f.ready()
    f.put(await lostSend(f, 35, 'T'))
    f.anchor.open(target)
    await flushSearch()
    expect(pending(f)).toEqual([])
    f.put(await lostSend(f, 102))
    f.put({ ...record(91), version: 101, deleted: true })
    await f.anchor.loadOlder()
    expect(pending(f)).toEqual([])
    expect(f.cursor()).toBe(100)
  } finally { f.close() }
})

it('settles own unknown sends returned on newer after_position timeline pages without raw list_messages reads', async () => {
  const f = searchTimelineFixture([...records(30, 80), record(100)])
  try {
    await f.open()
    const own = await lostSend(f, 90)
    f.put(own)
    await f.anchor.loadNewer()
    expect(pending(f)).toEqual([])
    expect(f.anchor.get()?.messages).toContainEqual(own)
    expect(f.rawRead.mock.calls.every(([, query]) => query?.after_seq === undefined && query?.before_seq === undefined)).toBe(true)
    expect(f.cursor()).toBe(100)
  } finally { f.close() }
})

it('settles an own unknown send from an overtaken newer page even when the fresh retry probe fails', async () => {
  const f = searchTimelineFixture(records(30, 90))
  const stale = deferred<Result<TimelinePage>>()
  try {
    await f.open()
    const own = await lostSend(f, 90)
    f.put(own)
    const beforeEdit = f.serve({ as_of_seq: 100, after_position: 65, limit: 25 })
    f.read.mockImplementation(async query => isProbe(query) ? networkError : stale.promise)
    const page = f.anchor.loadNewer()
    await flushSearch()
    const edit = { ...record(99), version: 101, body: 'edited' }
    f.put(edit)
    f.net.event({ type: 'message', kind: 'edit', seq: 101, message: edit })
    stale.resolve(beforeEdit)
    await page
    await flushSearch()
    expect(pending(f)).toEqual([])
    expect(f.anchor.get()).toMatchObject({ status: 'error', lines: [], messages: [] })
    expect(f.read.mock.calls.filter(([query]) => isProbe(query))).toHaveLength(2)
    expect(f.cursor()).toBe(101)
  } finally { f.close() }
})

it('settles an own unknown send beyond 200 raw Topic Messages in one after_position read (data-driven)', async () => {
  const f = searchTimelineFixture([record(40), ...records(41, 260, 'busy'), record(301)], 301)
  try {
    await f.ready()
    f.put(await lostSend(f, 300))
    f.anchor.open(target)
    await flushSearch()
    expect(pending(f)).toEqual([])
    expect(f.lines()).toEqual(['m:40', 't:busy@260:220', 'm:300', 'm:301'])
    expect(f.read.mock.calls.filter(([query]) => query.after_position !== undefined)).toHaveLength(1)
    expect(f.cursor()).toBe(301)
  } finally { f.close() }
})

it('settles an own unknown send from the initial newer page immediately even if a hit Delete cancels the pending older companion', async () => {
  const f = searchTimelineFixture([record(30), record(40), record(90)])
  const older = deferred<Result<TimelinePage>>()
  try {
    await f.ready()
    f.put(await lostSend(f, 50))
    f.read.mockImplementation(async query => query.before_position === 40 ? older.promise : f.serve(query))
    f.anchor.open(target)
    await flushSearch()
    expect(f.anchor.get()?.status).toBe('loading')
    expect(pending(f)).toEqual([])
    const remove = { ...record(40), version: 101, deleted: true }
    f.put(remove)
    f.net.event({ type: 'message', kind: 'delete', seq: 101, message: remove })
    const original = f.serve({ before_position: 40 })
    older.resolve(original.ok ? ok({ ...original.data, as_of_seq: 100 }) : original)
    await flushSearch()
    expect(f.anchor.get()).toMatchObject({ status: 'missing', lines: [], messages: [] })
    expect(pending(f)).toEqual([])
    expect(f.cursor()).toBe(101)
  } finally { f.close() }
})
