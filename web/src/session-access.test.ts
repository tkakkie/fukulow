import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import * as api from './api'
import { createAuth } from './auth.svelte'
import { channelsAdapter } from './channels.svelte'
import type { RepliesApi } from './replies'
import { repliesAdapter } from './replies.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import * as topicSync from './topic-sync'
import { deferred } from './topic-test-helpers'
import { topicsAdapter } from './topics.svelte'

const timeout = 100
const unauthorized = { ok: false, kind: 'http', status: 401 } as const
const membershipLost = { ok: false, kind: 'http', status: 404, error: 'organization_unavailable' } as const
const anchor = record(100)

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function open(source: 'Topics' | 'Replies' | 'Unread' | 'Reply counts' | 'Membership probe') {
  const net = fakeNetwork()
  const options = net.options()
  const result = deferred<api.Result<never>>()
  const request = vi.fn(() => result.promise)
  switch (source) {
    case 'Topics': options.topicsApi!.listTopics = request; break
    case 'Replies': options.repliesApi!.listReplyChain = request; break
    case 'Unread': options.unreadApi!.listChannels = request; break
    case 'Reply counts': options.replyCountsApi = request; break
    case 'Membership probe': vi.spyOn(api, 'getOrganizationMe').mockImplementation(request); break
  }
  const onEnded = vi.fn(() => {
    runningAtEnd = session.sync.get().running
    session.close()
  })
  let runningAtEnd: boolean | undefined
  const session = createSession({ selfId: 'me', organizationId: 'org', ...options, onEnded,
    sync: { ...options.sync, requestTimeoutMs: timeout } })
  let stopInputs = 0
  let unavailableInputs = 0
  let organizationAtClose: ReturnType<typeof session.sync.get>['organization'] | undefined
  const close = session.channelCreation.close
  const closeCreation = vi.spyOn(session.channelCreation, 'close').mockImplementation(() => {
    organizationAtClose ??= session.sync.get().organization
    close()
  })
  const stop = session.sync.onInput(input => {
    if (input.type === 'stop') stopInputs++
    if (input.type === 'organization_unavailable' || (input.type === 'socket_closed' && input.code === 4003)) unavailableInputs++
  })
  return {
    session, net, request, result, onEnded, closeCreation,
    get runningAtEnd() { return runningAtEnd },
    get stopInputs() { return stopInputs },
    get unavailableInputs() { return unavailableInputs },
    get organizationAtClose() { return organizationAtClose },
    async start() {
      if (source === 'Membership probe') {
        net.socket.onClose(1006)
        await settle()
        return
      }
      net.pages.A = ok({ history_generation: anchor.history_generation, as_of_seq: 100, messages: [anchor], has_more: false })
      net.lists[0].resolve(ok({ history_generation: anchor.history_generation, channels: [channel('A')] }))
      net.socket.onReady()
      await settle()
      net.subscribed('A', 100)
      switch (source) {
        case 'Topics': void session.topics.loadList('A'); break
        case 'Replies': void session.replies.open('A', anchor); break
        case 'Unread': void session.unread.refresh(); break
        case 'Reply counts': break
      }
      await settle()
    },
    close() { stop(); session.close() },
  }
}

const sources = ['Topics', 'Replies', 'Unread', 'Reply counts', 'Membership probe'] as const

it.each(sources)('reports a late %s 401 before the Account owner closes sync', async source => {
  const c = open(source)
  try {
    await c.start()
    expect(c.request).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(timeout)
    expect(c.onEnded).not.toHaveBeenCalled()
    expect(c.session.sync.get().running).toBe(true)
    c.result.resolve(unauthorized)
    await settle()
    expect(c.onEnded).toHaveBeenCalledOnce()
    expect(c.runningAtEnd).toBe(true)
    expect(c.stopInputs).toBe(1)
    expect(c.session.sync.get().running).toBe(false)
    expect(c.net.socket.closed).toBe(true)
  } finally { c.close() }
})

it('signs out the Account when a Reply chain read returns 401 after switching Organizations', async () => {
  const net = fakeNetwork()
  const result = deferred<api.Result<never>>()
  const listReplyChain = vi.fn<RepliesApi['listReplyChain']>(() => result.promise)
  const capabilities = { can_invite: { allowed: false }, can_deactivate_members: { allowed: false },
    can_manage_roles: { allowed: false }, can_create_channels: { allowed: false } }
  const organization = { organization_id: 'org', name: 'Org', capabilities }
  const auth = createAuth({
    restore: async () => ({ screen: 'app', identity: { account: { id: 'me', email: 'me@example.com' }, organizations: [organization] } }),
    signIn: vi.fn(), setupAndSignIn: vi.fn(), signOut: async () => true,
    getOrganization: async id => ok({ organization: { ...organization, organization_id: id }, member: { id: 'me', name: 'Me', role: 'member' } }),
    openSession(selfId, onEnded, organizationId, _drafts, _onIdentity, _role, accountSignal) {
      const session = createSession({ ...net.options(), selfId, onEnded, organizationId, accountSignal,
        repliesApi: { listReplyChain } })
      return { channels: channelsAdapter(session.channels, session.channelCreation), sync: syncAdapter(session.sync),
        topics: id => topicsAdapter(session.topics, id), close: session.close,
        replies: id => repliesAdapter(session.replies, id, session.replyCounts, session.moveChain) }
    },
  })
  try {
    await auth.load()
    const oldSocket = net.socket
    net.pages.A = ok({ history_generation: anchor.history_generation, as_of_seq: 100, messages: [anchor], has_more: false })
    net.lists[0].resolve(ok({ history_generation: anchor.history_generation, channels: [channel('A')] }))
    oldSocket.onReady()
    await settle()
    net.subscribed('A', 100)
    void auth.session!.replies!('A').open(anchor)
    await settle()
    expect(listReplyChain).toHaveBeenCalledOnce()
    const signal = listReplyChain.mock.calls[0][3]

    await auth.selectOrganization('other')
    expect(auth.selectedOrganizationId).toBe('other')
    expect(oldSocket.closed).toBe(true)
    expect(net.socket.closed).toBe(false)
    expect(signal?.aborted).toBe(false)

    result.resolve(unauthorized)
    await settle()
    expect(auth.view.screen).toBe('signin')
    expect(auth.session).toBeNull()
    expect(net.socket.closed).toBe(true)
    expect(signal?.aborted).toBe(true)
  } finally { await auth.signOut() }
})

it.each(sources)('reports late %s Membership loss through the Session C10 transition', async source => {
  const c = open(source)
  const markUnavailable = vi.spyOn(c.session.sync, 'unavailable')
  try {
    await c.start()
    expect(c.request).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(timeout)
    expect(c.session.sync.get().organization).toBe('available')
    c.result.resolve(membershipLost)
    await settle()
    expect(c.onEnded).not.toHaveBeenCalled()
    expect(markUnavailable).not.toHaveBeenCalled()
    expect(c.unavailableInputs).toBe(1)
    expect(c.organizationAtClose).toBe('available')
    expect(c.session.sync.get()).toMatchObject({ organization: 'unavailable', running: false })
    expect(c.net.socket.closed).toBe(true)
  } finally { c.close() }
})

it('reports a WebSocket 4003 through the Session C10 transition', async () => {
  const compose = topicSync.createTopicSync
  const report = vi.fn<(deliver: () => void) => void>()
  vi.spyOn(topicSync, 'createTopicSync').mockImplementation(options => compose({ ...options,
    reportOrganizationUnavailable: apply => report(() => options.reportOrganizationUnavailable?.(apply)),
  }))
  const c = open('Replies')
  try {
    c.net.socket.onReady()
    c.net.socket.onClose(4003)
    expect(report).toHaveBeenCalledOnce()
    expect(c.session.sync.get().organization).toBe('available')
    report.mock.calls[0][0]()
    await settle()
    expect(c.unavailableInputs).toBe(1)
    expect(c.organizationAtClose).toBe('unavailable')
    expect(c.onEnded).not.toHaveBeenCalled()
    expect(c.session.sync.get()).toMatchObject({ organization: 'unavailable', running: false })
  } finally { c.close() }
})

it.each([unauthorized, membershipLost])('treats a second access report (HTTP $status) as a no-op', async result => {
  const c = open('Replies')
  try {
    await c.start()
    void c.session.channels.load()
    await settle()
    expect(c.net.lists).toHaveLength(2)
    c.result.resolve(result)
    await settle()
    const counts = [c.onEnded.mock.calls.length, c.closeCreation.mock.calls.length, c.unavailableInputs]
    expect(counts[0]).toBe(result.status === 401 ? 1 : 0)
    expect(counts[2]).toBe(result.status === 401 ? 0 : 1)
    c.net.lists[1].resolve(result)
    await settle()
    expect([c.onEnded.mock.calls.length, c.closeCreation.mock.calls.length, c.unavailableInputs]).toEqual(counts)
  } finally { c.close() }
})
