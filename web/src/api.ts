/** Returns true when the server answers the health check. */
export async function checkHealth(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/api/v1/health')
    return res.ok
  } catch {
    return false
  }
}

import type { components } from './api-schema'

export type AccountIdentity = components['schemas']['AccountIdentity']
export type Identity = components['schemas']['Identity']
export type SetupRequest = components['schemas']['SetupRequest']
export type SignInRequest = components['schemas']['SignInRequest']

/** Result of an API call. `network` covers fetch failures and 5xx, including admission 503
 * (retryable with the same client_message_id, never a definite send refusal or "signed out"). */
export type Result<T> = { ok: true; data: T } | { ok: false; kind: 'http'; status: number; error?: string } | { ok: false; kind: 'network' }

async function call<T>(
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit,
  parse: boolean,
): Promise<Result<T>> {
  try {
    // Cookie auth only: the HttpOnly session cookie is sent by the browser; no token is stored.
    const res = await fetchFn(path, { credentials: 'same-origin', ...init })
    if (res.status >= 500) return { ok: false, kind: 'network' }
    if (!res.ok) {
      let error: string | undefined
      try { error = ((await res.json()) as components['schemas']['ErrorBody']).error } catch { /* Status remains authoritative for malformed errors. */ }
      return { ok: false, kind: 'http', status: res.status, ...(error === undefined ? {} : { error }) }
    }
    return { ok: true, data: (parse ? await res.json() : undefined) as T }
  } catch {
    return { ok: false, kind: 'network' }
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** GET /setup is no-store; also ask the browser not to reuse it. */
export const getSetupStatus = (f: typeof fetch = fetch) =>
  call<components['schemas']['SetupStatus']>(f, '/api/v1/setup', { cache: 'no-store' }, true)

export const postSetup = (body: SetupRequest, f: typeof fetch = fetch) =>
  call<unknown>(f, '/api/v1/setup', json(body), true)

export const postSession = (body: SignInRequest, f: typeof fetch = fetch) =>
  call<components['schemas']['SessionResponse']>(f, '/api/v1/session', json(body), true)

export const deleteSession = (f: typeof fetch = fetch) =>
  call<undefined>(f, '/api/v1/session', { method: 'DELETE' }, false)

export const getMe = (f: typeof fetch = fetch) => call<AccountIdentity>(f, '/api/v1/me', { cache: 'no-store' }, true)

const orgPath = (organizationId: string) => `/api/v1/orgs/${encodeURIComponent(organizationId)}`

export const getOrganizationMe = (organizationId: string, f: typeof fetch = fetch) =>
  call<Identity>(f, `${orgPath(organizationId)}/me`, { cache: 'no-store' }, true)

export const isOrganizationUnavailable = (r: Result<unknown>) =>
  !r.ok && r.kind === 'http' && r.status === 404 && r.error === 'organization_unavailable'

export type Channel = components['schemas']['Channel']
export type ChannelVisibility = components['schemas']['ChannelVisibility']
export type CreateChannelRequest = components['schemas']['CreateChannelRequest']
export type Message = components['schemas']['Message']
export type MessagePage = components['schemas']['MessagePage']
export type SendMessageRequest = components['schemas']['SendMessageRequest']
export type ListMessagesQuery = NonNullable<
  import('./api-schema').operations['list_messages']['parameters']['query']
>

export const listChannels = (organizationId: string, f: typeof fetch = fetch) =>
  call<components['schemas']['ChannelList']>(f, `${orgPath(organizationId)}/channels`, { cache: 'no-store' }, true)

export const createChannel = (organizationId: string, body: CreateChannelRequest, f: typeof fetch = fetch) =>
  call<Channel>(f, `${orgPath(organizationId)}/channels`, json(body), true)

/** No cursor = latest page; pages are ascending by seq. */
export const listMessages = (organizationId: string, channelId: string, query: ListMessagesQuery = {}, f: typeof fetch = fetch) => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v))
  const suffix = qs.size > 0 ? `?${qs}` : ''
  return call<MessagePage>(f, `${orgPath(organizationId)}/channels/${encodeURIComponent(channelId)}/messages${suffix}`, { cache: 'no-store' }, true)
}

export const sendMessage = (organizationId: string, channelId: string, body: SendMessageRequest, f: typeof fetch = fetch) =>
  call<Message>(f, `${orgPath(organizationId)}/channels/${encodeURIComponent(channelId)}/messages`, json(body), true)

export type ServerEvent = import('./api-schema').ServerEvent
export type ClientMessage = import('./api-schema').ClientMessage

export type TimelineItem = components['schemas']['TimelineItem']
export type TimelinePage = components['schemas']['TimelinePage']
export type TopicPage = components['schemas']['TopicPage']
export type TopicSummary = components['schemas']['TopicSummary']
export type TopicSummaryResponse = components['schemas']['TopicSummaryResponse']
export type ListTimelineQuery = NonNullable<import('./api-schema').operations['list_timeline']['parameters']['query']>
export type ListTopicsQuery = NonNullable<import('./api-schema').operations['list_topics']['parameters']['query']>
export type TopicHistoryQuery = NonNullable<import('./api-schema').operations['topic_history']['parameters']['query']>

const channelPath = (organizationId: string, channelId: string) =>
  `${orgPath(organizationId)}/channels/${encodeURIComponent(channelId)}`
const querySuffix = (query: object) => {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined) qs.set(key, String(value))
  return qs.size ? `?${qs}` : ''
}

export const listTimeline = (organizationId: string, channelId: string, query: ListTimelineQuery = {}, f: typeof fetch = fetch) =>
  call<TimelinePage>(f, `${channelPath(organizationId, channelId)}/timeline${querySuffix(query)}`, { cache: 'no-store' }, true)

export const listTopics = (organizationId: string, channelId: string, query: ListTopicsQuery = {}, f: typeof fetch = fetch) =>
  call<TopicPage>(f, `${channelPath(organizationId, channelId)}/topics${querySuffix(query)}`, { cache: 'no-store' }, true)

export const getTopicSummary = (organizationId: string, channelId: string, topicId: string, f: typeof fetch = fetch) =>
  call<TopicSummaryResponse>(f, `${channelPath(organizationId, channelId)}/topics/${encodeURIComponent(topicId)}`, { cache: 'no-store' }, true)

export const listTopicMessages = (organizationId: string, channelId: string, topicId: string, query: TopicHistoryQuery = {}, f: typeof fetch = fetch) =>
  call<MessagePage>(f, `${channelPath(organizationId, channelId)}/topics/${encodeURIComponent(topicId)}/messages${querySuffix(query)}`, { cache: 'no-store' }, true)
