import { afterEach, expect, it, vi } from 'vitest'
import { needsUnreadRecord } from './unread-counts'
import { held, retentionClient, type RetentionClient } from './unread-retention-test-helpers'
import { flush, msg, ok, row } from './unread-test-helpers'
import type { ChannelList, ReadPosition } from './api'

const mode = vi.hoisted(() => ({ prune: true }))
vi.mock('./unread-counts', async importOriginal => {
  const actual = await importOriginal<typeof import('./unread-counts')>()
  return { ...actual, needsUnreadRecord: (...args: Parameters<typeof actual.needsUnreadRecord>) => !mode.prune || actual.needsUnreadRecord(...args) }
})
afterEach(() => { mode.prune = true })

it.each([
  { name: 'baseline subtraction and future reads', baseline: { asOfSeq: 8, readSeq: 3, count: 4 }, aggregate: Infinity, visit: Infinity, first: 4 },
  { name: 'aggregate held suffix', baseline: { asOfSeq: 8, readSeq: 8, count: 0 }, aggregate: 3, visit: Infinity, first: 4 },
  { name: 'fixed visit', baseline: { asOfSeq: 8, readSeq: 8, count: 0 }, aggregate: Infinity, visit: 3, first: 4 },
  { name: 'unresolved visit', baseline: { asOfSeq: 8, readSeq: 8, count: 0 }, aggregate: Infinity, visit: 0, first: 1 },
  { name: 'missing baseline', baseline: undefined, aggregate: 8, visit: Infinity, first: 1 },
])('keeps the first row inside the $name window and excludes its boundary', ({ baseline, aggregate, visit, first }) => {
  expect(needsUnreadRecord(first - 1, baseline, aggregate, visit)).toBe(false)
  expect(needsUnreadRecord(first, baseline, aggregate, visit)).toBe(true)
})

it.each([null, 'T'])('keeps %s baseline rows after local read progress until a fresh baseline supersedes them', async topicId => {
  const c = retentionClient(); await c.boot(); c.feed([msg(2, topicId), msg(3, topicId), msg(4, topicId)])
  await c.baseline(4, 1, topicId === null ? 3 : 0, 3)
  if (topicId) c.topic(topicId, 4, 1, 3)
  const count = () => topicId === null ? c.unread.get('A').main.unreadCount : c.unread.get('A').topics[topicId].unreadCount
  const id = await c.enter(topicId); await c.present(id, [2, 3, 4]); c.unread.leave(id)
  expect(c.records.has(1)).toBe(false)
  expect([...c.records.keys()]).toEqual([2, 3, 4])
  expect(count()).toBe(0)
  await c.baseline(4, 4, 0, 0)
  if (topicId) c.topic(topicId, 4, 4, 0)
  expect(c.records.size).toBe(0)
  c.feed([msg(1), msg(2, topicId), msg(3, topicId), msg(4, topicId)])
  expect(c.records.size).toBe(0) // replay/history cannot reinsert superseded rows
  expect(count()).toBe(0)
  c.close()
})

it('preserves firstUnread and needsOlder throughout a visit even after its baseline advances', async () => {
  const c = retentionClient(); await c.boot(); await c.baseline(1, 0, 1, 1)
  const id = await c.enter(); await c.present(id, [1])
  c.feed([]); await c.baseline(10, 10, 0, 0)
  expect(c.records.has(1)).toBe(true)
  expect(c.unread.get('A').entry).toMatchObject({ boundary: 0, unreadAtEntry: 1, firstUnread: { seq: 1 }, needsOlder: false })
  c.unread.leave(id); expect(c.records.size).toBe(0)
  c.close()
})

it('releases unresolved visit rows when its boundary resolves and filters old projection rows', async () => {
  const c = retentionClient(); await c.boot(); c.feed([msg(2), msg(3)])
  c.setList(async () => ({ ok: false, kind: 'http', status: 400 }))
  await c.unread.refresh()
  await c.enter(); expect(c.unread.get('A').entry?.boundary).toBeNull()
  expect([...c.records.keys()]).toEqual([1, 2, 3])
  c.setList(async () => ok({ channels: [row({ as_of_seq: 3, read_seq: 3, main_unread_count: 0, unread_count: 0 })] }))
  await c.unread.refresh()
  expect(c.unread.get('A').entry?.boundary).toBe(3)
  expect(c.records.size).toBe(0)
  c.projectionRows.push(msg(1), msg(2), msg(3)); c.feed([])
  expect(c.records.size).toBe(0)
  c.close()
})

it('keeps aggregate suffix rows while a Topic mark holds the old position and rejects a pre-confirmation list', async () => {
  const c = retentionClient(); await c.boot(); await c.baseline(1, 1, 0, 0)
  c.feed([msg(2, 'T'), msg(3, 'T')]); c.topic('T', 3, 0, 2)
  const mark = held<ReadPosition>(), stale = held<ChannelList>(), fresh = held<ChannelList>()
  c.setMark(() => mark.promise)
  let requests = 0
  c.setList(() => (++requests === 1 ? stale.promise : fresh.promise))
  const list = c.unread.refresh(); await flush()
  const id = await c.enter('T'); await c.present(id, [2, 3])
  mark.resolve(ok({ read_seq: 3 })); await flush()
  c.topic('T', 3, 3, 0); c.feed([])
  // Switching visits clears the visit pin; the aggregate alone must retain these rows.
  await c.enter()
  expect([...c.records.keys()]).toEqual([2, 3])
  expect(c.unread.get('A').unreadCount).toBe(2)
  stale.resolve(ok({ channels: [row({ as_of_seq: 3, read_seq: 1, main_unread_count: 0, unread_count: 0 })] }))
  await list; await flush()
  expect(c.unread.get('A').unreadCount).toBe(2)
  expect([...c.records.keys()]).toEqual([2, 3])
  fresh.resolve(ok({ channels: [row({ as_of_seq: 3, read_seq: 1, main_unread_count: 0, unread_count: 0 })] })); await flush()
  expect(c.unread.get('A').unreadCount).toBe(0); expect(c.records.size).toBe(0)
  c.close()
})

async function withMode<T>(prune: boolean, run: () => Promise<T>): Promise<T> {
  mode.prune = prune
  return run()
}

it.each([1, 73, 272])('matches an unpruned controller after every seeded event (seed %s)', async seed => {
  const clients = [retentionClient(), retentionClient()]
  const run = async (action: (c: RetentionClient, index: number) => Promise<unknown> | void) => {
    for (const [i, c] of clients.entries()) await withMode(i === 0, async () => action(c, i))
    expect(clients[0].snapshot()).toEqual(clients[1].snapshot())
    expect(clients[0].marks).toEqual(clients[1].marks)
  }
  let random = seed
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0)
  const history = [msg(1)], positions = new Map<string | null, number>([[null, 0], ['T', 0], ['U', 0]])
  const ids: symbol[] = []
  await run(c => c.boot())
  for (let seq = 2; seq <= 240; seq++) {
    const topic = [null, 'T', 'U'][next() % 3], m = msg(seq, topic, next() % 5 === 0 ? 'me' : 'other')
    history.push(m)
    await run(c => c.feed([m]))
    if (seq % 7 === 0) await run(c => c.feed([history[next() % history.length], m]))
    if (seq % 11 === 0) await run(async (c, i) => { ids[i] = await c.enter(topic) })
    if (seq % 11 === 1 && ids.length) {
      const scope = clients[0].unread.get('A').entry!.scope.topicId
      const rows = history.filter(m => m.topic_id === scope).map(m => m.seq)
      await run((c, i) => c.present(ids[i], rows))
      for (const mark of clients[0].marks) positions.set(mark.scope.topicId, Math.max(positions.get(mark.scope.topicId)!, mark.read_seq))
    }
    if (seq % 13 === 0) {
      const count = (t: string | null) => history.filter(m => m.topic_id === t && m.sender !== 'me' && m.seq > positions.get(t)!).length
      await run(c => c.baseline(seq, positions.get(null)!, count(null), count(null) + count('T') + count('U')))
      for (const t of ['T', 'U']) await run(c => c.topic(t, seq, positions.get(t)!, count(t)))
      // Older/equal responses must not undo retention or count reconciliation.
      await run(c => c.baseline(0, 0, 0, 0))
    }
    if (seq % 17 === 0) await run(c => { c.unread.visibility(false); c.unread.visibility(true) })
    if (seq % 19 === 0) await run(c => { c.unread.leave(); ids.length = 0 })
  }
  expect(clients[0].records.size).toBeLessThan(clients[1].records.size)
  clients.forEach(c => c.close())
})
