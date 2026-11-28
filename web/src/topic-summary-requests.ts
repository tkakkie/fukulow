import type { createActivityTarget } from './activity'
import type { Result, TopicSummaryResponse } from './api'
import type { TopicBaseline } from './topic-selectors'

export const topicBaselineStarts = new WeakMap<TopicBaseline, number>()
let order = 0

// The same order stamps REST starts and invalidations, even within one clock tick.
export const stampTopicEvidence = () => ++order

export function ordinarySummaryFailure(result: Result<unknown>): boolean {
  return !result.ok && result.kind === 'http' &&
    result.status < 500 && ![401, 403, 404, 429].includes(result.status)
}

export type TopicCountRequirement = { asOfSeq: number; readSeq: number; after: number }

export function coversTopicCounts(requirement: TopicCountRequirement, asOfSeq: number, readSeq: number, startedAt: number): boolean {
  return asOfSeq >= requirement.asOfSeq && readSeq >= requirement.readSeq && startedAt > requirement.after
}

type SummaryTarget = ReturnType<typeof createActivityTarget<TopicSummaryResponse>>

export async function readActivitySummary(target: SummaryTarget, requirement: TopicCountRequirement, current: () => boolean) {
  const joined = target.inFlight()
  let read = await (joined ? target.ensure() : target.refresh())
  if (current() && joined && read) {
    if (read.result.ok && coversTopicCounts(requirement, read.result.data.as_of_seq, read.result.data.topic.read_seq, read.startedAt)) {
      const queued = target.flushQueued()
      if (queued) read = await queued
    } else if (read.result.ok || ordinarySummaryFailure(read.result)) {
      // The older request cannot satisfy this demand. Join or start one successor.
      read = await (target.inFlight() ? target.ensure() : target.refresh())
    }
  }
  if (current()) return read
}
