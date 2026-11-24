import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from './api'
import { channel, fakeNetwork, ok } from './adapter-test-helpers.svelte'
import { createSession, type Session } from './session'
import { deferred } from './topic-test-helpers'

const allowed: api.Identity = {
  member: { id: 'me', name: '本人', role: 'member' },
  organization: {
    organization_id: 'org', name: '組織',
    capabilities: {
      can_invite: { allowed: false }, can_manage_roles: { allowed: false },
      can_deactivate_members: { allowed: false }, can_create_channels: { allowed: true },
    },
  },
}
const draft = { name: '取引先', visibility: 'private' as const }

describe('Channel creation capability in a Session', () => {
  let session: Session | undefined

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    session?.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function open(initiallyAllowed = true) {
    const net = fakeNetwork()
    const options = net.options()
    const onEnded = vi.fn()
    session = createSession({
      selfId: 'me', onEnded, ...options, initialRole: initiallyAllowed ? 'member' : 'guest',
      initialCanCreateChannels: initiallyAllowed, sync: { ...options.sync, random: () => 0.5 },
    })
    net.socket.onReady()
    net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }))
    return { net, session, creation: session.channelCreation, onEnded }
  }

  it('holds Channel creation during periodic revalidation and submits once after confirmation', async () => {
    const { net, creation } = open()
    const getMe = vi.spyOn(api, 'getOrganizationMe').mockResolvedValue(ok(allowed))
    net.socket.onEvent({ type: 'activity_ready' })
    await vi.advanceTimersByTimeAsync(200)
    expect(creation.get()).toBe('allowed')
    await vi.advanceTimersByTimeAsync(14_800)
    expect(creation.get()).toBe('revalidating')
    const submission = creation.submit(draft)
    expect(await creation.submit(draft)).toBe(false)
    expect(net.creates).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(getMe).toHaveBeenCalledTimes(2)
    expect(net.creates).toHaveLength(1)
    const created = channel('new', draft.name)
    net.creates[0].resolve(ok(created))
    expect(await submission).toEqual({ channel: created })
  })

  it('blocks Channel creation for a confirmed Guest and removes a held affordance on Guest confirmation', async () => {
    const { net, creation } = open(false)
    const getMe = vi.spyOn(api, 'getOrganizationMe').mockResolvedValue(ok(allowed))
    expect(creation.get()).toBe('denied')
    expect(await creation.submit(draft)).toHaveProperty('blocked')
    expect(net.creates).toHaveLength(0)
    net.socket.onEvent({ type: 'activity_ready' })
    await vi.advanceTimersByTimeAsync(200)
    expect(creation.get()).toBe('allowed')
    getMe.mockResolvedValue(ok({
      ...allowed, member: { ...allowed.member, role: 'guest' },
      organization: { ...allowed.organization, capabilities: {
        ...allowed.organization.capabilities, can_create_channels: { allowed: false },
      } },
    }))
    net.socket.onEvent({ type: 'activity_reset' })
    const submission = creation.submit(draft)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await submission).toHaveProperty('blocked')
    expect(creation.get()).toBe('denied')
    expect(net.creates).toHaveLength(0)
  })

  it('cancels a held submit on an access notice and fences the older allowed /me response', async () => {
    const { net, creation } = open()
    const stale = deferred<api.Result<api.Identity>>()
    const current = deferred<api.Result<api.Identity>>()
    const getMe = vi.spyOn(api, 'getOrganizationMe')
      .mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise)
    net.socket.onEvent({ type: 'activity_ready' })
    await vi.advanceTimersByTimeAsync(200)
    expect(getMe).toHaveBeenCalledOnce()
    const submission = creation.submit(draft)

    net.socket.onEvent({ type: 'members_changed' })
    expect(await submission).toHaveProperty('blocked')
    expect(await creation.submit(draft)).toHaveProperty('blocked')
    net.socket.onEvent({ type: 'activity_reset' })
    stale.resolve(ok(allowed))
    await vi.advanceTimersByTimeAsync(200)
    expect(getMe).toHaveBeenCalledTimes(2)
    expect(creation.get()).toBe('hidden')
    expect(net.creates).toHaveLength(0)

    current.resolve(ok(allowed))
    await vi.advanceTimersByTimeAsync(0)
    expect(creation.get()).toBe('allowed')
    expect(net.creates).toHaveLength(0)
    const newSubmission = creation.submit(draft)
    expect(net.creates).toHaveLength(1)
    const created = channel('new', draft.name)
    net.creates[0].resolve(ok(created))
    expect(await newSubmission).toEqual({ channel: created })
  })

  it.each([400, 503])('settles the held submit when /me returns %i', async status => {
    const { net, creation } = open()
    vi.spyOn(api, 'getOrganizationMe').mockResolvedValue({ ok: false, kind: 'http', status })
    net.socket.onEvent({ type: 'activity_ready' })
    const submission = creation.submit(draft)
    await vi.advanceTimersByTimeAsync(200)
    expect(await submission).toHaveProperty('blocked')
    expect(creation.get()).toBe('hidden')
    expect(net.creates).toHaveLength(0)
  })

  it.each([4001, 4003])('retires a held submit when the socket closes with %i', async code => {
    const { net, creation, onEnded } = open()
    const pending = deferred<api.Result<api.Identity>>()
    const getMe = vi.spyOn(api, 'getOrganizationMe').mockReturnValue(pending.promise)
    net.socket.onEvent({ type: 'activity_ready' })
    await vi.advanceTimersByTimeAsync(200)
    expect(getMe).toHaveBeenCalledOnce()
    const submission = creation.submit(draft)
    net.socket.onClose(code)
    await vi.advanceTimersByTimeAsync(0)
    expect(await submission).toBe(false)
    pending.resolve(ok(allowed))
    await vi.advanceTimersByTimeAsync(0)
    expect(net.creates).toHaveLength(0)
    expect(creation.get()).toBe('denied')
    expect(onEnded).toHaveBeenCalledTimes(code === 4001 ? 1 : 0)
  })
})
