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
