// Test-only identity bridge, also used by the wasm tests in #465.
import { createHash } from 'node:crypto'
import type { Input } from '../src/protocol-types.ts'

export function fixtureUuid(symbol: string): string {
  if (/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(symbol)) return symbol.toLowerCase()
  const hex = createHash('sha256').update('fukulow fixture uuid\0').update(symbol).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const identities = new Set(['id', 'channel', 'channel_id', 'selfId', 'sender', 'clientMessageId', 'client_message_id',
  'reply_to', 'replyRootId', 'reply_root_id', 'topic_id', 'member_id'])
export function normalizeInput(input: Input): Input {
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, value]) => {
      // The fixture shorthand is not a shared Message field; topic_id already contains it.
      if (key === 'topic') return []
      return [[key, identities.has(key) && typeof value === 'string' ? fixtureUuid(value) : visit(value)]]
    }))
    return value
  }
  return visit(input) as Input
}
