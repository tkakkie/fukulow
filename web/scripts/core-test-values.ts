// Symbolic fixtures keep their assertions; only the test boundary translates IDs.
import { fixtureUuid } from './client-core-ids.ts'
import type { Input } from '../src/protocol-types.ts'
const keys = new Set(['id', 'channel', 'channel_id', 'selfId', 'sender', 'clientMessageId', 'client_message_id',
  'reply_to', 'replyRootId', 'reply_root_id', 'topic_id', 'member_id',
  'root_id', 'source_topic_id', 'destination_topic_id', 'operation_id'])
export function createValues() {
  const symbols = new Map<string, string>()
  function coreId(id: string): string {
    const uuid = fixtureUuid(id)
    symbols.set(uuid, id)
    return uuid
  }
  function visit(value: unknown, encode: boolean, field = ''): unknown {
    if (Array.isArray(value)) return value.map(child => visit(child, encode, field))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (encode && key === 'topic') return []
      return [[encode ? key : symbols.get(key) ?? key,
        keys.has(key) && typeof child === 'string' && encode ? coreId(child) : visit(child, encode, key)]]
    }))
    return !encode && typeof value === 'string' && (keys.has(field) || field === 'changedChannels' || field === 'records')
      ? symbols.get(value) ?? value : value
  }
  return {
    coreId,
    coreInput: (input: Input): Input => visit(input, true) as Input,
    coreOutput: <T>(value: T): T => visit(value, false) as T,
  }
}
