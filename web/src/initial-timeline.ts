import { isOrganizationUnavailable, isSessionEnded, type ChannelList, type listTimeline, type Result, type TimelinePage } from './api'
import type { Navigation } from './navigation'
import type { NavigationTarget } from './navigation-url'
import { createRequestDeadlines } from './request-deadlines'
import { completeCountFields } from './unread-counts'

export type InitialRead<T> = { result: Promise<Result<T> | undefined>; signal: AbortSignal }

/** Owns one first-page request until the selected Channel's bootstrap claims it. */
export function startInitialTimeline(options: {
  organizationId: string
  channelHint: string | null
  channels?: Promise<Result<ChannelList>>
  accountSignal: AbortSignal
  load: typeof listTimeline
  onEnded(): void
  onUnavailable(): void
}) {
  const deadlines = createRequestDeadlines()
  const invalidated = new AbortController()
  const signal = AbortSignal.any([options.accountSignal, invalidated.signal])
  let channel = options.channelHint
  let discardedBeforePick = channel === null ? new Set<string>() : undefined
  let candidate: InitialRead<TimelinePage> | undefined

  function discard(id?: string) {
    if (id !== undefined && id !== channel) {
      discardedBeforePick?.add(id)
      return
    }
    discardedBeforePick = undefined
    candidate = undefined
    // Selection fences data immediately. Let the bounded transport still report a late 401.
    invalidated.abort()
  }

  async function load() {
    let history_generation: string | undefined
    if (!channel) {
      const list = await options.channels
      if (signal.aborted || !list?.ok || !completeCountFields(list.data)) return
      channel = list.data.channels[0]?.id ?? null
      if (channel !== null && discardedBeforePick?.has(channel)) discard(channel)
      discardedBeforePick = undefined
      history_generation = list.data.history_generation
    }
    if (!channel || signal.aborted) return
    const transport = new AbortController()
    const deadline = deadlines.start(undefined, {
      signal: options.accountSignal,
      timeoutMs: 10_000,
      onTimeout() { transport.abort(); discard() },
    })
    try {
      const result = await options.load(options.organizationId, channel, { history_generation }, undefined,
        AbortSignal.any([options.accountSignal, transport.signal]))
      if (options.accountSignal.aborted) return
      if (isSessionEnded(result)) options.onEnded()
      else if (isOrganizationUnavailable(result)) options.onUnavailable()
      // Retry transient failures through the normal first-page path.
      if (result.ok || (result.kind === 'http' && (result.status === 403 || result.status === 404))) return result
    } finally { deadline.clear() }
  }

  const operation = load().catch(() => undefined).then(result => {
    if (!result || signal.aborted) discard()
    return result
  })
  candidate = { result: deadlines.wait(operation, undefined, { signal }), signal }
  return {
    signal,
    discard,
    select(id: string | null) { if (id !== channel) discard() },
    take(id: string) {
      if (id !== channel || signal.aborted) return
      const claimed = candidate
      candidate = undefined
      return claimed
    },
  }
}

export type InitialTimeline = ReturnType<typeof startInitialTimeline>

/** Owns the early read for one Organization selection. */
export function startInitialSelection(options: Omit<Parameters<typeof startInitialTimeline>[0], 'channelHint' | 'load' | 'onUnavailable'> & {
  route(): NavigationTarget | null
  navigation?: Pick<Navigation, 'subscribe'>
  load?: typeof listTimeline
  onUnavailableBeforeSession(): void
}) {
  const initialChannelHint = () => {
    const target = options.route()
    return target?.organizationId === options.organizationId ? target.channelId : null
  }
  let hint = initialChannelHint()
  let unavailable = false
  let onUnavailable: (() => void) | undefined = options.onUnavailableBeforeSession
  const initialTimeline = options.load && startInitialTimeline({
    ...options, channelHint: hint, load: options.load,
    onUnavailable() {
      if (!onUnavailable) return
      unavailable = true
      initialTimeline?.discard()
      onUnavailable()
    },
  })
  if (initialTimeline && !initialTimeline.signal.aborted) {
    const unsubscribe = options.navigation?.subscribe(() => {
      const next = initialChannelHint()
      if (next !== hint) initialTimeline.select(next)
      hint = next
    })
    if (unsubscribe) initialTimeline.signal.addEventListener('abort', unsubscribe, { once: true })
  }
  return {
    initialChannelHint,
    initialTimeline,
    get unavailable() { return unavailable },
    attachSession(markUnavailable: () => void) { onUnavailable = markUnavailable },
    close() { onUnavailable = undefined; initialTimeline?.discard() },
  }
}
