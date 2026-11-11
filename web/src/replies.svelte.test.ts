import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { countRepliesByMessageId, repliesAdapter } from './replies.svelte'
import { syncAdapter } from './sync.svelte'
import { ok, reply, replyClient, root } from './reply-test-helpers'
import { mount, settle } from './adapter-test-helpers.svelte'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('opens only anchors from the adapter Channel and preserves both chains on a mismatch', async () => {
  const c = replyClient(); await c.boot(); await c.sync.watch('B')
  const a = repliesAdapter(c.replies, 'A'), b = repliesAdapter(c.replies, 'B')
  await a.open(root())
  const bRoot = { ...root(), channel_id: 'B' }
  c.listReplyChain.mockResolvedValueOnce(ok({ root_id: bRoot.id, messages: [bRoot], has_more: false }))
  await b.open(bRoot)
  const beforeA = a.state, beforeB = b.state
  const requests = c.listReplyChain.mock.calls.length
  await a.open({ ...reply(2), channel_id: 'B' })
  expect(c.listReplyChain).toHaveBeenCalledTimes(requests)
  expect(a.state).toBe(beforeA)
  expect(b.state).toBe(beforeB)
  await c.sync.close()
})

it('memoizes chain adapter snapshots while observed and unobserved and forwards intents', async () => {
  const c = replyClient(); await c.boot()
  const adapter = repliesAdapter(c.replies, 'A')
  await adapter.open(root())
  const initial = adapter.state
  expect(adapter.state).toBe(initial)
  let active = 0
  const subscribe = c.replies.subscribe
  vi.spyOn(c.replies, 'subscribe').mockImplementation(fn => {
    active++; const release = subscribe(fn)
    return () => { active--; release() }
  })
  const one = await mount(() => adapter.state), two = await mount(() => adapter.state)
  expect(active).toBe(1)
  expect(one.last).toBe(initial)
  c.event(reply(2)); await settle()
  expect(one.last.messages.map(m => m.seq)).toEqual([1, 2, 3])
  expect(one.last).toBe(adapter.state)
  expect(one.last).not.toBe(initial)
  await adapter.send('hello')
  expect(c.sendMessage).toHaveBeenLastCalledWith('A', expect.objectContaining({ reply_to: 'id1' }))
  await adapter.loadMore(); await adapter.retry('missing')
  await one.unmount(); await two.unmount(); expect(active).toBe(0)
  const before = adapter.state
  c.event(reply(3)); expect(adapter.state).not.toBe(before)
  expect(adapter.state).toBe(adapter.state)
  const requests = c.listReplyChain.mock.calls.length
  const again = await mount(() => adapter.state)
  expect(c.listReplyChain).toHaveBeenCalledTimes(requests)
  adapter.dismiss(); await settle(); expect(again.last.messages).toEqual([])
  await again.unmount(); await c.sync.close()
  expect(adapter.state.messages).toEqual([])
})

it('composition close and replacement clear observed chains and fence adapter reads', async () => {
  const c = replyClient(); await c.boot()
  const adapter = repliesAdapter(c.replies, 'A')
  await adapter.open(root())
  const view = await mount(() => adapter.state)
  await c.sync.replaceSession('next'); await settle()
  expect(view.last.messages).toEqual([])
  await c.sync.watch('A'); await adapter.open(root()); await c.sync.close(); await settle()
  expect(view.last.messages).toEqual([])
  await adapter.open(root()); expect(adapter.state.messages).toEqual([])
  await view.unmount(); expect(vi.getTimerCount()).toBe(0)
})

it('countRepliesByMessageId deduplicates messages across sources and counts by reply_root_id and reply_to', () => {
  const m1 = root()
  const r2 = reply(2, 'id1')
  const r3 = reply(3, 'id2')
  const counts = countRepliesByMessageId([[m1, r2], [m1, r2, r3]])
  expect(counts.get('id1')).toBe(2)
  expect(counts.get('id2')).toBe(1)
})

it('channel.reply(replyRootId) manages per-chain drafts, hasUnsavedChanges, submit, detached refusal restore and restore()', async () => {
  const c = replyClient(); await c.boot()
  const syncModel = syncAdapter(c.sync)
  const channel = syncModel.channel('A')
  const rc = channel.reply('id1')

  expect(rc.composer).toEqual({ draft: '', composerError: null })
  expect(syncModel.hasUnsavedChanges()).toBe(false)

  rc.setDraft('返信下書き')
  expect(rc.composer.draft).toBe('返信下書き')
  expect(syncModel.hasUnsavedChanges()).toBe(true)

  // Over-limit draft refuses to submit and sets composerError
  rc.setDraft('あ'.repeat(4_001))
  expect(await rc.submit('id1')).toBe(false)
  expect(rc.composer.composerError).toBe('メッセージは4000文字以内にしてください。')

  // Valid submit clears draft and sends with reply_to
  rc.setDraft('最初の返信')
  const sendPromise = rc.submit('id1')
  expect(rc.composer.draft).toBe('')
  expect(await sendPromise).toBe(true)
  expect(c.sendMessage).toHaveBeenLastCalledWith('A', expect.objectContaining({ body: '最初の返信', reply_to: 'id1' }))

  // Failed non-retryable send can be restored into the Reply Composer via rc.restore()
  c.sendMessage.mockResolvedValueOnce({ ok: false, kind: 'http', status: 400, error: 'invalid_message' })
  rc.setDraft('失敗する返信')
  expect(await rc.submit('id1')).toBe(true)
  await settle()
  const failed = channel.timeline.pending.find((p) => p.replyTo === 'id1' && p.status === 'failed')
  expect(failed).toBeDefined()
  expect(rc.restore(failed!.clientMessageId)).toBe(true)
  expect(rc.composer.draft).toBe('失敗する返信')
  expect(channel.timeline.pending.some((p) => p.clientMessageId === failed!.clientMessageId)).toBe(false)

  // Draft survives C9 channel unavailability
  void c.sync.channelUnavailable('A')
  await settle()
  expect(rc.composer.draft).toBe('失敗する返信')
  await c.sync.close()
})

it('reply.migrateDraftFrom moves temporary (anchor, null) drafts into resolved (root, topic) with newline merge, idempotency and empty no-op', async () => {
  const c = replyClient(); await c.boot()
  const syncModel = syncAdapter(c.sync)
  const channel = syncModel.channel('A')

  const temp = channel.reply('desc-anchor', null)
  const resolved = channel.reply('root-1', 'topic-1')

  // 1. Empty temp draft is a no-op (and does not disturb an existing destination draft)
  resolved.setDraft('既存の下書き')
  resolved.migrateDraftFrom('desc-anchor', null)
  expect(resolved.composer.draft).toBe('既存の下書き')
  expect(temp.composer.draft).toBe('')

  // 2. Destination already has a draft: merges with a newline and clears the temporary draft
  temp.setDraft('解決中に入力した下書き')
  resolved.migrateDraftFrom('desc-anchor', null)
  expect(resolved.composer.draft).toBe('既存の下書き\n解決中に入力した下書き')
  expect(temp.composer.draft).toBe('')

  // 3. Repeated resolution does not duplicate
  resolved.migrateDraftFrom('desc-anchor', null)
  expect(resolved.composer.draft).toBe('既存の下書き\n解決中に入力した下書き')
  expect(temp.composer.draft).toBe('')

  // 4. Destination has no draft: moves temp draft directly, and self-migration is a no-op
  const freshResolved = channel.reply('root-2', null)
  const freshTemp = channel.reply('desc-anchor-2', null)
  freshTemp.setDraft('新規の返信下書き')
  freshResolved.migrateDraftFrom('desc-anchor-2', null)
  expect(freshResolved.composer.draft).toBe('新規の返信下書き')
  expect(freshTemp.composer.draft).toBe('')
  freshResolved.migrateDraftFrom('root-2', null)
  expect(freshResolved.composer.draft).toBe('新規の返信下書き')

  await c.sync.close()
})
