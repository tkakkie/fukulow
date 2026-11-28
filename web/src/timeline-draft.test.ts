import { describe, expect, it, vi } from 'vitest'
import { createTimelineDraftController } from './timeline-draft'
import { deferred } from './unread-test-helpers'

function makeComposer() {
  return {
    isConnected: true,
    disabled: false,
    focus: vi.fn(),
  }
}

describe('timeline-draft: createTimelineDraftController', () => {
  it('handleDiscard discards the failed message and moves focus to the Composer', () => {
    const composer = makeComposer()
    const discard = vi.fn()
    const ctrl = createTimelineDraftController({
      getDraft: () => '',
      setDraft: () => {},
      discard,
      restore: () => true,
      canRestore: () => true,
      getComposerRef: () => composer,
      getConfirmReplaceId: () => null,
      setConfirmReplaceId: () => {},
      afterUpdate: async () => {},
    })

    ctrl.handleDiscard('c-1')
    expect(discard).toHaveBeenCalledWith('c-1')
    expect(composer.focus).toHaveBeenCalledTimes(1)
  })

  it('handleRestoreRequest restores immediately when drafts are empty, and requests confirmation when body or topic draft is non-empty', () => {
    const composer = makeComposer()
    let draft = ''
    let topicDraft = ''
    let confirmId: string | null = null
    let restoreResult = true
    const restore = vi.fn(() => restoreResult)

    const ctrl = createTimelineDraftController({
      getDraft: () => draft,
      setDraft: (d) => {
        draft = d
      },
      getTopicDraft: () => topicDraft,
      setTopicDraft: (t) => {
        topicDraft = t
      },
      discard: () => {},
      restore,
      canRestore: () => true,
      getComposerRef: () => composer,
      getConfirmReplaceId: () => confirmId,
      setConfirmReplaceId: (id) => {
        confirmId = id
      },
      afterUpdate: async () => {},
    })

    // Empty drafts -> restore immediately and focus
    ctrl.handleRestoreRequest('c-1')
    expect(restore).toHaveBeenCalledWith('c-1')
    expect(composer.focus).toHaveBeenCalledTimes(1)
    expect(confirmId).toBeNull()

    // Empty drafts but restore returns false -> do not focus
    restoreResult = false
    ctrl.handleRestoreRequest('c-2')
    expect(restore).toHaveBeenCalledWith('c-2')
    expect(composer.focus).toHaveBeenCalledTimes(1)

    // Non-empty body draft -> prompt confirmation
    restoreResult = true
    draft = 'typing...'
    ctrl.handleRestoreRequest('c-3')
    expect(confirmId).toBe('c-3')
    expect(restore).toHaveBeenCalledTimes(2)

    // Non-empty topic draft alone -> prompt confirmation
    draft = ''
    topicDraft = 'new topic'
    confirmId = null
    ctrl.handleRestoreRequest('c-4')
    expect(confirmId).toBe('c-4')
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('handleConfirmReplace replaces draft and topicDraft, focuses Composer after update only if dialog stays closed, and rolls back on failure', async () => {
    const composer = makeComposer()
    let draft = 'existing body'
    let topicDraft = 'existing topic'
    let confirmId: string | null = 'c-1'
    let canRestore = true
    let restoreResult = true
    const tickGate = deferred<void>()
    const setDraft = vi.fn((d: string) => {
      draft = d
    })
    const setTopicDraft = vi.fn((t: string) => {
      topicDraft = t
    })
    const restore = vi.fn(() => restoreResult)

    const ctrl = createTimelineDraftController({
      getDraft: () => draft,
      setDraft,
      getTopicDraft: () => topicDraft,
      setTopicDraft,
      discard: () => {},
      restore,
      canRestore: () => canRestore,
      getComposerRef: () => composer,
      getConfirmReplaceId: () => confirmId,
      setConfirmReplaceId: (id) => {
        confirmId = id
      },
      afterUpdate: () => tickGate.promise,
    })

    // Successful replace waits for afterUpdate before focusing Composer
    ctrl.handleConfirmReplace()
    expect(confirmId).toBeNull()
    expect(setDraft).toHaveBeenCalledWith('')
    expect(setTopicDraft).toHaveBeenCalledWith('')
    expect(restore).toHaveBeenCalledWith('c-1')
    expect(composer.focus).not.toHaveBeenCalled()

    tickGate.resolve()
    await Promise.resolve()
    expect(composer.focus).toHaveBeenCalledTimes(1)

    // If another confirmation opens before afterUpdate resolves, focus must not jump to Composer
    const tickGate2 = deferred<void>()
    const ctrl2 = createTimelineDraftController({
      getDraft: () => 'draft',
      setDraft: () => {},
      discard: () => {},
      restore: () => true,
      canRestore: () => true,
      getComposerRef: () => composer,
      getConfirmReplaceId: () => confirmId,
      setConfirmReplaceId: (id) => {
        confirmId = id
      },
      afterUpdate: () => tickGate2.promise,
    })
    confirmId = 'c-2'
    ctrl2.handleConfirmReplace()
    expect(confirmId).toBeNull()
    confirmId = 'c-3'
    tickGate2.resolve()
    await Promise.resolve()
    expect(composer.focus).toHaveBeenCalledTimes(1)

    // When canRestore is false, drafts stay untouched
    draft = 'keep body'
    topicDraft = 'keep topic'
    confirmId = 'c-4'
    canRestore = false
    setDraft.mockClear()
    setTopicDraft.mockClear()
    ctrl.handleConfirmReplace()
    expect(confirmId).toBeNull()
    expect(setDraft).not.toHaveBeenCalled()
    expect(setTopicDraft).not.toHaveBeenCalled()

    // When restore returns false, previous draft and topicDraft are restored
    canRestore = true
    restoreResult = false
    confirmId = 'c-5'
    ctrl.handleConfirmReplace()
    expect(draft).toBe('keep body')
    expect(topicDraft).toBe('keep topic')
  })

  it('handleCancelReplace clears confirmReplaceId without touching drafts or restoring', () => {
    let confirmId: string | null = 'c-1'
    const setDraft = vi.fn()
    const restore = vi.fn(() => true)
    const ctrl = createTimelineDraftController({
      getDraft: () => 'keep',
      setDraft,
      discard: () => {},
      restore,
      canRestore: () => true,
      getComposerRef: () => makeComposer(),
      getConfirmReplaceId: () => confirmId,
      setConfirmReplaceId: (id) => {
        confirmId = id
      },
      afterUpdate: async () => {},
    })

    ctrl.handleCancelReplace()
    expect(confirmId).toBeNull()
    expect(setDraft).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })
})
