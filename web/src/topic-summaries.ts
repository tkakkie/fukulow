import { createActivityTarget, type Activity, type ActivityRead } from './activity'
import { isSessionEnded, type Message, type Result, type TopicPage, type TopicSummaryResponse } from './api'
import type { ChannelState } from './protocol-types'
import { backoffCap } from './reconnect'
import type { TopicBaseline, TopicSummaryError } from './topic-selectors'
import { coversTopicCounts, readActivitySummary, stampTopicEvidence, topicBaselineStarts, type TopicCountRequirement } from './topic-summary-requests'

const MAX_SUMMARY_RETRIES = 4
export type SummaryRetry = { attempt: number; timer?: ReturnType<typeof setTimeout>; terminal?: TopicSummaryError }
const isRetryableSummaryFailure = <T>(r: Exclude<Result<T>, { ok: true }>) =>
  r.kind === 'network' || (r.kind === 'http' && r.status >= 500)

type SummaryTarget = ReturnType<typeof createActivityTarget<TopicSummaryResponse>>
export type ProjectionActivityEntry = {
  close(): void
  release(): void
  target: ReturnType<typeof createActivityTarget>
  summaryTarget?: SummaryTarget
}

type SummaryWindow = {
  readonly channel: string
  readonly main: { readonly hasNewer: boolean }
  readonly messages: ReadonlyMap<number, Pick<Message, 'topic_id'>>
  readonly baselines: ReadonlyMap<string, Readonly<TopicBaseline>>
  readonly topics: ReadonlyMap<string, { notFound: boolean }>
  readonly evidence: { readonly floor: number; readonly sequences: ReadonlyMap<string, readonly { readonly end: number }[]> }
  readonly evidenceRefresh: Set<string>
  readonly summaryThrough: Map<string, number>
  readonly summaries: Set<string>
  readonly summaryDemands: Map<string, number>
  readonly summaryRetries: Map<string, SummaryRetry>
}

type SummaryOptions = {
  activity?: Activity
  requestTimeoutMs?: number
  api: {
    getTopicSummary(channel: string, topic: string, signal?: AbortSignal): Promise<Result<TopicSummaryResponse>>
  }
}

type SummaryDependencies<W extends SummaryWindow> = {
  activityTargets: Map<string, ProjectionActivityEntry>
  getWindow(channel: string): W
  isHeldWindow(channel: string, w: W): boolean
  current(channel: string, w: W): boolean
  getChannel(channel: string): Pick<ChannelState, 'cursor' | 'versionEpoch'> | undefined
  readSummary(channel: string, w: W, topic: string, run: () => Promise<Result<TopicSummaryResponse>>, withTimeout?: boolean, signal?: AbortSignal):
    Promise<{ result: Result<TopicSummaryResponse>; isCurrent(): boolean; startedAt: number }>
  forgetSummaryRead(w: W, topic: string): void
  markTopicNotFound(w: W, topic: string): void
  mergeBaselines(w: W, response: Pick<TopicPage, 'as_of_seq' | 'topics'>, startedAt: number): void
  trimMain(w: W, edge: 'older' | 'newer'): void
  settleSummaryHistory(channel: string, response: TopicSummaryResponse): void
  notify(channel: string): void
  releaseActivity(key: string): void
}

export function createTopicSummaries<W extends SummaryWindow>(options: SummaryOptions, dependencies: SummaryDependencies<W>) {
  const {
    activityTargets, getWindow, isHeldWindow, current, getChannel, readSummary, forgetSummaryRead,
    markTopicNotFound, mergeBaselines, trimMain, settleSummaryHistory, notify, releaseActivity,
  } = dependencies
  const summaryListeners = new Set<(channel: string, response: TopicSummaryResponse, startedAt: number) => void>()
  const clearSummaryRetry = (w: W, topicId: string) => {
    const retry = w.summaryRetries.get(topicId)
    if (!retry) return
    if (retry.timer !== undefined) clearTimeout(retry.timer)
    w.summaryRetries.delete(topicId)
  }
  const clearSummaryTimers = (w: W) => {
    for (const retry of w.summaryRetries.values()) {
      if (retry.timer !== undefined) clearTimeout(retry.timer)
    }
    w.summaryRetries.clear()
  }
  const needsSummary = (w: W, topicId: string) => {
    const baseline = w.baselines.get(topicId)
    if (!baseline || baseline.asOfSeq < w.evidence.floor) return true
    const known = w.evidence.sequences.get(topicId)?.at(-1)?.end ?? 0
    return known > baseline.summary.latest_message.created_seq && w.messages.get(known)?.topic_id !== topicId &&
      known > (w.summaryThrough.get(topicId) ?? 0)
  }

  const summaryErrorFor = (w: W, topicId: string): TopicSummaryError | null =>
    (w.baselines.has(topicId) && !needsSummary(w, topicId)) || w.topics.get(topicId)?.notFound
      ? null
      : (w.summaryRetries.get(topicId)?.terminal ?? null)

  function holdSummary(w: W, topic: string) {
    const { channel } = w
    if (!isHeldWindow(channel, w) || !options.activity) return
    const key = `topic:${channel}:${topic}`
    const existing = activityTargets.get(key)
    if (existing) return existing.summaryTarget
    let through = 0
    const target = createActivityTarget<TopicSummaryResponse>({
      stampRead: stampTopicEvidence,
      retryQueuedTerminal: true,
      async load(signal) {
        w.summaries.add(topic)
        through = w.evidence.sequences.get(topic)?.at(-1)?.end ?? 0
        const epoch = getChannel(channel)?.versionEpoch
        const pending = options.api.getTopicSummary(channel, topic, signal)
        try {
          const { result } = await readSummary(channel, w, topic, () => pending, false, signal)
          if (getChannel(channel)?.versionEpoch !== epoch) return { ok: false, kind: 'network' }
          // A concurrent mutation can make a server-selected summary transiently stale; never turn it into a terminal 4xx.
          return !result.ok && result.kind === 'http' && result.status === 409 && result.error === 'snapshot_expired'
            ? { ok: false, kind: 'network' }
            : result
        }
        finally { if (signal.aborted) w.summaries.delete(topic) }
      },
      hide: () => { forgetSummaryRead(w, topic); clearSummaryRetry(w, topic) },
      accept: (response, startedAt) => {
        if (!current(channel, w)) return
        w.summaryThrough.set(topic, through)
        const t = w.topics.get(topic)
        if (t) t.notFound = false
        mergeBaselines(w, { as_of_seq: response.as_of_seq, topics: [response.topic] }, startedAt)
        trimMain(w, w.main.hasNewer ? 'older' : 'newer')
        // A successful but insufficient checkpoint must retain main's finite retry budget.
        const baseline = w.baselines.get(topic)
        if (needsSummary(w, topic) && (baseline || w.topics.has(topic))) {
          const attempt = w.summaryRetries.get(topic)?.attempt ?? 0
          if (!baseline || baseline.asOfSeq >= w.evidence.floor) w.summaryRetries.set(topic, { attempt, terminal: 'non_retryable' })
          else if (attempt >= MAX_SUMMARY_RETRIES) w.summaryRetries.set(topic, { attempt, terminal: 'retryable' })
          else {
            const timer = setTimeout(() => {
              const entry = w.summaryRetries.get(topic)
              if (entry) entry.timer = undefined
              void ensureSummary(channel, topic)
            }, backoffCap(attempt))
            w.summaryRetries.set(topic, { attempt: attempt + 1, timer })
          }
        }
        w.summaries.delete(topic)
        settleSummaryHistory(channel, response)
        notify(channel)
        summaryListeners.forEach(listener => listener(channel, response, startedAt))
      },
      error: r => {
        if (!current(channel, w)) return
        w.summaries.delete(topic)
        clearSummaryRetry(w, topic)
        if (r.kind === 'http' && r.status === 404 && r.error === 'topic_not_found') {
          markTopicNotFound(w, topic)
        } else w.summaryRetries.set(topic, { attempt: 0, terminal: r.kind === 'network' || r.status === 429 || r.status >= 500 ? 'retryable' : 'non_retryable' })
        notify(channel)
      },
      terminal: r => !r.ok && r.kind === 'http' && (isSessionEnded(r) || r.status === 403 || r.status === 404),
      timeoutMs: options.requestTimeoutMs,
    })
    activityTargets.set(key, { close: target.close, release: options.activity.hold(key, target), target, summaryTarget: target })
    return target
  }
  function pruneActivity(w: W) {
    const { channel } = w
    if (!isHeldWindow(channel, w)) return
    // An awaited activitySummary() or queued non-retry follow-up owns its target until it settles.
    const retained = new Set([...w.baselines.keys(), ...w.topics.keys(), ...w.summaryDemands.keys()])
    for (const m of w.messages.values()) if (m.topic_id) retained.add(m.topic_id)
    for (const [key, entry] of activityTargets) if (key.startsWith(`topic:${channel}:`) &&
      !retained.has(key.slice(`topic:${channel}:`.length)) && !entry.target.pendingNotice()) releaseActivity(key)
  }
  async function ensureSummaryForWindow(w: W, topicId: string) {
    if (w.evidenceRefresh.has(topicId)) return
    w.evidenceRefresh.add(topicId)
    try {
      await Promise.resolve()
      if (isHeldWindow(w.channel, w) && current(w.channel, w)) await ensureSummary(w.channel, topicId)
    } finally { w.evidenceRefresh.delete(topicId) }
  }
  async function fetchSummary(channel: string, topicId: string, restarted = false): Promise<Result<TopicSummaryResponse> | undefined> {
    const w = getWindow(channel)
    if (!current(channel, w) || w.summaries.has(topicId)) return
    const pendingRetry = w.summaryRetries.get(topicId)
    if (pendingRetry?.timer !== undefined) {
      clearTimeout(pendingRetry.timer)
      pendingRetry.timer = undefined
    }
    w.summaries.add(topicId)
    const through = w.evidence.sequences.get(topicId)?.at(-1)?.end ?? 0
    const { result, isCurrent, startedAt } = await readSummary(channel, w, topicId, () => options.api.getTopicSummary(channel, topicId))
    if (!isCurrent()) return
    if (!result.ok && result.kind === 'http' && result.error === 'snapshot_expired' && !restarted) {
      w.summaries.delete(topicId)
      return fetchSummary(channel, topicId, true)
    }
    if (result.ok) {
      w.summaryThrough.set(topicId, through)
      const existing = w.topics.get(topicId)
      if (existing) existing.notFound = false
      mergeBaselines(w, { as_of_seq: result.data.as_of_seq, topics: [result.data.topic] }, startedAt)
      trimMain(w, 'newer')
      settleSummaryHistory(channel, result.data)
    } else if (result.kind === 'http' && result.status === 404 && result.error === 'topic_not_found') {
      clearSummaryRetry(w, topicId)
      markTopicNotFound(w, topicId)
    }
    return result
  }
  async function loadSummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (options.activity) { if (current(channel, w)) { clearSummaryRetry(w, topicId); await holdSummary(w, topicId)?.refresh() }; return }
    if (!current(channel, w) || w.summaries.has(topicId)) return
    const hadTerminal = w.summaryRetries.get(topicId)?.terminal !== undefined
    clearSummaryRetry(w, topicId)
    const pending = fetchSummary(channel, topicId)
    if (hadTerminal) notify(channel)
    const result = await pending
    if (!result) return
    w.summaries.delete(topicId)
    if (
      !result.ok &&
      current(channel, w) &&
      needsSummary(w, topicId) &&
      !w.topics.get(topicId)?.notFound
    ) {
      w.summaryRetries.set(topicId, {
        attempt: MAX_SUMMARY_RETRIES,
        terminal: isRetryableSummaryFailure(result) ? 'retryable' : 'non_retryable',
      })
    }
    notify(channel)
    return result
  }
  async function ensureSummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (options.activity) {
      const retry = w.summaryRetries.get(topicId)
      if (current(channel, w) && needsSummary(w, topicId) && !w.topics.get(topicId)?.notFound &&
        !w.summaries.has(topicId) && retry?.timer === undefined && retry?.terminal === undefined) await holdSummary(w, topicId)?.ensure()
      return
    }
    const existingRetry = w.summaryRetries.get(topicId)
    if (
      !current(channel, w) ||
      !needsSummary(w, topicId) ||
      w.topics.get(topicId)?.notFound ||
      w.summaries.has(topicId) ||
      existingRetry?.timer !== undefined ||
      existingRetry?.terminal !== undefined
    ) {
      return
    }
    const result = await fetchSummary(channel, topicId)
    if (!result) return
    try {
      const latestRetry = w.summaryRetries.get(topicId)
      if (
        !current(channel, w) ||
        !needsSummary(w, topicId) ||
        w.topics.get(topicId)?.notFound ||
        latestRetry?.timer !== undefined ||
        latestRetry?.terminal !== undefined
      ) {
        return
      }
      const attempt = latestRetry?.attempt ?? 0
      const baseline = w.baselines.get(topicId)
      if (result.ok && !baseline && !w.topics.has(topicId)) return
      // An evicted baseline cannot be restored by repeatedly fetching the same old Topic.
      if ((result.ok && (!baseline || baseline.asOfSeq >= w.evidence.floor)) || (!result.ok && !isRetryableSummaryFailure(result))) {
        w.summaryRetries.set(topicId, { attempt, terminal: 'non_retryable' })
        return
      }
      if (attempt >= MAX_SUMMARY_RETRIES) {
        w.summaryRetries.set(topicId, { attempt, terminal: 'retryable' })
        return
      }
      const timer = setTimeout(() => {
        const entry = w.summaryRetries.get(topicId)
        if (entry) entry.timer = undefined
        void ensureSummary(channel, topicId)
      }, backoffCap(attempt))
      w.summaryRetries.set(topicId, { attempt: attempt + 1, timer })
    } finally {
      // Publish only after retry/terminal state is ready for component effects to re-enter.
      w.summaries.delete(topicId)
      if (current(channel, w)) notify(channel)
    }
  }
  async function retrySummary(channel: string, topicId: string) {
    const w = getWindow(channel)
    if (options.activity) { if (current(channel, w)) { clearSummaryRetry(w, topicId); await holdSummary(w, topicId)?.retryNow() }; return }
    if (!current(channel, w)) return
    if (w.summaries.has(topicId)) {
      const entry = w.summaryRetries.get(topicId)
      if (entry) {
        entry.attempt = 0
        entry.terminal = undefined
      }
      return
    }
    const hadTerminal = w.summaryRetries.get(topicId)?.terminal !== undefined
    clearSummaryRetry(w, topicId)
    const pending = ensureSummary(channel, topicId)
    if (hadTerminal) notify(channel)
    await pending
  }
  function hasActivitySummary(channel: string, topic: string) {
    return activityTargets.has(`topic:${channel}:${topic}`)
  }
  async function readTopicSummary(channel: string, topic: string, requirement: TopicCountRequirement, allowCached = false): Promise<ActivityRead<TopicSummaryResponse> | undefined> {
    const w = getWindow(channel)
    if (!current(channel, w)) return
    const target = holdSummary(w, topic)
    if (!target) return
    const cached = w.baselines.get(topic)
    if (allowCached && cached && target.idle()) {
      const startedAt = topicBaselineStarts.get(cached) ?? 0
      const asOfSeq = Math.max(requirement.asOfSeq, getChannel(channel)?.cursor ?? 0)
      if (coversTopicCounts({ ...requirement, asOfSeq }, cached.asOfSeq, cached.summary.read_seq, startedAt)) {
        return { startedAt, result: { ok: true, data: {
          history_generation: cached.summary.latest_message.history_generation, as_of_seq: cached.asOfSeq, topic: cached.summary,
        } } }
      }
    }
    w.summaryDemands.set(topic, (w.summaryDemands.get(topic) ?? 0) + 1)
    try {
      return await readActivitySummary(target, requirement, () => current(channel, w))
    } finally {
      const left = (w.summaryDemands.get(topic) ?? 1) - 1
      if (left > 0) w.summaryDemands.set(topic, left)
      else w.summaryDemands.delete(topic)
    }
  }
  function subscribeSummary(listener: (channel: string, response: TopicSummaryResponse, startedAt: number) => void): () => void {
    summaryListeners.add(listener)
    return () => { summaryListeners.delete(listener) }
  }

  return {
    clearSummaryRetry, clearSummaryTimers, needsSummary, summaryErrorFor, holdSummary, pruneActivity,
    ensureSummaryForWindow, loadSummary, ensureSummary, retrySummary, readTopicSummary, hasActivitySummary,
    subscribeSummary, clearSummaryListeners: () => summaryListeners.clear(),
  }
}
