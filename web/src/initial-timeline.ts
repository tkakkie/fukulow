import { isOrganizationUnavailable, isSessionEnded, type ChannelList, type DisplayIdentity, type getStartup, type listTimeline, type Result, type StartupResponse, type TimelinePage } from './api'
import type { Navigation } from './navigation'
import type { NavigationTarget } from './navigation-url'
import { createRequestDeadlines } from './request-deadlines'
import { completeCountFields } from './unread-counts'
import { startStartupRead } from './startup-read'

export type InitialRead<T> = { result: Promise<Result<T> | undefined>; signal: AbortSignal; accept?(data: T): void }

/** Owns one first-page request until the selected Channel's bootstrap claims it. */
export function startInitialTimeline({ startup, channels, ...options }: {
  organizationId: string
  channelHint: string | null
  channels?: Promise<Result<ChannelList>>
  startup?: Promise<Result<StartupResponse> | undefined>
  onAuthors?(identities: DisplayIdentity[]): void
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
  let snapshot: StartupResponse['timeline']

  function discard(id?: string) {
    if (id !== undefined && id !== channel) {
      discardedBeforePick?.add(id)
      return
    }
    discardedBeforePick = undefined
    candidate = undefined
    snapshot = undefined
    startup = undefined
    channels = undefined
    // Selection fences data immediately. Let the bounded transport still report a late 401.
    invalidated.abort()
  }

  async function load() {
    let history_generation: string | undefined
    if (!channel) {
      const list = await channels
      if (signal.aborted || !list?.ok || !completeCountFields(list.data)) return
      channel = list.data.channels[0]?.id ?? null
      if (channel !== null && discardedBeforePick?.has(channel)) discard(channel)
      discardedBeforePick = undefined
      history_generation = list.data.history_generation
    }
    channels = undefined
    if (!channel || signal.aborted) return
    const result = startup && await startup
    startup = undefined
    if (signal.aborted) return
    if (result?.ok && result.data.timeline?.channel_id === channel) {
      snapshot = result.data.timeline
      return { ok: true, data: snapshot.page } as const
    }
    if (result && !result.ok) {
      if (isSessionEnded(result) || isOrganizationUnavailable(result)) return
      // The Channel list still falls back. Keep a scoped Channel denial on the same selection.
      if (result.kind === 'http' && result.status === 404 && result.error === 'channel not found') return result
    }
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
  candidate = {
    result: deadlines.wait(operation, undefined, { signal }), signal,
    accept(page) {
      if (!signal.aborted && snapshot?.page === page) options.onAuthors?.(snapshot.authors.identities)
      snapshot = undefined
    },
  }
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
export function startInitialSelection(options: Omit<Parameters<typeof startInitialTimeline>[0], 'channelHint' | 'load' | 'onUnavailable' | 'channels' | 'startup'> & {
  route(): NavigationTarget | null
  navigation?: Pick<Navigation, 'subscribe'>
  load?: typeof listTimeline
  loadStartup?: typeof getStartup
  loadChannels?(id: string, signal: AbortSignal): Promise<Result<ChannelList>>
  onUnavailableBeforeSession(): void
}) {
  const initialChannelHint = () => {
    const target = options.route()
    return target?.organizationId === options.organizationId ? target.channelId : null
  }
  let hint = initialChannelHint()
  let unavailable = false
  let closed = false
  let onUnavailable: (() => void) | undefined = options.onUnavailableBeforeSession
  function markUnavailable() {
    if (!onUnavailable) return
    unavailable = true
    initialTimeline?.discard()
    onUnavailable()
  }
  const startup = options.loadStartup && startStartupRead(
    options.loadStartup, options.organizationId, hint, options.accountSignal, options.onEnded, markUnavailable,
  )
  const loadChannels = options.loadChannels
  const fallback = loadChannels && (() => loadChannels(options.organizationId, options.accountSignal).then(list => {
    if (isSessionEnded(list)) options.onEnded()
    return list
  }))
  const initialChannels = startup ? startup.then(result => {
    if (result?.ok) return { ok: true, data: result.data.channel_list } as const
    if (result && (isSessionEnded(result) || isOrganizationUnavailable(result))) return result
    if (!closed && !options.accountSignal.aborted && fallback) return fallback()
    return { ok: false, kind: 'network' } as const
  }) : fallback?.()
  const initialTimeline = options.load && startInitialTimeline({
    ...options, channelHint: hint, load: options.load, channels: initialChannels, startup, onUnavailable: markUnavailable,
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
    initialChannels,
    initialTimeline,
    startupReady: startup?.then(() => undefined),
    get unavailable() { return unavailable },
    attachSession(markUnavailable: () => void) { onUnavailable = markUnavailable },
    close() { closed = true; onUnavailable = undefined; initialTimeline?.discard() },
  }
}
