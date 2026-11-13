import type { Message } from './api'

export function trimMessages<K>(records: Map<K, Message>, limit: number, edge: 'older' | 'newer' = 'newer') {
  if (records.size <= limit) return false
  const sorted = [...records].sort((a, b) => a[1].seq - b[1].seq)
  const removed = edge === 'older' ? sorted.slice(limit) : sorted.slice(0, -limit)
  for (const [key] of removed) records.delete(key)
  return true
}

/** Sequence metadata survives body eviction; replay contributes at most once to each W-relative count. */
type SequenceRange = { start: number; end: number; total: number }
export type TopicEvidence = Map<string, SequenceRange[]>
export function rememberSequence(ranges: SequenceRange[], seq: number) {
  let lo = 0, hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ranges[mid].end < seq - 1) lo = mid + 1
    else hi = mid
  }
  const range = ranges[lo]
  if (range && seq >= range.start && seq <= range.end) return
  if (range && seq >= range.start - 1 && seq <= range.end + 1) {
    range.start = Math.min(seq, range.start); range.end = Math.max(seq, range.end)
    const next = ranges[lo + 1]
    if (next && next.start <= range.end + 1) { range.end = next.end; ranges.splice(lo + 1, 1) }
  } else ranges.splice(lo, 0, { start: seq, end: seq, total: 0 })
  for (let i = lo; i < ranges.length; i++) ranges[i].total = (ranges[i - 1]?.total ?? 0) + ranges[i].end - ranges[i].start + 1
}
export function countSequencesAfter(ranges: SequenceRange[], seq: number) {
  let lo = 0, hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ranges[mid].end <= seq) lo = mid + 1
    else hi = mid
  }
  const range = ranges[lo]
  return range ? ranges.at(-1)!.total - (ranges[lo - 1]?.total ?? 0) - Math.max(0, seq - range.start + 1) : 0
}
export function rememberTopicMessages(evidence: TopicEvidence, messages: Iterable<Message>) {
  for (const m of messages) {
    if (!m.topic_id) continue
    let seqs = evidence.get(m.topic_id)
    if (!seqs) evidence.set(m.topic_id, seqs = [])
    rememberSequence(seqs, m.seq)
  }
}
