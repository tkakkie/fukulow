import { isOrganizationUnavailable, isSessionEnded, type getStartup, type Result, type StartupResponse } from './api'
import { createRequestDeadlines } from './request-deadlines'
import { completeCountFields } from './unread-counts'

export function startStartupRead(
  load: typeof getStartup,
  organization: string,
  channel: string | null,
  accountSignal: AbortSignal,
  onEnded: () => void,
  onUnavailable: () => void,
) {
  const transport = new AbortController()
  const signal = AbortSignal.any([accountSignal, transport.signal])
  const request = Promise.resolve().then(() => load(organization, channel, undefined, signal)).then(result => {
    // Selection changes fence data but a late 401 still belongs to this Account Session.
    if (accountSignal.aborted) return
    if (isSessionEnded(result)) onEnded()
    else if (isOrganizationUnavailable(result)) onUnavailable()
    if (!result.ok) return result
    const { channel_list, timeline } = result.data
    if (!Array.isArray(channel_list?.channels) || !completeCountFields(result.data)) return
    if (timeline && (!Array.isArray(timeline.page?.items) || !Array.isArray(timeline.authors?.identities) ||
        timeline.page.history_generation !== channel_list.history_generation)) return
    return result
  }).catch(() => undefined)
  return createRequestDeadlines().wait<Result<StartupResponse> | undefined>(request, undefined, {
    signal: accountSignal,
    timeoutMs: 10_000,
    onTimeout() { transport.abort(); return undefined },
  })
}
