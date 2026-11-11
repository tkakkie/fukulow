import { describe, expect, it, vi } from 'vitest'
import {
  confirmReplaceDraftWithFailedSend,
  createTopicSummaryFocusController,
  decideEditAndResend,
  discardAndFocusComposer,
  focusAfterPanelClose,
  focusDialogOnOpen,
  focusIfVisible,
  isTargetVisible,
  resolveChannelListNavigation,
  resolveMainTimelineFocusStatus,
  resolveSkipLinkTargetId,
  restoreFocusAfterDialogClose,
  stepDialogTab,
  submitAndFocusComposer,
  type FocusDocument,
  type VisibleFocusableTarget,
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

  it('focusDialogOnOpen skips a disabled first control and falls back to the dialog when all controls are disabled', () => {
    const disabledFirst = { focus: vi.fn(), isConnected: true, disabled: true }
    const firstEnabled = { focus: vi.fn(), isConnected: true }
    const secondEnabled = { focus: vi.fn(), isConnected: true }
    const dialogEl = { focus: vi.fn(), isConnected: true }

    expect(focusDialogOnOpen([disabledFirst, firstEnabled, secondEnabled], dialogEl)).toBe(firstEnabled)
    expect(disabledFirst.focus).not.toHaveBeenCalled()
    expect(firstEnabled.focus).toHaveBeenCalledOnce()
    expect(secondEnabled.focus).not.toHaveBeenCalled()
    expect(dialogEl.focus).not.toHaveBeenCalled()

    const disabledSecond = { focus: vi.fn(), isConnected: true, disabled: true }
    expect(focusDialogOnOpen([disabledFirst, disabledSecond], dialogEl)).toBe(dialogEl)
    expect(disabledFirst.focus).not.toHaveBeenCalled()
    expect(disabledSecond.focus).not.toHaveBeenCalled()
    expect(dialogEl.focus).toHaveBeenCalledOnce()
  })

  it('stepDialogTab skips disabled controls, including when the active element is disabled', () => {
    const disabledFirst = { focus: vi.fn(), isConnected: true, disabled: true }
    const firstBtn = { focus: vi.fn(), isConnected: true }
    const disabledMiddle = { focus: vi.fn(), isConnected: true, disabled: true }
    const secondBtn = { focus: vi.fn(), isConnected: true }
    const thirdBtn = { focus: vi.fn(), isConnected: true }
    const disabledLast = { focus: vi.fn(), isConnected: true, disabled: true }
    const dialogEl = { focus: vi.fn(), isConnected: true }
    const controls = [disabledFirst, firstBtn, disabledMiddle, secondBtn, thirdBtn, disabledLast]

    // Forward Tab skips disabledMiddle and wraps past disabledLast/disabledFirst
    expect(stepDialogTab(controls, firstBtn, false, dialogEl)).toBe(secondBtn)
    expect(secondBtn.focus).toHaveBeenCalledOnce()
    expect(stepDialogTab(controls, thirdBtn, false, dialogEl)).toBe(firstBtn)
    expect(firstBtn.focus).toHaveBeenCalledOnce()

    // Shift+Tab skips disabledMiddle and wraps past disabledFirst/disabledLast
    expect(stepDialogTab(controls, secondBtn, true, dialogEl)).toBe(firstBtn)
    expect(firstBtn.focus).toHaveBeenCalledTimes(2)
    expect(stepDialogTab(controls, firstBtn, true, dialogEl)).toBe(thirdBtn)
    expect(thirdBtn.focus).toHaveBeenCalledOnce()

    // Active element itself is disabled inside focusables: steps forward/backward to the nearest enabled control
    expect(stepDialogTab(controls, disabledMiddle, false, dialogEl)).toBe(secondBtn)
    expect(secondBtn.focus).toHaveBeenCalledTimes(2)
    expect(stepDialogTab(controls, disabledMiddle, true, dialogEl)).toBe(firstBtn)
    expect(firstBtn.focus).toHaveBeenCalledTimes(3)
    expect(stepDialogTab(controls, disabledFirst, false, dialogEl)).toBe(firstBtn)
    expect(stepDialogTab(controls, disabledFirst, true, dialogEl)).toBe(thirdBtn)

    // Active element is disabled and already excluded from focusables (e.g. :not(:disabled) selector)
    const excludedDisabledActive = { focus: vi.fn(), isConnected: true, disabled: true }
    expect(stepDialogTab([firstBtn, secondBtn, thirdBtn], excludedDisabledActive, false, dialogEl)).toBe(firstBtn)
    expect(stepDialogTab([firstBtn, secondBtn, thirdBtn], excludedDisabledActive, true, dialogEl)).toBe(thirdBtn)
    expect(excludedDisabledActive.focus).not.toHaveBeenCalled()

    // All controls disabled (including active): falls back to dialog container
    expect(stepDialogTab([disabledFirst, disabledMiddle], disabledFirst, false, dialogEl)).toBe(dialogEl)
    expect(dialogEl.focus).toHaveBeenCalledOnce()
    expect(disabledFirst.focus).not.toHaveBeenCalled()
    expect(disabledMiddle.focus).not.toHaveBeenCalled()
    expect(disabledLast.focus).not.toHaveBeenCalled()
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

  it('opens the Channel drawer only at tablet widths and focuses the Channel list on チャンネル一覧へ', () => {
    // Phone (< 600px): switches to 'channels' screen without opening tablet drawer
    for (const width of [320, 375, 599]) {
      expect(resolveChannelListNavigation(width)).toEqual({ drawerOpen: false, mobileLevel: 'channels' })
    }
    // Tablet (600-959px): opens the Channel drawer
    for (const width of [600, 768, 959]) {
      expect(resolveChannelListNavigation(width)).toEqual({ drawerOpen: true, mobileLevel: 'channels' })
    }
    // Desktop (>= 960px): Channel column is permanently visible, drawer stays closed
    for (const width of [960, 1280, 1440]) {
      expect(resolveChannelListNavigation(width)).toEqual({ drawerOpen: false, mobileLevel: 'channels' })
    }

    const visibleHeading = {
      focus: vi.fn(),
      isConnected: true,
      getClientRects: () => [{ width: 260, height: 20 }],
    }
    expect(focusIfVisible(visibleHeading, () => ({ display: 'block', visibility: 'visible' }))).toBe(true)
    expect(visibleHeading.focus).toHaveBeenCalledOnce()
  })

  it('focusIfVisible guards against hidden headings and focuses only when rendered and visible', () => {
    const visibleRects = () => [{ width: 260, height: 20 }]
    const visibleStyle = () => ({ display: 'block', visibility: 'visible' })

    // Null / undefined / disconnected / disabled / [hidden]
    expect(focusIfVisible(null, visibleStyle)).toBe(false)
    expect(focusIfVisible(undefined, visibleStyle)).toBe(false)

    const disconnected: VisibleFocusableTarget = { focus: vi.fn(), isConnected: false, getClientRects: visibleRects }
    expect(focusIfVisible(disconnected, visibleStyle)).toBe(false)
    expect(disconnected.focus).not.toHaveBeenCalled()

    const disabled: VisibleFocusableTarget = {
      focus: vi.fn(),
      isConnected: true,
      disabled: true,
      getClientRects: visibleRects,
    }
    expect(focusIfVisible(disabled, visibleStyle)).toBe(false)
    expect(disabled.focus).not.toHaveBeenCalled()

    const hiddenAttr: VisibleFocusableTarget = {
      focus: vi.fn(),
      isConnected: true,
      hidden: true,
      getClientRects: visibleRects,
    }
    expect(focusIfVisible(hiddenAttr, visibleStyle)).toBe(false)
    expect(hiddenAttr.focus).not.toHaveBeenCalled()

    const hiddenAncestor: VisibleFocusableTarget = {
      focus: vi.fn(),
      isConnected: true,
      closest: (sel) => (sel.includes('[inert]') ? {} : null),
      getClientRects: visibleRects,
    }
    expect(focusIfVisible(hiddenAncestor, visibleStyle)).toBe(false)
    expect(hiddenAncestor.focus).not.toHaveBeenCalled()

    // Computed display: none, visibility: hidden, visibility: collapse
    const displayNone: VisibleFocusableTarget = { focus: vi.fn(), isConnected: true, getClientRects: visibleRects }
    expect(focusIfVisible(displayNone, () => ({ display: 'none', visibility: 'visible' }))).toBe(false)
    expect(displayNone.focus).not.toHaveBeenCalled()

    const visibilityHidden: VisibleFocusableTarget = {
      focus: vi.fn(),
      isConnected: true,
      getClientRects: visibleRects,
    }
    expect(focusIfVisible(visibilityHidden, () => ({ display: 'block', visibility: 'hidden' }))).toBe(false)
    expect(visibilityHidden.focus).not.toHaveBeenCalled()

    const visibilityCollapse: VisibleFocusableTarget = {
      focus: vi.fn(),
      isConnected: true,
      getClientRects: visibleRects,
    }
    expect(focusIfVisible(visibilityCollapse, () => ({ display: 'block', visibility: 'collapse' }))).toBe(false)
    expect(visibilityCollapse.focus).not.toHaveBeenCalled()

    // Ancestor display: none (empty getClientRects) or zero-size box
    const closedDrawerHeading: VisibleFocusableTarget = {
      focus: vi.fn(),
      isConnected: true,
      getClientRects: () => [],
    }
    expect(isTargetVisible(closedDrawerHeading, visibleStyle)).toBe(false)
    expect(focusIfVisible(closedDrawerHeading, visibleStyle)).toBe(false)
    expect(closedDrawerHeading.focus).not.toHaveBeenCalled()

    const zeroWidth: VisibleFocusableTarget = {
      focus: vi.fn(),
      isConnected: true,
      getClientRects: () => [{ width: 0, height: 20 }],
    }
    expect(focusIfVisible(zeroWidth, visibleStyle)).toBe(false)
    expect(zeroWidth.focus).not.toHaveBeenCalled()

    const zeroHeight: VisibleFocusableTarget = {
      focus: vi.fn(),
      isConnected: true,
      getClientRects: () => [{ width: 260, height: 0 }],
    }
    expect(focusIfVisible(zeroHeight, visibleStyle)).toBe(false)
    expect(zeroHeight.focus).not.toHaveBeenCalled()

    // Visible heading: non-zero box and visible style -> focuses once
    const visibleHeading: VisibleFocusableTarget = {
      focus: vi.fn(),
      isConnected: true,
      closest: () => null,
      getClientRects: visibleRects,
    }
    expect(isTargetVisible(visibleHeading, visibleStyle)).toBe(true)
    expect(focusIfVisible(visibleHeading, visibleStyle)).toBe(true)
    expect(visibleHeading.focus).toHaveBeenCalledOnce()
  })

  it('submitAndFocusComposer focuses the submitted Composer synchronously and never steals focus when send settles later', async () => {
    let resolveSend!: (ok: boolean) => void
    const onsubmit = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolveSend = r
        }),
    )
    const composer = { focus: vi.fn(), isConnected: true }

    submitAndFocusComposer(onsubmit, composer)
    expect(onsubmit).toHaveBeenCalledOnce()
    expect(composer.focus).toHaveBeenCalledOnce()

    composer.focus.mockClear()
    resolveSend(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(composer.focus).not.toHaveBeenCalled()
  })

  it('resolveMainTimelineFocusStatus distinguishes loading, ready, error, unavailable and pending Topic sends', () => {
    const base = {
      channelListStatus: 'ready' as const,
      hasSelectedTimeline: true,
      organizationUnavailable: false,
      timelineStatus: 'ready' as const,
      hasTopics: true,
      topicsMain: { asOfSeq: 5, loading: false, error: false },
      topicsUnavailable: false,
      topicPendingSend: false,
    }
    expect(resolveMainTimelineFocusStatus(base)).toBe('ready')
    expect(resolveMainTimelineFocusStatus({ ...base, topicPendingSend: true })).toBe('loading')
    expect(
      resolveMainTimelineFocusStatus({
        ...base,
        topicsMain: { asOfSeq: undefined, loading: false, error: false },
      }),
    ).toBe('loading')
    expect(
      resolveMainTimelineFocusStatus({
        ...base,
        topicsMain: { asOfSeq: undefined, loading: false, error: true },
      }),
    ).toBe('error')
    expect(resolveMainTimelineFocusStatus({ ...base, timelineStatus: 'loading' })).toBe('loading')
    expect(resolveMainTimelineFocusStatus({ ...base, timelineStatus: 'error' })).toBe('error')
    expect(resolveMainTimelineFocusStatus({ ...base, timelineStatus: 'unavailable' })).toBe('unavailable')
    expect(resolveMainTimelineFocusStatus({ ...base, topicsUnavailable: true })).toBe('unavailable')
    expect(resolveMainTimelineFocusStatus({ ...base, organizationUnavailable: true })).toBe('unavailable')
    expect(resolveMainTimelineFocusStatus({ ...base, hasSelectedTimeline: false, channelListStatus: 'loading' })).toBe(
      'loading',
    )
    expect(resolveMainTimelineFocusStatus({ ...base, hasSelectedTimeline: false, channelListStatus: 'error' })).toBe(
      'error',
    )
  })

  it('createTopicSummaryFocusController waits for delayed summary render, falls back only when ready/error, and cancels on navigation or user focus change', () => {
    const body = {}
    let activeElement: unknown = body
    const focusInListeners = new Set<(event: { target?: unknown }) => void>()
    const fakeDoc: FocusDocument = {
      get activeElement() {
        return activeElement
      },
      body,
      addEventListener(type, listener) {
        if (type === 'focusin') focusInListeners.add(listener)
      },
      removeEventListener(type, listener) {
        if (type === 'focusin') focusInListeners.delete(listener)
      },
    }
    const ctrl = createTopicSummaryFocusController(() => fakeDoc)
    const composer = {
      isConnected: true,
      focus: vi.fn(() => {
        activeElement = composer
        for (const l of focusInListeners) l({ target: composer })
      }),
    }
    const summary = {
      isConnected: true,
      focus: vi.fn(() => {
        activeElement = summary
        for (const l of focusInListeners) l({ target: summary })
      }),
    }

    // 1. Waits while loading, then focuses summary once rendered
    const backBtn = { isConnected: true }
    activeElement = backBtn
    ctrl.syncNavigation({ revision: 1, focus: 'topic-summary' }, 't-1')
    expect(ctrl.isPending(1)).toBe(true)
    backBtn.isConnected = false
    activeElement = body

    expect(ctrl.step({ revision: 1, status: 'loading', findSummary: () => null, composer })).toBe('waiting')
    expect(composer.focus).not.toHaveBeenCalled()
    expect(ctrl.isPending(1)).toBe(true)

    expect(ctrl.step({ revision: 1, status: 'ready', findSummary: (id) => (id === 't-1' ? summary : null), composer })).toBe(
      'focused_summary',
    )
    expect(summary.focus).toHaveBeenCalledOnce()
    expect(composer.focus).not.toHaveBeenCalled()
    expect(ctrl.isPending(1)).toBe(false)

    // 2. Falls back to Composer when ready and summary is definitively absent
    summary.focus.mockClear()
    activeElement = body
    ctrl.syncNavigation({ revision: 2, focus: 'topic-summary' }, 't-missing')
    expect(ctrl.step({ revision: 2, status: 'ready', findSummary: () => null, composer })).toBe('focused_composer')
    expect(composer.focus).toHaveBeenCalledOnce()
    expect(ctrl.isPending(2)).toBe(false)

    // 3. Cancels when user moves focus via focusin before summary appears
    composer.focus.mockClear()
    const otherBtn = { isConnected: true }
    activeElement = body
    ctrl.syncNavigation({ revision: 3, focus: 'topic-summary' }, 't-1')
    activeElement = otherBtn
    for (const l of focusInListeners) l({ target: otherBtn })
    expect(
      ctrl.step({ revision: 3, status: 'ready', findSummary: () => summary, composer }),
    ).toBe('cancelled')
    expect(summary.focus).not.toHaveBeenCalled()
    expect(composer.focus).not.toHaveBeenCalled()

    // 4. Cancels when a newer navigation supersedes the pending revision
    activeElement = body
    ctrl.syncNavigation({ revision: 4, focus: 'topic-summary' }, 't-1')
    ctrl.syncNavigation({ revision: 5, focus: 'composer' }, null)
    expect(ctrl.isPending(4)).toBe(false)
    expect(ctrl.step({ revision: 4, status: 'ready', findSummary: () => summary, composer })).toBe('cancelled')
    expect(focusInListeners.size).toBe(0)
  })
})
