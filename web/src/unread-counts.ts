import type { Message, TopicSummary, UnreadChannel } from './api'

export type UnreadScope = { channel: string; topicId: string | null }
export type ScopeBaseline = { asOfSeq: number; readSeq: number; count: number; mentionCount: number }
/** Coverage proves every matching projection row in (after, through] is loaded. */
export type Coverage = { after: number; through: number }
export type UnreadRecord = Pick<Message, 'id' | 'seq' | 'channel_id' | 'topic_id' | 'sender'> & { mentions: readonly Pick<Message['mentions'][number], 'member_id'>[] }
export const inScope = (m: Pick<Message, 'channel_id' | 'topic_id'>, scope: UnreadScope) => m.channel_id === scope.channel && m.topic_id === scope.topicId
export const mainBaseline = (c: UnreadChannel): ScopeBaseline => ({ asOfSeq: c.as_of_seq, readSeq: c.read_seq, count: c.main_unread_count, mentionCount: c.main_mention_unread_count })
export const topicBaseline = (w: number, t: TopicSummary): ScopeBaseline => ({ asOfSeq: w, readSeq: t.read_seq, count: t.unread_count, mentionCount: t.mention_unread_count })
export function chooseBaseline(old: ScopeBaseline | undefined, next: ScopeBaseline): ScopeBaseline {
  if (!old || next.asOfSeq > old.asOfSeq || (next.asOfSeq === old.asOfSeq && next.readSeq > old.readSeq)) return next
  if (next.asOfSeq === old.asOfSeq && next.readSeq === old.readSeq && (next.count < old.count || next.mentionCount < old.mentionCount))
    return { ...next, count: Math.min(old.count, next.count), mentionCount: Math.min(old.mentionCount, next.mentionCount) }
  return old
}
export function chooseChannelBaseline(old: UnreadChannel | undefined, next: UnreadChannel): UnreadChannel {
  if (!old || next.as_of_seq > old.as_of_seq || (next.as_of_seq === old.as_of_seq && next.read_seq > old.read_seq)) return next
  if (next.as_of_seq === old.as_of_seq && next.read_seq === old.read_seq) return { ...next,
    unread_count: Math.min(old.unread_count, next.unread_count), main_unread_count: Math.min(old.main_unread_count, next.main_unread_count),
    mention_unread_count: Math.min(old.mention_unread_count, next.mention_unread_count),
    main_mention_unread_count: Math.min(old.main_mention_unread_count, next.main_mention_unread_count) }
  return old
}
export function scopeCount(b: ScopeBaseline, position: number, records: Iterable<UnreadRecord>, scope: UnreadScope, self: string, mention = false): number {
  let count = mention ? b.mentionCount : b.count
  const seen = new Set<number>()
  for (const m of records) {
    if (!inScope(m, scope) || m.sender === self || (mention && !m.mentions.some(target => target.member_id === self)) || seen.has(m.seq)) continue
    seen.add(m.seq)
    if (m.seq > b.readSeq && m.seq <= Math.min(position, b.asOfSeq)) count--
    if (m.seq > Math.max(position, b.asOfSeq)) count++
  }
  return Math.max(0, count)
}
export function needsUnreadRecord(seq: number, baseline: ScopeBaseline | undefined, aggregateAfter: number, visitAfter: number): boolean {
  // Keep the whole baseline window: later local reads still need its rows for subtraction.
  // Aggregate reconciliation and the visit's fixed entry boundary can require older rows too.
  return seq > Math.min(baseline?.readSeq ?? 0, aggregateAfter, visitAfter)
}
export function coveredThrough(position: number, coverage: Coverage[]): number {
  let through = position
  for (const range of [...coverage].sort((a, b) => a.after - b.after)) {
    if (range.after <= through) through = Math.max(through, range.through)
  }
  return through
}
/** Own rows can be skipped, but never create an intent. Unseen rows and projection gaps stop progress. */
export function sequenceToSubmit(position: number, records: Iterable<UnreadRecord>, coverage: Coverage[], presented: ReadonlySet<number>, scope: UnreadScope, self: string): number {
  const through = coveredThrough(position, coverage)
  let result = position
  for (const m of [...records].filter(m => inScope(m, scope) && m.seq > position && m.seq <= through).sort((a, b) => a.seq - b.seq)) {
    if (m.sender === self) continue
    if (!presented.has(m.seq)) break
    result = m.seq
  }
  return result
}
/** Consecutive unfiltered server records prove coverage, including history/replay, never presentation. */
export function recordCoverage(records: Message[]): Coverage[] {
  const ranges: Coverage[] = []
  for (const m of [...records].sort((a, b) => a.seq - b.seq)) {
    const last = ranges.at(-1)
    if (last && m.seq <= last.through + 1) last.through = Math.max(last.through, m.seq)
    else ranges.push({ after: m.seq - 1, through: m.seq })
  }
  return ranges
}

/** Partial legacy count payloads cannot cover Mention invalidations. */
export function completeCountFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  if (Array.isArray(value)) return value.every(completeCountFields)
  const fields = value as Record<string, unknown>
  if ('unread_count' in fields && !['unread_count', 'mention_unread_count'].every(key => Number.isSafeInteger(fields[key]) && Number(fields[key]) >= 0)) return false
  if ('main_unread_count' in fields && !['main_unread_count', 'main_mention_unread_count'].every(key => Number.isSafeInteger(fields[key]) && Number(fields[key]) >= 0)) return false
  return Object.values(fields).every(completeCountFields)
}
