import { isOrganizationUnavailable, type ChannelList, type listTimeline, type Result, type TimelinePage } from './api'
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
  const transport = new AbortController()
  const signal = AbortSignal.any([options.accountSignal, invalidated.signal])
  let channel = options.channelHint
  let pending = true
  let candidate: InitialRead<TimelinePage> | undefined
  const deadline = deadlines.start(undefined, {
    signal: options.accountSignal,
    timeoutMs: 10_000,
    onTimeout() { transport.abort(); discard() },
  })

  function discard(id?: string) {
    if (id !== undefined && id !== channel) return
    candidate = undefined
    invalidated.abort()
    // Selection fences data immediately. Let the bounded transport still report a late 401.
    if (!pending) deadline.clear()
  }

  async function load() {
    let history_generation: string | undefined
    if (!channel) {
      const list = await options.channels
      if (signal.aborted || !list?.ok || !completeCountFields(list.data)) return
      channel = list.data.channels[0]?.id ?? null
      history_generation = list.data.history_generation
    }
    if (!channel || signal.aborted) return
    const result = await options.load(options.organizationId, channel, { history_generation }, undefined,
      AbortSignal.any([options.accountSignal, transport.signal]))
    if (options.accountSignal.aborted) return
    if (!result.ok && result.kind === 'http' && result.status === 401) options.onEnded()
    else if (isOrganizationUnavailable(result)) options.onUnavailable()
    // Retry transient failures through the normal first-page path.
    if (result.ok || (result.kind === 'http' && (result.status === 403 || result.status === 404))) return result
  }

  const operation = load().catch(() => undefined).then(result => {
    pending = false
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
