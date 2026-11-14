import { observeBookkeeping, evidenceClient } from './message-window-evidence-test-helpers'
import { EVIDENCE_LIMIT } from './message-window'
import { UNREAD_RECORD_LIMIT } from './unread'
import { flush } from './sync-test-helpers'
import { expect, it } from 'vitest'
import { windowClient } from './message-window-test-helpers'
import { record } from './protocol-test-helpers'
import { MAIN_MESSAGE_LIMIT, TOPIC_MESSAGE_LIMIT, REPLY_MESSAGE_LIMIT, TOTAL_MESSAGE_LIMIT } from './protocol'

it.skipIf(!process.env.MEASURE_WINDOW)('measures a long session with Channel switches and repeated Topic and Reply navigation', async () => {
  const c = windowClient(2000); await c.boot()
  const samples: number[] = []
  let peakSync = 0, peakMain = 0, peakTopic = 0, peakReply = 0, peakTotal = 0
  const counts = () => {
    const sync = Object.values(c.sync.get().channels).reduce((n, channel) => n + channel.messages.length, 0)
    const projection = c.topics.get('A')
    const main = projection.lines.length
    const topic = projection.topic('T').messages.length
    const reply = c.replies.get('A').messages.length
    peakSync = Math.max(peakSync, sync); peakMain = Math.max(peakMain, main)
    peakTopic = Math.max(peakTopic, topic); peakReply = Math.max(peakReply, reply)
    peakTotal = Math.max(peakTotal, sync + main + topic + reply)
    expect(sync + main + topic + reply).toBeLessThanOrEqual(TOTAL_MESSAGE_LIMIT)
  }
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let n = 0; n < 1000; n++) {
      const message = record(c.records.length + 1)
      c.records.push(message)
      const start = performance.now(); c.event(message)
      c.topics.get('A'); c.replies.get('A')
      samples.push(performance.now() - start)
      if (n % 100 === 0) counts()
    }
    for (let page = 0; page < 10; page++) await c.topics.loadMain('A')
    for (let page = 0; page < 8; page++) await c.topics.loadTopic('A', 'T')
    await c.replies.open('A', record(1))
    for (let page = 0; page < 5; page++) await c.replies.loadMore('A')
    counts()
    c.topics.releaseTopic('A', 'T'); c.replies.dismiss('A')
    await c.sync.unwatch('A'); await c.sync.watch(`other-${cycle}`)
    for (let n = 1; n <= 100; n++) c.event(record(c.records.length + n, `other-${cycle}`))
    await c.sync.unwatch(`other-${cycle}`)
    await c.sync.watch('A')
    await c.topics.loadMainLatest('A')
    counts()
  }
  samples.sort((a, b) => a - b)
  expect(peakMain).toBe(MAIN_MESSAGE_LIMIT); expect(peakTopic).toBe(TOPIC_MESSAGE_LIMIT); expect(peakReply).toBe(REPLY_MESSAGE_LIMIT)
  console.log(JSON.stringify({ arrivals: samples.length, cycles: 10, retained: { peakSync, peakMain, peakTopic, peakReply, peakTotal },
    arrivalMs: { p50: samples[5000], p95: samples[9500], max: samples.at(-1) },
    refetches: { main: c.mainQueries.length, topic: c.topicQueries.length, reply: c.replyQueries.length } }))
  await c.close()
})

it.skipIf(!process.env.MEASURE_WINDOW)('measures interleaved Topic evidence and a long active Unread visit including bookkeeping', async () => {
  const observer = observeBookkeeping()
  const c = await evidenceClient()
  const peaks: Record<string, number> = {}
  const projectionPeaks: Record<string, number> = {}, unreadPeaks: Record<string, number> = {}
  const samples: { arrivals: number; retained: ReturnType<typeof observer.counts>; bodies: number; presented: number }[] = []
  const timings: number[] = []
  let presented: Set<number> | undefined
  const present = (seqs: number[]) => {
    const add = Set.prototype.add
    Set.prototype.add = function(value) { if (!presented && typeof value === 'number') presented = this; return add.call(this, value) }
    try { c.unread.presented(c.visit, seqs) } finally { Set.prototype.add = add }
  }
  const count = () => {
    const retained = observer.counts()
    for (const [key, value] of Object.entries(retained)) if (typeof value === 'number') peaks[key] = Math.max(peaks[key] ?? 0, value)
    for (const [key, value] of Object.entries(retained.projectionStores)) projectionPeaks[key] = Math.max(projectionPeaks[key] ?? 0, value)
    for (const [key, value] of Object.entries(retained.unreadStores)) unreadPeaks[key] = Math.max(unreadPeaks[key] ?? 0, value)
    peaks.presented = Math.max(peaks.presented ?? 0, presented?.size ?? 0)
    peaks.gapRanges = Math.max(peaks.gapRanges ?? 0, c.sync.get().channels.A.advancing.length)
    const bodies = Object.values(c.sync.get().channels).reduce((n, ch) => n + ch.messages.length, 0) +
      (retained.projectionStores.messages ?? 0) + (retained.projectionStores.baselines ?? 0) + c.topics.get('A').topic('T').messages.length + c.replies.get('A').messages.length
    peaks.bodies = Math.max(peaks.bodies ?? 0, bodies)
    expect(retained.topicRanges).toBeLessThanOrEqual(EVIDENCE_LIMIT)
    expect(retained.replyRanges).toBeLessThanOrEqual(EVIDENCE_LIMIT)
    expect(retained.unreadRecords).toBeLessThanOrEqual(UNREAD_RECORD_LIMIT)
    expect(bodies).toBeLessThanOrEqual(TOTAL_MESSAGE_LIMIT)
    return { retained, bodies, presented: presented?.size ?? 0 }
  }
  try {
    for (let seq = 3; seq <= 100_002; seq++) {
      const m = { ...record(seq), topic_id: seq % 2 ? 'T' : 'U',
        ...(seq % 2 ? { reply_to: 'id1', reply_root_id: 'id1' } : {}) }
      const start = performance.now(); c.append(m); timings.push(performance.now() - start)
      count()
      if (seq % 1000 === 2) {
        // Keep the same visit open; presenting only the recent rows must not skip its unseen prefix.
        present(c.topics.get('A').topic('T').messages.map(m => m.seq))
        await flush(); count()
      }
      if ((seq - 2) % 25_000 === 0) samples.push({ arrivals: seq - 2, ...count() })
    }
    await c.unread.refresh(); await flush()
    expect(c.unread.get('A').entry).toMatchObject({ boundary: 0, unreadAtEntry: 1, firstUnread: { seq: 1 }, needsOlder: false })
    expect(c.unread.get('A').topics.T.unreadCount).toBe(50_001)
    expect(c.reads.mark).toBe(0)
    // Refetch back to the first Unread, then present it: missing metadata never permits a skipped prefix.
    while (c.topics.get('A').topic('T').hasMore) await c.topics.loadTopic('A', 'T')
    c.unread.presented(c.visit, [1]); await flush()
    expect(c.unread.get('A').topics.T.position).toBe(1)
    expect(c.unread.get('A').topics.T.unreadCount).toBe(50_000)
    timings.sort((a, b) => a - b)
    console.log(JSON.stringify({ arrivals: timings.length, peaks, projectionPeaks, unreadPeaks, samples, reads: c.reads,
      arrivalMs: { p50: timings[50_000], p95: timings[95_000], max: timings.at(-1) } }))
  } finally { observer.stop(); await c.close() }
}, 120_000)
