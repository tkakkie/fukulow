import { expect, it, vi } from 'vitest'
import { createNavigationTargets } from './navigation-targets'
import type { NavigationTarget } from './navigation-url'
import type { Result, TopicSummaryResponse } from './api'

const target: NavigationTarget = { organizationId: 'org', channelId: 'channel', topicId: 'topic', panel: 'reply:message' }
const failure = (error: string, status = 404): Result<never> => ({ ok: false, kind: 'http', status, error })

it('resource-not-found denies only that URL hint; Channel denial is C9 and Organization denial remains C10', async () => {
  for (const [error, status, calls] of [['topic_not_found', 404, 0], ['reply_chain_not_found', 404, 0], ['organization_unavailable', 404, 0], ['channel not found', 404, 2], ['forbidden', 403, 2]] as const) {
    const channelUnavailable = vi.fn()
    const resolver = createNavigationTargets({ topic: async () => failure(error, status), reply: async () => failure(error, status), channelUnavailable })
    await resolver.load(target)
    expect(resolver.get().topic.status).toBe('unavailable')
    expect(resolver.get().reply.status).toBe('unavailable')
    expect(channelUnavailable).toHaveBeenCalledTimes(calls)
    resolver.close()
  }
})

it('does not retry failed hints until explicit retry; fences stale data and Channel denials on navigation or close', async () => {
  let complete: (result: Result<TopicSummaryResponse>) => void = () => {}
  const topic = vi.fn(() => new Promise<Result<TopicSummaryResponse>>(resolve => { complete = resolve }))
  const channelUnavailable = vi.fn()
  const resolver = createNavigationTargets({ topic, reply: async () => failure('reply_chain_not_found'), channelUnavailable })
  const loading = resolver.load(target)
  await resolver.load(target)
  expect(topic).toHaveBeenCalledTimes(1)
  await resolver.load({ ...target, topicId: null, panel: null })
  complete(failure('channel not found'))
  await loading
  expect(channelUnavailable).not.toHaveBeenCalled()
  expect(resolver.get().topic.status).toBe('idle')
  const next = resolver.load(target)
  resolver.close()
  complete(failure('channel not found'))
  await next
  expect(channelUnavailable).not.toHaveBeenCalled()
})

it('resolves the API Topic name and exposes a retryable network failure without automatic retry', async () => {
  const topic = vi.fn(async (): Promise<Result<TopicSummaryResponse>> => ({ ok: false, kind: 'network' }))
  const resolver = createNavigationTargets({ topic, reply: async () => failure('reply_chain_not_found'), channelUnavailable: vi.fn() })
  await resolver.load(target)
  await resolver.load(target)
  expect(topic).toHaveBeenCalledTimes(1)
  expect(resolver.get().topic.status).toBe('error')
  topic.mockResolvedValue({ ok: true, data: { as_of_seq: 1, topic: { name: '日報' } } as TopicSummaryResponse })
  await resolver.load(target, true)
  expect(resolver.get().topic).toEqual({ status: 'ready', name: '日報' })
  resolver.close()
})

it('turns a stalled URL hint into a retryable error after ten seconds and fences its late result', async () => {
  vi.useFakeTimers()
  try {
    let finish: (result: Result<TopicSummaryResponse>) => void = () => {}
    const resolver = createNavigationTargets({ topic: () => new Promise(resolve => { finish = resolve }), reply: async () => failure('reply_chain_not_found'), channelUnavailable: vi.fn() })
    const loading = resolver.load({ ...target, panel: null })
    expect(resolver.get().topic.status).toBe('loading')
    await vi.advanceTimersByTimeAsync(10_000)
    await loading
    expect(resolver.get().topic.status).toBe('error')
    finish({ ok: true, data: { as_of_seq: 1, topic: { name: '遅い応答' } } as TopicSummaryResponse })
    await Promise.resolve()
    expect(resolver.get().topic.status).toBe('error')
    resolver.close()
  } finally { vi.useRealTimers() }
})

it('close settles every stalled Topic and Reply load without publishing or Channel denial', async () => {
  vi.useFakeTimers()
  try {
    const finish: ((result: Result<never>) => void)[] = []
    const stalled = () => new Promise<Result<never>>(resolve => { finish.push(resolve) })
    const channelUnavailable = vi.fn()
    const resolver = createNavigationTargets({ topic: stalled, reply: stalled, channelUnavailable })
    const publish = vi.fn()
    resolver.subscribe(publish)
    const first = resolver.load(target)
    const second = resolver.load({ ...target, topicId: 'other', panel: 'reply:other' })
    expect(finish).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(4)
    const snapshot = resolver.get()
    publish.mockClear()
    resolver.close()
    // No timers or fetch completions are needed to release either caller.
    expect(vi.getTimerCount()).toBe(0)
    let settled = false
    void Promise.all([first, second]).then(() => { settled = true })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(settled).toBe(true)
    finish.forEach(resolve => resolve(failure('channel not found')))
    await Promise.all([first, second])
    expect(resolver.get()).toBe(snapshot)
    expect(publish).not.toHaveBeenCalled()
    expect(channelUnavailable).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
