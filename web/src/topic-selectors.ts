import type { Message, TimelineItem, TopicSummary } from './api'

export type TopicSummaryError = 'retryable' | 'non_retryable'
export type TopicBaseline = { asOfSeq: number; summary: TopicSummary }
export type TopicLine = {
  kind: 'topic'
  topicId: string
  position: number
  baseline: TopicBaseline | null
  latestMessage: Message
  messageCount: number | null
  summaryError: TopicSummaryError | null
}
export type MainTimelineLine = Extract<TimelineItem, { kind: 'message' }> | TopicLine
export const linePosition = (line: MainTimelineLine) => line.kind === 'message' ? line.message.seq : line.position

/** Projection records never supply cursor evidence; only the controller's unfiltered window is input here. */
export function selectMainTimeline(messages: Message[], pageMessages: Iterable<Message>, baselines: Iterable<TopicBaseline>): MainTimelineLine[] {
  const records = new Map<number, Message>()
  for (const m of pageMessages) records.set(m.seq, m)
  for (const m of messages) records.set(m.seq, m)
  const topics = new Map<string, TopicLine>()
  for (const baseline of baselines) {
    const summary = baseline.summary
    topics.set(summary.id, { kind: 'topic', topicId: summary.id, position: summary.last_seq,
      baseline, latestMessage: summary.latest_message, messageCount: summary.message_count, summaryError: null })
  }
  const lines: MainTimelineLine[] = []
  for (const m of records.values()) {
    if (m.topic_id === null) { lines.push({ kind: 'message', message: m }); continue }
    let topic = topics.get(m.topic_id)
    if (!topic) {
      topic = { kind: 'topic', topicId: m.topic_id, position: m.seq, baseline: null, latestMessage: m, messageCount: null, summaryError: null }
      topics.set(m.topic_id, topic)
    } else {
      if (topic.baseline && m.seq > topic.baseline.asOfSeq) topic.messageCount = (topic.messageCount ?? 0) + 1
      if (m.seq > topic.position) { topic.position = m.seq; topic.latestMessage = m }
    }
  }
  return [...lines, ...topics.values()].sort((a, b) => linePosition(a) - linePosition(b))
}

export function selectTopicMessages(topicId: string, messages: Message[], pageMessages: Iterable<Message>): Message[] {
  const records = new Map<number, Message>()
  for (const m of pageMessages) if (m.topic_id === topicId) records.set(m.seq, m)
  for (const m of messages) if (m.topic_id === topicId) records.set(m.seq, m)
  return [...records.values()].sort((a, b) => a.seq - b.seq)
}
