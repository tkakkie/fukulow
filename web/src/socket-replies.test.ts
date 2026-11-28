import { expect, it, vi } from 'vitest'
import { createCore } from './core-wasm'
import type { ServerEvent } from './api'
import type { ChannelState } from './protocol-types'
import type { RealtimeHandlers } from './realtime'
import { createSync } from './sync'
import { controllerClient } from './sync-test-helpers'

const generation = '00000000-0000-4000-8000-000000000515'
const events = {
  subscribed: { type: 'subscribed', channel_id: 'A', history_generation: generation, caught_up_seq: 0 },
  loss: { type: 'channel_access_lost', channel_id: 'A' },
  notFound: { type: 'error', channel_id: 'A', code: 'channel_not_found' },
  limit: { type: 'error', channel_id: 'A', code: 'subscription_limit' },
  unscoped: { type: 'error', code: 'channel_not_found' },
  other: { type: 'error', channel_id: 'A', code: 'invalid_message' },
  notice: { type: 'activity_ready' },
} satisfies Record<string, ServerEvent>

// The previous controller decision, kept here as an independent reference for the Wasm path.
function previousAttribution() {
  const subscriptions = new Map<string, number[]>()
  const confirmed = new Map<string, number>()
  return {
    issue(channel: string, id: number) {
      const pending = subscriptions.get(channel) ?? []
      pending.push(id)
      subscriptions.set(channel, pending)
    },
    route(event: ServerEvent, view: ChannelState | undefined) {
      if (event.type !== 'message' && event.type !== 'subscribed' && event.type !== 'channel_access_lost' && event.type !== 'error') {
        return { type: 'activity' }
      }
      const isReply = event.type === 'subscribed' || event.type === 'channel_access_lost' ||
        (event.type === 'error' && (event.code === 'channel_not_found' || event.code === 'subscription_limit'))
      let subscription: number | undefined
      if (isReply && event.channel_id) {
        const channel = event.channel_id
        const pending = subscriptions.get(channel)
        if (event.type === 'channel_access_lost' || (event.type === 'error' && event.code === 'channel_not_found')) {
          if (view?.watched && ((confirmed.has(channel) && pending?.length) ||
            (event.type === 'channel_access_lost' &&
              (pending?.length || !confirmed.has(channel) || confirmed.get(channel) !== view.subscription?.id) &&
              view.state !== 'unavailable'))) return { type: 'close_connection' }
          subscription = pending?.shift() ?? confirmed.get(channel) ?? -1
          confirmed.delete(channel)
        } else {
          subscription = pending?.shift() ?? -1
          if (event.type === 'subscribed' && subscription !== -1) confirmed.set(channel, subscription)
        }
      }
      return { type: 'sync', subscription }
    },
  }
}

type Action = 'watch' | 'unwatch' | 'issue' | keyof typeof events
const sequences: [string, Action[]][] = [
  ['FIFO handoffs', ['watch', 'issue', 'unwatch', 'watch', 'issue', 'subscribed', 'subscribed', 'loss']],
  ['FIFO refusals', ['watch', 'issue', 'unwatch', 'watch', 'issue', 'limit', 'subscribed', 'notFound']],
  ['unwatched loss', ['watch', 'issue', 'subscribed', 'unwatch', 'watch', 'issue', 'unwatch', 'loss', 'subscribed']],
  ['confirmed loss', ['watch', 'issue', 'subscribed', 'limit', 'loss', 'loss']],
  ['loss before a handoff', ['watch', 'issue', 'loss']],
  ['mismatched loss before reissue', ['watch', 'issue', 'subscribed', 'unwatch', 'watch', 'loss']],
  ['ambiguous not found', ['watch', 'issue', 'subscribed', 'unwatch', 'watch', 'issue', 'notFound']],
  ['new handoff resolves ambiguity', ['watch', 'issue', 'subscribed', 'unwatch', 'watch', 'issue', 'subscribed', 'notFound']],
  ['non-reply errors leave the queue intact', ['watch', 'issue', 'unscoped', 'other', 'notFound']],
  ['activity and an unsolicited subscription reply', ['notice', 'subscribed', 'watch', 'issue', 'subscribed']],
]

it.each(sequences)('matches the previous controller decision for %s', (_name, actions) => {
  const core = createCore('me')
  const previous = previousAttribution()
  core.step({ type: 'session_start', selfId: 'me' })
  const connection = core.get().connection!
  core.step({ type: 'connection_ready', connection })
  for (const action of actions) {
    switch (action) {
      case 'watch': {
        core.step({ type: 'watch', channel: 'A' })
        const view = core.get().channels.A
        if (view.cursor === null) core.step({
          type: 'history_result', request: view.latest!,
          page: { history_generation: generation, as_of_seq: 0, messages: [], has_more: false },
        })
        break
      }
      case 'unwatch':
        core.step({ type: 'unwatch', channel: 'A' })
        break
      case 'issue': {
        const id = core.get().channels.A.subscription!.id
        previous.issue('A', id)
        core.subscribeIssued(connection, 'A', id)
        break
      }
      default: {
        const event = events[action]
        const expected = previous.route(event, core.get().channels.A)
        const result = core.step({ type: 'socket_frame', connection, event })
        if (expected.type === 'close_connection') {
          expect(result.effects).toContainEqual({ type: expected.type, connection })
          expect(result.socketDelivery).toBeUndefined()
        } else {
          expect(result.effects.some(e => e.type === 'close_connection')).toBe(false)
          expect(result.socketDelivery).toEqual(expected)
        }
      }
    }
  }
})

it('closes only the socket whose ambiguous reply requested a reconnect', async () => {
  vi.useFakeTimers()
  const client = controllerClient()
  try {
    await client.sync.start()
    await client.feed({ type: 'connection_ready' })
    const history = (await client.feed({ type: 'watch', channel: 'A' })).find(e => e.type === 'fetch_history')!
    await client.feed({ type: 'history_result', respond_to: history, messages: [], has_more: false })
    const original = client.sockets[0]
    const stop = client.sync.onInput(input => {
      if (input.type === 'socket_closed') void client.sync.replaceSession('new-member')
    })
    original.onEvent(events.loss)
    stop()
    expect(original.closed).toBe(true)
    expect(client.sockets).toHaveLength(2)
    expect(client.sockets[1].closed).toBe(false)
  } finally {
    await client.sync.close()
    vi.useRealTimers()
  }
})

it('records a subscribe before its transport can reply', async () => {
  let handlers: RealtimeHandlers
  const sync = createSync({
    selfId: 'me',
    connect(socket) {
      handlers = socket
      return {
        send(control) {
          if (control.type === 'subscribe') handlers.onEvent(events.subscribed)
        },
        close() {},
      }
    },
    api: {
      listMessages: async () => ({ ok: true, data: {
        history_generation: generation, as_of_seq: 0, messages: [], has_more: false,
      } }),
      listChannelEvents: async () => ({ ok: false, kind: 'network' }),
      sendMessage: async () => ({ ok: false, kind: 'network' }),
    },
  })
  try {
    await sync.start()
    handlers!.onReady()
    await sync.watch('A')
    expect(sync.get().channels.A.subscription?.confirmed).toBe(true)
  } finally {
    await sync.close()
  }
})
