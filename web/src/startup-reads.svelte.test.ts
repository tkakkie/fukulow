import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuth } from './auth.svelte'
import type { ChannelList, DmChanges, DmList, Identity, MemberList, SectionLayout, ServerEvent, TimelinePage } from './api'

const ORG = '00000000-0000-4000-8000-000000000001'
const CHANNEL = '00000000-0000-4000-8000-000000000010'
const GEN = '00000000-0000-4000-8000-000000000515'
const SELF = '00000000-0000-4000-8000-000000000099'

const capabilities = {
  can_create_channels: { allowed: true },
  can_invite: { allowed: true },
  can_deactivate_members: { allowed: true },
  can_manage_roles: { allowed: true },
} as const

const accountMe = {
  account: { id: SELF, email: 'owner@example.com' },
  organizations: [{ organization_id: ORG, name: 'Acme', capabilities }],
}

const orgMe: Identity = {
  member: { id: SELF, name: 'Owner', role: 'owner' },
  organization: { organization_id: ORG, name: 'Acme', capabilities },
}

const channelList = (generation = GEN): ChannelList => ({
  history_generation: generation,
  channels: [{
    id: CHANNEL,
    kind: 'channel',
    name: 'general',
    visibility: 'public',
    archived: false,
    capabilities: {
      can_add_members: { allowed: true },
      can_remove_members: { allowed: true },
      can_manage_managers: { allowed: true },
      can_leave: { allowed: false },
      can_rename: { allowed: true },
      can_archive: { allowed: true },
    },
    history_generation: generation,
    as_of_seq: 1,
    read_seq: 1,
    unread_count: 0,
    main_unread_count: 0,
    mention_unread_count: 0,
    main_mention_unread_count: 0,
  }],
})

const timelinePage = (generation = GEN): TimelinePage => ({
  history_generation: generation,
  as_of_seq: 1,
  has_more: false,
  items: [{
    kind: 'message',
    message: {
      history_generation: generation,
      id: 'm1',
      channel_id: CHANNEL,
      client_message_id: 'c1',
      created_seq: 1,
      version: 1,
      deleted: false,
      sender: SELF,
      body: 'hello',
      mentions: [],
      topic_id: null,
      reply_to: null,
      reply_root_id: null,
      created_at: '2026-11-25T00:00:00Z',
    },
  }],
})

const sectionLayout = (generation = '1'): SectionLayout => ({
  generation,
  sections: [],
  other_channel_ids: [CHANNEL],
})

const dmChanges = (lane: string): DmChanges => ({
  dms: [],
  next_cursor: `${lane}-1`,
  caught_up: true,
})

const dmList = (generation = GEN): DmList => ({
  history_generation: generation,
  dms: [],
  next_cursor: null,
})

const memberList: MemberList = {
  members: [{ id: SELF, name: 'Owner', role: 'owner' }],
}

type FakeSocket = {
  url: string
  sent: string[]
  closed: boolean
  onopen: (() => void) | null
  onmessage: ((e: { data: string }) => void) | null
  onclose: ((e: { code: number }) => void) | null
  send(data: string): void
  close(): void
  emit(event: ServerEvent): void
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

type StartupCounts = { channels: number; me: number; sections: number; dmChanges: number; members: number }

function installHarness(options?: {
  onFetch?: (path: string, url: URL, init?: RequestInit) => Response | Promise<Response> | undefined
}) {
  const sockets: FakeSocket[] = []
  const counts: StartupCounts = { channels: 0, me: 0, sections: 0, dmChanges: 0, members: 0 }
  const dmLanes: string[] = []
  let currentGeneration = GEN
  let currentSectionGeneration = '1'

  class MockWebSocket {
    url: string
    sent: string[] = []
    closed = false
    onopen: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    onclose: ((e: { code: number }) => void) | null = null
    constructor(url: string) {
      this.url = url
      sockets.push(this)
    }
    send(data: string) { this.sent.push(data) }
    close() { this.closed = true }
    emit(event: ServerEvent) { this.onmessage?.({ data: JSON.stringify(event) }) }
  }

  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost', origin: 'http://localhost', pathname: '/', href: 'http://localhost/' })
  vi.spyOn(Math, 'random').mockReturnValue(0.5)

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, 'http://localhost')
    const path = url.pathname
    if (path === `/api/v1/orgs/${ORG}/channels` && !url.searchParams.has('archived')) counts.channels++
    else if (path === `/api/v1/orgs/${ORG}/me`) counts.me++
    else if (path === `/api/v1/orgs/${ORG}/me/sections`) counts.sections++
    else if (path === `/api/v1/orgs/${ORG}/dms/changes`) {
      counts.dmChanges++
      dmLanes.push(url.searchParams.get('lane') ?? '')
    } else if (path === `/api/v1/orgs/${ORG}/members`) counts.members++

    const custom = options?.onFetch?.(path, url, init)
    if (custom) return custom

    if (path === '/api/v1/me') return json(accountMe)
    if (path === '/api/v1/setup/status') return json({ initialized: true })
    if (path === `/api/v1/orgs/${ORG}/me`) return json(orgMe)
    if (path === `/api/v1/orgs/${ORG}/channels`) return json(channelList(currentGeneration))
    if (path === `/api/v1/orgs/${ORG}/channels/${CHANNEL}/timeline`) return json(timelinePage(currentGeneration))
    if (path === `/api/v1/orgs/${ORG}/me/sections`) return json(sectionLayout(currentSectionGeneration))
    if (path === `/api/v1/orgs/${ORG}/dms/changes`) return json(dmChanges(url.searchParams.get('lane') ?? 'delta'))
    if (path === `/api/v1/orgs/${ORG}/dms`) return json(dmList(currentGeneration))
    if (path === `/api/v1/orgs/${ORG}/members`) return json(memberList)
    return json({ error: 'not_found' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)

  return {
    sockets,
    counts,
    dmLanes,
    fetchMock,
    setGeneration(gen: string) { currentGeneration = gen },
    setSectionGeneration(gen: string) { currentSectionGeneration = gen },
    openAndReady(index = sockets.length - 1) {
      const ws = sockets[index]!
      ws.onopen?.()
      ws.emit({ type: 'activity_ready' })
      ws.emit({ type: 'subscribed', history_generation: currentGeneration, channel_id: CHANNEL, caught_up_seq: 1 })
      return ws
    },
  }
}

describe('Cold / startup REST read counts (#980)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each([
    { label: 'unthrottled (fast socket, members after ready)', socketDelayMs: 0, activateBeforeReady: false, expectedMembers: 1 },
    { label: 'unthrottled (fast socket, members before ready)', socketDelayMs: 0, activateBeforeReady: true, expectedMembers: 2 },
    { label: 'throttled (slow socket > 200 ms, members after ready)', socketDelayMs: 600, activateBeforeReady: false, expectedMembers: 1 },
    { label: 'throttled (slow socket > 200 ms, members before ready)', socketDelayMs: 600, activateBeforeReady: true, expectedMembers: 2 },
  ])('bounds all five startup reads on cold /: $label', async ({ socketDelayMs, activateBeforeReady, expectedMembers }) => {
    const h = installHarness()
    const auth = createAuth()
    try {
      await auth.load()
      await flush()
      expect(h.sockets).toHaveLength(1)

      if (activateBeforeReady) {
        auth.members!.activate()
        await flush()
      }

      if (socketDelayMs > 0) {
        await vi.advanceTimersByTimeAsync(socketDelayMs)
        await flush()
        // DM discovery waits for activity_ready so pre-connect reads are never wasted or fenced.
        expect(h.counts.dmChanges).toBe(0)
      }

      h.openAndReady(0)
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()

      if (!activateBeforeReady) {
        auth.members!.activate()
        await vi.advanceTimersByTimeAsync(1_000)
        await flush()
      }

      expect(h.counts).toEqual({
        channels: 2,
        me: 2,
        sections: 2,
        dmChanges: 2,
        members: expectedMembers,
      })
      expect(h.dmLanes).toEqual(['delta', 'coverage'])
    } finally {
      auth.session?.close()
      auth.members?.close()
    }
  })

  it('still refetches startup targets on reconnect and for real invalidation notices', async () => {
    const h = installHarness()
    const auth = createAuth()
    try {
      await auth.load()
      await flush()
      const ws1 = h.openAndReady(0)
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      auth.members!.activate()
      await vi.advanceTimersByTimeAsync(500)
      await flush()

      const afterStartup = { ...h.counts }
      expect(afterStartup).toEqual({ channels: 2, me: 2, sections: 2, dmChanges: 2, members: 1 })

      // Real invalidation notices after startup must each trigger fresh reads.
      h.setSectionGeneration('2')
      ws1.emit({ type: 'channel_list_changed' })
      ws1.emit({ type: 'channel_access_gained', channel_id: '00000000-0000-4000-8000-000000000020' })
      ws1.emit({ type: 'members_changed' })
      ws1.emit({ type: 'sections_changed', generation: '2' })
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()

      expect(h.counts.channels).toBeGreaterThan(afterStartup.channels)
      expect(h.counts.me).toBeGreaterThan(afterStartup.me)
      expect(h.counts.sections).toBeGreaterThan(afterStartup.sections)
      expect(h.counts.dmChanges).toBeGreaterThan(afterStartup.dmChanges)
      expect(h.counts.members).toBeGreaterThan(afterStartup.members)

      // Disconnect and reconnect must refetch across every reconciled target.
      const beforeReconnect = { ...h.counts }
      ws1.onclose?.({ code: 1011 })
      await vi.advanceTimersByTimeAsync(2_000)
      await flush()
      expect(h.sockets.length).toBeGreaterThanOrEqual(2)
      h.openAndReady()
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()

      expect(h.counts.channels).toBeGreaterThan(beforeReconnect.channels)
      expect(h.counts.me).toBeGreaterThan(beforeReconnect.me)
      expect(h.counts.sections).toBeGreaterThan(beforeReconnect.sections)
      expect(h.counts.members).toBeGreaterThan(beforeReconnect.members)
    } finally {
      auth.session?.close()
      auth.members?.close()
    }
  })

  it('retries after a failed or aborted startup read and never treats it as coverage', async () => {
    let failChannels = true
    let abortSections = true
    let failDmDelta = true
    let failMembers = true
    const h = installHarness({
      onFetch(path, _url, init) {
        if (path === `/api/v1/orgs/${ORG}/channels` && failChannels) {
          failChannels = false
          return json({ error: 'server_error' }, 503)
        }
        if (path === `/api/v1/orgs/${ORG}/me/sections` && abortSections) {
          abortSections = false
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          })
        }
        if (path === `/api/v1/orgs/${ORG}/dms/changes` && failDmDelta) {
          failDmDelta = false
          return json({ error: 'server_error' }, 503)
        }
        if (path === `/api/v1/orgs/${ORG}/members` && failMembers) {
          failMembers = false
          return json({ error: 'server_error' }, 503)
        }
        return undefined
      },
    })
    const auth = createAuth()
    try {
      await auth.load()
      await flush()
      // Let the first sections read time out (10 s deadline) and abort before activity_ready.
      await vi.advanceTimersByTimeAsync(10_000)
      await flush()
      h.openAndReady(0)
      await vi.advanceTimersByTimeAsync(2_000)
      await flush()
      auth.members!.activate()
      await vi.advanceTimersByTimeAsync(2_000)
      await flush()
      // Advance to the next O5 periodic run (15 s) so the failed delta lane retries with fresh budget.
      await vi.advanceTimersByTimeAsync(15_000)
      await flush()

      expect(h.counts.channels).toBeGreaterThanOrEqual(2)
      expect(auth.session?.channels.state.status).toBe('ready')
      expect(h.counts.sections).toBeGreaterThanOrEqual(2)
      expect(auth.session?.sections?.state.generation).toBe('1')
      expect(h.counts.dmChanges).toBeGreaterThanOrEqual(3)
      expect(auth.session?.dms?.state.status).toBe('ready')
      expect(h.counts.members).toBeGreaterThanOrEqual(2)
      expect(auth.members?.state.members).toHaveLength(1)
    } finally {
      auth.session?.close()
      auth.members?.close()
    }
  })

  it('re-reads on a history_generation change and enforces the Account Session 401 fence', async () => {
    let return401 = false
    const h = installHarness({
      onFetch(path) {
        if (return401 && path === `/api/v1/orgs/${ORG}/members`) return json({ error: 'unauthorized' }, 401)
        return undefined
      },
    })
    const auth = createAuth()
    try {
      await auth.load()
      await flush()
      const ws1 = h.openAndReady(0)
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      const beforeReset = { ...h.counts }

      // A changed history_generation resets sync, channels, and DM discovery on a fresh socket.
      const nextGen = '00000000-0000-4000-8000-000000000516'
      h.setGeneration(nextGen)
      ws1.emit({ type: 'channel_list_changed' })
      await vi.advanceTimersByTimeAsync(2_000)
      await flush()
      expect(h.sockets.length).toBeGreaterThanOrEqual(2)
      h.openAndReady()
      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      expect(h.counts.channels).toBeGreaterThan(beforeReset.channels)
      expect(h.counts.dmChanges).toBeGreaterThan(beforeReset.dmChanges)

      // A 401 ends the Account Session (C6).
      return401 = true
      auth.members!.activate()
      await flush()
      expect(auth.view.screen).toBe('signin')
    } finally {
      auth.session?.close()
      auth.members?.close()
    }
  })
})
