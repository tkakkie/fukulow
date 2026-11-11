import { expect, it, vi } from 'vitest'
import { createDraftStore } from './drafts'

it('keeps independent Account Session drafts by Organization, Channel, Topic and Reply root', () => {
  const drafts = createDraftStore()
  const targets = [
    { organizationId: 'o', channelId: 'c' },
    { organizationId: 'other', channelId: 'c' },
    { organizationId: 'o', channelId: 'other' },
    { organizationId: 'o', channelId: 'c', topicId: 't' },
    { organizationId: 'o', channelId: 'c', topicId: 't', replyRootId: 'r' },
  ]
  targets.forEach((target, index) => drafts.set(target, `draft ${index}`))
  targets.forEach((target, index) => expect(drafts.get(target)).toBe(`draft ${index}`))
  drafts.set(targets[0]!, '')
  expect(drafts.get(targets[1]!)).toBe('draft 1')
  expect(drafts.hasDrafts()).toBe(true)
  drafts.clear()
  expect(drafts.hasDrafts()).toBe(false)
  expect(createDraftStore().get(targets[1]!)).toBe('')
})

it('clearing drafts invalidates every old Account Session view without fencing Organization switches', () => {
  const drafts = createDraftStore()
  const a = drafts.scope(), b = drafts.scope()
  const target = { organizationId: 'o', channelId: 'c' }
  a.set(target, 'before switch')
  expect(b.get(target)).toBe('before switch')
  drafts.clear()
  a.set(target, 'late refusal')
  expect(drafts.hasDrafts()).toBe(false)
  const next = drafts.scope()
  next.set(target, 'new Account Session')
  b.set(target, '')
  expect(next.get(target)).toBe('new Account Session')
  expect(a.get(target)).toBe('')
  expect(a.hasDrafts()).toBe(false)
})

it('draft notifications observe committed writes and stop on unsubscribe or Account Session clear', () => {
  const drafts = createDraftStore()
  const old = drafts.scope()
  const target = { organizationId: 'o', channelId: 'c' }
  const observed = vi.fn(changed => {
    expect(changed).toEqual(target)
    expect(old.get(changed)).toBe('restored')
    expect(old.revision(changed)).toBe(1)
  })
  const unsubscribe = old.subscribe(observed)
  drafts.scope().set(target, 'restored')
  expect(observed).toHaveBeenCalledOnce()
  unsubscribe()
  drafts.set(target, '')
  expect(observed).toHaveBeenCalledOnce()

  const ended = vi.fn()
  old.subscribe(ended)
  drafts.clear()
  old.subscribe(ended)
  const current = vi.fn()
  drafts.scope().subscribe(current)
  drafts.scope().set(target, 'new Account Session')
  expect(ended).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledExactlyOnceWith(target)
})
