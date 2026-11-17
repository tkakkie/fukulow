import { expect, it } from 'vitest'
import { createSync } from './sync'
import { flush } from './sync-test-helpers'

it('notifies each input before its ordered effects and preserves repeated-stop global notifications', async () => {
  const log: string[] = []
  const sync = createSync({ selfId: 'me', connect: () => {
    log.push('connect')
    return { send: () => {}, close: () => { log.push('close') } }
  }, api: { listChannelEvents: async () => ({ ok: false, kind: 'network' }),
    listMessages: async () => { log.push('history'); return { ok: true, data: { messages: [], has_more: false } } },
    sendMessage: async () => ({ ok: false, kind: 'network' }),
  } })
  const a = sync.getTimeline('A'), b = sync.getTimeline('B')
  sync.subscribe(changed => log.push('global:' + [...changed].join(',')))
  a.subscribe(() => log.push('A'))
  b.subscribe(() => log.push('B'))
  a.composer.subscribe(() => log.push('composer'))
  a.setDraft('before start'); log.length = 0
  await sync.start()
  expect(log).toEqual(['global:', 'composer', 'connect'])
  log.length = 0
  const watched = sync.watch('A')
  expect(log).toEqual(['global:A', 'A', 'history'])
  await watched
  expect(log).toEqual(['global:A', 'A', 'history', 'global:A', 'A'])
  const before = sync.get().channels.A
  const snapshot = a.get()
  log.length = 0
  await sync.watch('A')
  expect(log).toEqual([])
  expect(sync.get().channels.A).toBe(before)
  expect(a.get()).toBe(snapshot)
  log.length = 0
  a.setDraft('clear on stop'); log.length = 0
  await sync.close()
  expect(log).toEqual(['global:A', 'A', 'composer', 'close'])
  log.length = 0
  await sync.close(); await flush()
  expect(log).toEqual(['global:'])
})
