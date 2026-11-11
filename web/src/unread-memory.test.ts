// Opt-in heap probe; see docs/measurements.md #272 for the exact command and limits.
import { expect, it, vi } from 'vitest'
import { retentionClient } from './unread-retention-test-helpers'
import { msg } from './unread-test-helpers'

const mode = vi.hoisted(() => ({ prune: process.env.MEASURE_UNREAD !== 'before' }))
vi.mock('./unread-counts', async importOriginal => {
  const actual = await importOriginal<typeof import('./unread-counts')>()
  // No mock call log: it would retain every Message and invalidate the heap measurement.
  return { ...actual, needsUnreadRecord: (...args: Parameters<typeof actual.needsUnreadRecord>) => !mode.prune || actual.needsUnreadRecord(...args) }
})

it.skipIf(!process.env.MEASURE_UNREAD)('measures long-session Unread retention with bounded upstream windows', async () => {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  const heap = () => { gc?.(); return process.memoryUsage().heapUsed }
  // Warm the same controller/module paths before the starting heap sample.
  const warm = retentionClient(); await warm.boot(); warm.feed([msg(2, 'T')]); warm.close()
  const start = heap(), c = retentionClient()
  await c.boot()
  const samples: { messages: number; records: number; heapUsed: number; heapDelta: number }[] = []
  let peakRecords = 0
  for (let seq = 2; seq <= 100_000; seq++) {
    c.feed([msg(seq, seq % 2 === 0 ? null : seq % 4 === 1 ? 'T' : 'U')])
    peakRecords = Math.max(peakRecords, c.records.size)
    if (seq % 1000 !== 0) continue
    // Refetched persisted positions advance all three scopes every 1,000 Messages.
    await c.baseline(seq, seq, 0, 0)
    c.topic('T', seq, seq, 0); c.topic('U', seq, seq, 0)
    expect(c.unread.get('A').unreadCount).toBe(0)
    if (seq % 25_000 === 0) {
      const heapUsed = heap()
      samples.push({ messages: seq, records: c.records.size, heapUsed, heapDelta: heapUsed - start })
    }
  }
  expect(c.records.size).toBe(mode.prune ? 0 : 100_000)
  expect(peakRecords).toBe(mode.prune ? 1000 : 100_000)
  console.info(JSON.stringify({ mode: mode.prune ? 'after' : 'before', node: process.version,
    gc: Boolean(gc), startHeap: start, peakRecords, samples }))
  c.close()
}, 120_000)
