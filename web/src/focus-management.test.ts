import { describe, expect, it, vi } from 'vitest'
import {
  confirmReplaceDraftWithFailedSend,
  decideEditAndResend,
  discardAndFocusComposer,
  focusAfterPanelClose,
  focusDialogOnOpen,
  resolveSkipLinkTargetId,
  restoreFocusAfterDialogClose,
  stepDialogTab,
} from './focus-management'

describe('focus-management: focus after discard, edit-and-resend, dialog and panel close (docs/ui.md §2, §5, §6)', () => {
  it('moves focus to the Composer immediately after discarding a failed Message', () => {
    const discard = vi.fn()
    const composer = { focus: vi.fn(), isConnected: true }

    discardAndFocusComposer('c-1', discard, composer)

    expect(discard).toHaveBeenCalledExactlyOnceWith('c-1')
    expect(composer.focus).toHaveBeenCalledOnce()
  })

  it('restores immediately when the Composer draft is empty, asks confirmation when a draft exists, and never loses the draft if restore cannot succeed', () => {
    expect(decideEditAndResend('c-1', '')).toEqual({ action: 'restore_now' })
    expect(decideEditAndResend('c-1', '入力途中の下書き')).toEqual({
      action: 'confirm_replace',
      clientMessageId: 'c-1',
    })

    // 1. Success path: clears draft, restores failed send, focuses Composer
    const setDraft = vi.fn()
    const restore = vi.fn(() => true)
    const composer = { focus: vi.fn(), isConnected: true }

    expect(confirmReplaceDraftWithFailedSend('c-1', '入力途中の下書き', true, setDraft, restore, composer)).toBe(true)
    expect(setDraft).toHaveBeenCalledExactlyOnceWith('')
    expect(restore).toHaveBeenCalledExactlyOnceWith('c-1')
    expect(composer.focus).toHaveBeenCalledOnce()

    // 2. Pending send no longer restorable (canRestore = false): never clears draft
    const setDraftBlocked = vi.fn()
    const restoreBlocked = vi.fn(() => false)
    const composerBlocked = { focus: vi.fn(), isConnected: true }
    expect(
      confirmReplaceDraftWithFailedSend('c-1', '大事な下書き', false, setDraftBlocked, restoreBlocked, composerBlocked),
    ).toBe(false)
    expect(setDraftBlocked).not.toHaveBeenCalled()
    expect(restoreBlocked).not.toHaveBeenCalled()
    expect(composerBlocked.focus).not.toHaveBeenCalled()

    // 3. Controller rejects restore at call time: restores original draft so nothing is lost
    const drafts: string[] = ['大事な下書き']
    const setDraftRollback = vi.fn((d: string) => {
      drafts.push(d)
    })
    const restoreFailed = vi.fn(() => false)
    expect(
      confirmReplaceDraftWithFailedSend(
        'c-1',
        '大事な下書き',
        true,
        setDraftRollback,
        restoreFailed,
        composerBlocked,
      ),
    ).toBe(false)
    expect(drafts.at(-1)).toBe('大事な下書き')
    expect(composerBlocked.focus).not.toHaveBeenCalled()
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

  it('moves focus into a modal dialog on open, traps Tab/Shift+Tab, and restores focus to the opener on close', () => {
    const cancelBtn = { focus: vi.fn(), isConnected: true }
    const confirmBtn = { focus: vi.fn(), isConnected: true }
    const dialogEl = { focus: vi.fn(), isConnected: true }
    const opener = { focus: vi.fn(), isConnected: true }

    // Open focuses first connected control
    expect(focusDialogOnOpen([cancelBtn, confirmBtn], dialogEl)).toBe(cancelBtn)
    expect(cancelBtn.focus).toHaveBeenCalledOnce()

    // Tab moves from cancelBtn -> confirmBtn -> wraps back to cancelBtn
    expect(stepDialogTab([cancelBtn, confirmBtn], cancelBtn, false, dialogEl)).toBe(confirmBtn)
    expect(confirmBtn.focus).toHaveBeenCalledOnce()
    expect(stepDialogTab([cancelBtn, confirmBtn], confirmBtn, false, dialogEl)).toBe(cancelBtn)
    expect(cancelBtn.focus).toHaveBeenCalledTimes(2)

    // Shift+Tab wraps from cancelBtn -> confirmBtn -> cancelBtn
    expect(stepDialogTab([cancelBtn, confirmBtn], cancelBtn, true, dialogEl)).toBe(confirmBtn)
    expect(confirmBtn.focus).toHaveBeenCalledTimes(2)
    expect(stepDialogTab([cancelBtn, confirmBtn], confirmBtn, true, dialogEl)).toBe(cancelBtn)

    // Close restores focus to opener, or fallback when opener is disconnected
    expect(restoreFocusAfterDialogClose(opener, dialogEl)).toBe(true)
    expect(opener.focus).toHaveBeenCalledOnce()

    const goneOpener = { focus: vi.fn(), isConnected: false }
    const fallbackComposer = { focus: vi.fn(), isConnected: true }
    expect(restoreFocusAfterDialogClose(goneOpener, fallbackComposer)).toBe(true)
    expect(goneOpener.focus).not.toHaveBeenCalled()
    expect(fallbackComposer.focus).toHaveBeenCalledOnce()
  })

  it('resolves the skip link target ID to the visible primary region at every phone level and desktop/tablet breakpoint', () => {
    // Phone (< 600px): targets the active screen's region at each level
    expect(resolveSkipLinkTargetId({ viewportWidth: 375, mobileLevel: 'channels', panelOpen: false })).toBe(
      'channel-content',
    )
    expect(resolveSkipLinkTargetId({ viewportWidth: 599, mobileLevel: 'channels', panelOpen: true })).toBe(
      'channel-content',
    )
    expect(resolveSkipLinkTargetId({ viewportWidth: 375, mobileLevel: 'view', panelOpen: false })).toBe('main-content')
    expect(resolveSkipLinkTargetId({ viewportWidth: 375, mobileLevel: 'panel', panelOpen: true })).toBe('panel-content')
    expect(resolveSkipLinkTargetId({ viewportWidth: 375, mobileLevel: 'panel', panelOpen: false })).toBe(
      'main-content',
    )

    // Tablet and desktop (>= 600px): main-content stays visible across all mobileLevel and panelOpen states
    for (const viewportWidth of [600, 768, 960, 1280, 1400]) {
      for (const mobileLevel of ['channels', 'view', 'panel'] as const) {
        for (const panelOpen of [false, true]) {
          expect(resolveSkipLinkTargetId({ viewportWidth, mobileLevel, panelOpen })).toBe('main-content')
        }
      }
    }
  })
})
