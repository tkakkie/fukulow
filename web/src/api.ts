/** Returns true when the server answers the health check. */
export async function checkHealth(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/api/v1/health')
    return res.ok
  } catch {
    return false
  }
}

import { rememberIdentityResponse } from './identity-order'
import type { components } from './api-schema'

export type AccountIdentity = components['schemas']['AccountIdentity']
export type Identity = components['schemas']['Identity']
export type SetupRequest = components['schemas']['SetupRequest']
export type SignInRequest = components['schemas']['SignInRequest']

/** Result of an API call. `network` covers fetch failures and 5xx, including admission 503
 * (retryable with the same client_message_id, never a definite send refusal or "signed out"). */
export type Result<T> = { ok: true; data: T } | { ok: false; kind: 'http'; status: number; error?: string; retryAfterMs?: number } | { ok: false; kind: 'network'; error?: string; retryAfterMs?: number }

// Bound 5xx body reads (used only when Retry-After is absent) so stalled responses cannot hang callers.
const SERVER_ERROR_BODY_TIMEOUT_MS = 1000

function cancelResponseBody(res: Response): void {
  try {
    void res.body?.cancel().catch(() => {})
  } catch { /* Ignore body cancel failures on locked or closed streams. */ }
}

async function readServerErrorCode(res: Response, signal?: AbortSignal | null): Promise<string | undefined> {
  if (!res.body) return undefined
  if (signal?.aborted) {
    cancelResponseBody(res)
    return undefined
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = res.body.getReader()
  } catch {
    return undefined
  }
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try { void reader.cancel().catch(() => {}) } catch { /* Ignore cancel failures on closed readers. */ }
  }
  const timer = setTimeout(stop, SERVER_ERROR_BODY_TIMEOUT_MS)
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (stopped) return undefined
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
    if (total === 0) return undefined
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<components['schemas']['ErrorBody']> | null
    return typeof parsed?.error === 'string' ? parsed.error : undefined
  } catch { /* Non-JSON, empty, or cancelled 5xx body leaves error absent. */
    return undefined
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    try { reader.releaseLock() } catch { /* Ignore lock release failures. */ }
  }
}

async function call<T>(
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit,
  parse: boolean,
  successStatus?: number,
): Promise<Result<T>> {
  try {
    // Cookie auth only: the HttpOnly session cookie is sent by the browser; no token is stored.
    const res = await fetchFn(path, { credentials: 'same-origin', ...init })
    if (res.status >= 500) {
      const header = res.headers.get('Retry-After')
      if (header !== null) {
        cancelResponseBody(res)
        const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()
        return { ok: false, kind: 'network', ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(0, delay) } : {}) }
      }
      const error = await readServerErrorCode(res, init.signal)
      return { ok: false, kind: 'network', ...(error === undefined ? {} : { error }) }
    }
    if (!res.ok) {
      let error: string | undefined
      try { error = ((await res.json()) as components['schemas']['ErrorBody']).error } catch { /* Status remains authoritative for malformed errors. */ }
      const header = res.headers.get('Retry-After')
      const delay = header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : NaN
      return { ok: false, kind: 'http', status: res.status, ...(error === undefined ? {} : { error }),
        ...(res.status === 429 ? { retryAfterMs: Number.isSafeInteger(delay) && delay >= 1000 ? delay : 1000 } : {}) }
    }
    if (successStatus !== undefined && res.status !== successStatus) return { ok: false, kind: 'network' }
    const data = (parse ? await res.json() : undefined) as T
    rememberIdentityResponse(data)
    return { ok: true, data }
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
  call<undefined>(f, '/api/v1/session', { method: 'DELETE' }, false, 204)

export const getMe = (f: typeof fetch = fetch) => call<AccountIdentity>(f, '/api/v1/me', { cache: 'no-store' }, true)

const orgPath = (organizationId: string) => `/api/v1/orgs/${encodeURIComponent(organizationId)}`

export const getOrganizationMe = (organizationId: string, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<Identity>(f, `${orgPath(organizationId)}/me`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)

export const isOrganizationUnavailable = (r: Result<unknown>) =>
  !r.ok && r.kind === 'http' && r.status === 404 && r.error === 'organization_unavailable'

export type Channel = components['schemas']['Channel']
export type ChannelVisibility = components['schemas']['ChannelVisibility']
export type CreateChannelRequest = components['schemas']['CreateChannelRequest']
export type { UpdateChannelRequest } from './api-schema'
export type Message = components['schemas']['Message']
export type ChannelEventPage = components['schemas']['ChannelEventPage']
export type ListChannelEventsQuery = NonNullable<import('./api-schema').operations['list_channel_events']['parameters']['query']>
export const listChannelEvents = (organizationId: string, channelId: string, query: ListChannelEventsQuery, f: typeof fetch = fetch) =>
  call<ChannelEventPage>(f, `${orgPath(organizationId)}/channels/${encodeURIComponent(channelId)}/events?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`, { cache: 'no-store' }, true)
export type MessagePage = components['schemas']['MessagePage']
export type SendMessageRequest = components['schemas']['SendMessageRequest']
export type ListMessagesQuery = NonNullable<
  import('./api-schema').operations['list_messages']['parameters']['query']
>

export const CHANNEL_READ_ID_HEADER = 'x-fukulow-read-id'

export const listChannels = (organizationId: string, f: typeof fetch = fetch, signal?: AbortSignal, query?: NonNullable<import('./api-schema').operations['list_channels']['parameters']['query']>, readId?: string) =>
  call<components['schemas']['ChannelList']>(
    f,
    `${orgPath(organizationId)}/channels${querySuffix(query ?? {})}`,
    { cache: 'no-store', ...(signal ? { signal } : {}), ...(readId ? { headers: { [CHANNEL_READ_ID_HEADER]: readId } } : {}) },
    true,
  )

export const createChannel = (organizationId: string, body: CreateChannelRequest, f: typeof fetch = fetch) =>
  call<Channel>(f, `${orgPath(organizationId)}/channels`, json(body), true)

export type { ChannelOrder, ChannelPlacement, CreatedSection, CreateSection, MoveChannel, RenameSection, SectionLayout, SectionOrder } from './api-schema'
const sectionsPath = (org: string) => `${orgPath(org)}/me/sections`
const placementPath = (org: string, channel: string) => `${orgPath(org)}/me/channel-sections/${encodeURIComponent(channel)}`

export const getSectionLayout = (org: string, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<components['schemas']['SectionLayout']>(f, sectionsPath(org), { cache: 'no-store', signal }, true, 200)
export const getChannelPlacement = (org: string, channel: string, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<components['schemas']['ChannelPlacement']>(f, placementPath(org, channel), { cache: 'no-store', signal }, true, 200)
export const createSection = (org: string, body: components['schemas']['CreateSection'], f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<components['schemas']['CreatedSection']>(f, sectionsPath(org), { ...json(body), signal }, true)
export const renameSection = (org: string, id: string, body: components['schemas']['RenameSection'], f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<undefined>(f, `${sectionsPath(org)}/${encodeURIComponent(id)}`, { ...json(body), method: 'PATCH', signal }, false, 204)
export const reorderSections = (org: string, body: components['schemas']['SectionOrder'], f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<undefined>(f, `${sectionsPath(org)}/order`, { ...json(body), method: 'PUT', signal }, false, 204)
export const moveChannel = (org: string, channel: string, body: components['schemas']['MoveChannel'], f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<undefined>(f, placementPath(org, channel), { ...json(body), method: 'PUT', signal }, false, 204)
export const reorderSectionChannels = (org: string, body: components['schemas']['ChannelOrder'], f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<undefined>(f, `${orgPath(org)}/me/section-channel-order`, { ...json(body), method: 'PUT', signal }, false, 204)
export const deleteSection = (org: string, id: string, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<undefined>(f, `${sectionsPath(org)}/${encodeURIComponent(id)}`, { method: 'DELETE', signal }, false, 204)

export type { Dm, DmChanges, DmDiscovery, DmList, OpenDmRequest } from './api-schema'
export type DmListQuery = NonNullable<import('./api-schema').operations['list_dms']['parameters']['query']>
export type DmChangesQuery = import('./api-schema').operations['dm_changes']['parameters']['query']
export const listDms = (org: string, query: DmListQuery = {}, f: typeof fetch = fetch, signal?: AbortSignal) => {
  const params = new URLSearchParams()
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  if (query.history_generation !== undefined) params.set('history_generation', query.history_generation)
  for (const id of query.channel_id ?? []) params.append('channel_id', id)
  return call<components['schemas']['DmList']>(f, `${orgPath(org)}/dms${params.size ? `?${params}` : ''}`, { cache: 'no-store', signal }, true)
}
export const listDmChanges = (org: string, query: DmChangesQuery, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<components['schemas']['DmChanges']>(f, `${orgPath(org)}/dms/changes${querySuffix(query)}`, { cache: 'no-store', signal }, true)
export const openDm = (org: string, body: components['schemas']['OpenDmRequest'], f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<components['schemas']['Dm']>(f, `${orgPath(org)}/dms`, { ...json(body), signal }, true)

/** No cursor = latest page; pages are ascending by seq. */
export const listMessages = (organizationId: string, channelId: string, query: ListMessagesQuery = {}, f: typeof fetch = fetch, signal?: AbortSignal) => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v))
  const suffix = qs.size > 0 ? `?${qs}` : ''
  return call<MessagePage>(f, `${orgPath(organizationId)}/channels/${encodeURIComponent(channelId)}/messages${suffix}`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)
}

export const sendMessage = (organizationId: string, channelId: string, body: SendMessageRequest, f: typeof fetch = fetch) =>
  call<Message>(f, `${orgPath(organizationId)}/channels/${encodeURIComponent(channelId)}/messages`, json(body), true)

export type ServerEvent = import('./api-schema').ServerEvent
export type ClientMessage = import('./api-schema').ClientMessage

export type Role = components['schemas']['Role']
export type Member = components['schemas']['Member']
export type DisplayIdentity = components['schemas']['DisplayIdentity']
export const lookupAuthors = (organizationId: string, body: components['schemas']['AuthorLookupRequest'], f: typeof fetch = fetch) =>
  call<components['schemas']['AuthorIdentities']>(f, `${orgPath(organizationId)}/message-authors`, json(body), true)
export type CreateInviteRequest = components['schemas']['CreateInviteRequest']
export type AcceptInviteRequest = components['schemas']['AcceptInviteRequest']
export type InviteResponse = components['schemas']['InviteResponse']
export const listMembers = (organizationId: string, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<components['schemas']['MemberList']>(f, `${orgPath(organizationId)}/members`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)
export const deactivateMember = (organizationId: string, memberId: string, f: typeof fetch = fetch) =>
  call<undefined>(f, `${orgPath(organizationId)}/members/${encodeURIComponent(memberId)}/deactivate`, { method: 'POST' }, false)
export const changeRole = (organizationId: string, memberId: string, role: Role, f: typeof fetch = fetch) =>
  call<Member>(f, `${orgPath(organizationId)}/members/${encodeURIComponent(memberId)}/role`, { ...json({ role }), method: 'PATCH' }, true)
export const createInvite = (organizationId: string, body: CreateInviteRequest, f: typeof fetch = fetch) =>
  call<InviteResponse>(f, `${orgPath(organizationId)}/invites`, json(body), true)
export const acceptInvite = (organizationId: string, body: AcceptInviteRequest, f: typeof fetch = fetch) =>
  call<Identity>(f, `${orgPath(organizationId)}/invites/accept`, json(body), true)

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

export const getChannel = (org: string, id: string, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<Channel>(f, channelPath(org, id), { cache: 'no-store', ...(signal ? { signal } : {}) }, true)

export const updateChannel = (org: string, id: string, body: components['schemas']['UpdateChannelRequest'], f: typeof fetch = fetch) =>
  call<undefined>(f, channelPath(org, id), { ...json(body), method: 'PATCH' }, false, 204)

const querySuffix = (query: object) => {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined) qs.set(key, String(value))
  return qs.size ? `?${qs}` : ''
}

export const listTimeline = (organizationId: string, channelId: string, query: ListTimelineQuery = {}, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<TimelinePage>(f, `${channelPath(organizationId, channelId)}/timeline${querySuffix(query)}`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)

export const listTopics = (organizationId: string, channelId: string, query: ListTopicsQuery = {}, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<TopicPage>(f, `${channelPath(organizationId, channelId)}/topics${querySuffix(query)}`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)

export const getTopicSummary = (organizationId: string, channelId: string, topicId: string, f: typeof fetch = fetch, signal?: AbortSignal, query: NonNullable<import('./api-schema').operations['topic_summary']['parameters']['query']> = {}) =>
  call<TopicSummaryResponse>(f, `${channelPath(organizationId, channelId)}/topics/${encodeURIComponent(topicId)}${querySuffix(query)}`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)

export const listTopicMessages = (organizationId: string, channelId: string, topicId: string, query: TopicHistoryQuery = {}, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<MessagePage>(f, `${channelPath(organizationId, channelId)}/topics/${encodeURIComponent(topicId)}/messages${querySuffix(query)}`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)

export type ReplyCountPage = components['schemas']['ReplyCountPage']
export type ReplyCountRequest = components['schemas']['ReplyCountRequest']
export const getReplyCounts = (organizationId: string, channelId: string, body: ReplyCountRequest, signal?: AbortSignal, f: typeof fetch = fetch) =>
  call<ReplyCountPage>(f, `${channelPath(organizationId, channelId)}/reply-counts`, { ...json(body), cache: 'no-store', signal }, true)

export type ReplyChainPage = components['schemas']['ReplyChainPage']
export type ReplyChainQuery = NonNullable<import('./api-schema').operations['reply_chain']['parameters']['query']>

export const listReplyChain = (organizationId: string, channelId: string, anchor: string, query: ReplyChainQuery = {}, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<ReplyChainPage>(f, `${channelPath(organizationId, channelId)}/messages/${encodeURIComponent(anchor)}/chain${querySuffix(query)}`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)

export type MoveChainRequest = components['schemas']['MoveChainRequest']
export type MoveChainResponse = components['schemas']['MoveChainResponse']
export const moveChain = (organizationId: string, channelId: string, anchor: string, body: MoveChainRequest, f: typeof fetch = fetch) =>
  call<MoveChainResponse>(f, `${channelPath(organizationId, channelId)}/messages/${encodeURIComponent(anchor)}/move`, json(body), true, 200)

export type ChannelMember = components['schemas']['ChannelMember']
export type ChannelMemberList = components['schemas']['ChannelMemberList']
export type ChangeChannelManagerRequest = components['schemas']['ChangeChannelManagerRequest']

export const listChannelMembers = (org: string, channel: string, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<ChannelMemberList>(f, `${orgPath(org)}/channels/${encodeURIComponent(channel)}/members`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)
export const addChannelMember = (org: string, channel: string, body: components['schemas']['AddChannelMemberRequest'], f: typeof fetch = fetch) =>
  call<undefined>(f, `${orgPath(org)}/channels/${encodeURIComponent(channel)}/members`, json(body), false)
export const removeChannelMember = (org: string, channel: string, member: string, f: typeof fetch = fetch) =>
  call<undefined>(f, `${orgPath(org)}/channels/${encodeURIComponent(channel)}/members/${encodeURIComponent(member)}`, { method: 'DELETE' }, false)
export const changeChannelManager = (org: string, channel: string, member: string, body: ChangeChannelManagerRequest, f: typeof fetch = fetch) =>
  call<undefined>(f, `${orgPath(org)}/channels/${encodeURIComponent(channel)}/members/${encodeURIComponent(member)}`, { ...json(body), method: 'PATCH' }, false)

export type MemberList = components['schemas']['MemberList']

export type ChannelList = components['schemas']['ChannelList']
export type UnreadChannel = components['schemas']['UnreadChannel']
export type MarkReadRequest = components['schemas']['MarkReadRequest']
export type ReadPosition = components['schemas']['ReadPosition']

export const markChannelRead = (org: string, channel: string, body: MarkReadRequest, f: typeof fetch = fetch) =>
  call<ReadPosition>(f, `${channelPath(org, channel)}/read`, { ...json(body), method: 'PUT' }, true)
export const markTopicRead = (org: string, channel: string, topic: string, body: MarkReadRequest, f: typeof fetch = fetch) =>
  call<ReadPosition>(f, `${channelPath(org, channel)}/topics/${encodeURIComponent(topic)}/read`, { ...json(body), method: 'PUT' }, true)

export type ChangePasswordRequest = components['schemas']['ChangePasswordRequest']
export type RevokeOtherSessionsRequest = components['schemas']['RevokeOtherSessionsRequest']
export const putPassword = (body: ChangePasswordRequest, f: typeof fetch = fetch) =>
  call<undefined>(f, '/api/v1/me/password', { ...json(body), method: 'PUT' }, false)
export const revokeOtherSessions = (body: RevokeOtherSessionsRequest, f: typeof fetch = fetch) =>
  call<undefined>(f, '/api/v1/me/sessions/revoke-others', json(body), false)

export type OutstandingInvite = components['schemas']['OutstandingInvite']
export type InvitePage = components['schemas']['InvitePage']
export const listInvites = (org: string, cursor?: string, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<InvitePage>(f, `${orgPath(org)}/invites${querySuffix({ cursor })}`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)
export const revokeInvite = (org: string, id: string, f: typeof fetch = fetch) =>
  call<undefined>(f, `${orgPath(org)}/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }, false, 204)

export type SearchHit = components['schemas']['SearchHit']
export type SearchPage = components['schemas']['SearchPage']
export type SearchQuery = import('./api-schema').operations['search']['parameters']['query']
export const searchMessages = (organizationId: string, query: SearchQuery, f: typeof fetch = fetch, signal?: AbortSignal) =>
  call<SearchPage>(f, `${orgPath(organizationId)}/search${querySuffix(query)}`, { cache: 'no-store', ...(signal ? { signal } : {}) }, true)
