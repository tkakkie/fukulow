// Comparison only: node web/scripts/benchmark-sync.ts (no timing threshold; outside npm test).
import { performance } from 'node:perf_hooks'
import { initialState, step, type ChannelState, type Input } from '../src/protocol.ts'
import type { components } from '../src/api-schema.d.ts'

type Message = components['schemas']['Message']
const record = (seq: number, channel: string): Message => ({ channel_id: channel, seq, body: `m${seq}`,
  id: `${channel}-${seq}`, sender: 'other', client_message_id: `c${seq}`, created_at: '2026-01-01T00:00:00Z', topic_id: null, reply_to: null, reply_root_id: null })
const iterations = 100
const rounds = 5
console.log(`Node ${process.version}; median of ${rounds} rounds, ${iterations} independent steps per round; microseconds/step`)
console.log('channels,messages_per_channel,stream,duplicate,history_50')
for (const channels of [1, 16, 64]) {
  for (const messages of [50, 500, 5000]) {
    const base = { ...initialState('me'), running: true, connected: true, connection: 1, next: 10 }
    for (let n = 0; n < channels; n++) {
      const channel = `C${n}`
      const c: ChannelState = { state: 'ready', watched: true, cursor: messages, hasOlder: false,
        historyError: false, fillAttempt: 0, advancing: [],
        messages: Array.from({ length: messages }, (_, i) => record(i + 1, channel)),
        pending: [{ clientMessageId: 'pending', body: 'pending', state: 'unknown', request: 0 }],
        subscription: { id: 2, after: messages, confirmed: true, watermark: messages } }
      base.channels[channel] = c
    }
    base.requests[3] = { type: 'history', channel: 'C0', page: 'latest' }
    base.channels.C0.latest = 3
    const inputs: Input[] = [
      { type: 'event', connection: 1, event: { type: 'message', message: record(messages + 1, 'C0') } },
      { type: 'event', connection: 1, event: { type: 'message', message: { ...base.channels.C0.messages.at(-1)! } } },
      { type: 'history_result', request: 3, page: { messages: Array.from({ length: 50 }, (_, i) => record(messages + i + 1, 'C0')), has_more: false } },
    ]
    const times = inputs.map(input => {
      for (let i = 0; i < 30; i++) step(base, input)
      const samples: number[] = []
      for (let r = 0; r < rounds; r++) {
        const start = performance.now()
        for (let i = 0; i < iterations; i++) step(base, input)
        samples.push((performance.now() - start) * 1000 / iterations)
      }
      return samples.sort((a, b) => a - b)[Math.floor(rounds / 2)].toFixed(2)
    })
    console.log([channels, messages, ...times].join(','))
  }
}
