import { expect, it } from 'vitest'
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
