import { describe, expect, it, vi } from 'vitest'
import {
  confirmReplaceDraftWithFailedSend,
  decideEditAndResend,
  discardAndFocusComposer,
  focusAfterPanelClose,
} from './focus-management'

describe('focus-management: focus after discard, edit-and-resend and panel close (docs/ui.md §2, §5, §6)', () => {
  it('moves focus to the Composer immediately after discarding a failed Message', () => {
    const discard = vi.fn()
    const composer = { focus: vi.fn(), isConnected: true }

    discardAndFocusComposer('c-1', discard, composer)

    expect(discard).toHaveBeenCalledExactlyOnceWith('c-1')
    expect(composer.focus).toHaveBeenCalledOnce()
  })

  it('restores immediately when the Composer draft is empty, and asks confirmation when a draft exists', () => {
    expect(decideEditAndResend('c-1', '')).toEqual({ action: 'restore_now' })
    expect(decideEditAndResend('c-1', '入力途中の下書き')).toEqual({
      action: 'confirm_replace',
      clientMessageId: 'c-1',
    })

    const setDraft = vi.fn()
    const restore = vi.fn(() => true)
    const composer = { focus: vi.fn(), isConnected: true }

    expect(confirmReplaceDraftWithFailedSend('c-1', setDraft, restore, composer)).toBe(true)
    expect(setDraft).toHaveBeenCalledExactlyOnceWith('')
    expect(restore).toHaveBeenCalledExactlyOnceWith('c-1')
    expect(composer.focus).toHaveBeenCalledOnce()
  })

  it('returns focus to the panel invoker on close, or falls back to the main Composer if the invoker is gone', () => {
    const invoker = { focus: vi.fn(), isConnected: true }
    const composer = { focus: vi.fn(), isConnected: true }

    focusAfterPanelClose(invoker, composer)
    expect(invoker.focus).toHaveBeenCalledOnce()
    expect(composer.focus).not.toHaveBeenCalled()

    const disconnectedInvoker = { focus: vi.fn(), isConnected: false }
    focusAfterPanelClose(disconnectedInvoker, composer)
    expect(disconnectedInvoker.focus).not.toHaveBeenCalled()
    expect(composer.focus).toHaveBeenCalledOnce()
  })
})
