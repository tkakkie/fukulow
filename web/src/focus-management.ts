export type FocusableTarget = {
  focus(): void
  isConnected?: boolean
  disabled?: boolean
}

export type ComputedVisibilityStyle = {
  readonly display?: string
  readonly visibility?: string
}

export type VisibleFocusableTarget = FocusableTarget & {
  readonly hidden?: boolean | string
  readonly closest?: (selector: string) => unknown
  readonly getClientRects?: () => ArrayLike<{ readonly width: number; readonly height: number }>
}

export type MobileLevel = 'channels' | 'view' | 'panel'
export type SkipLinkTargetId = 'channel-content' | 'main-content' | 'panel-content'

export const MOBILE_BREAKPOINT_PX = 600
export const DESKTOP_BREAKPOINT_PX = 960

/**
 * Resolves the ID of the currently visible primary region for the page skip link (`メッセージへ移動`)
 * across desktop/tablet (`>= 600px`) and phone (`< 600px`) levels (`docs/ui.md` §3, §6).
 */
export function resolveSkipLinkTargetId(options: {
  viewportWidth: number
  mobileLevel: MobileLevel
  panelOpen: boolean
}): SkipLinkTargetId {
  if (options.viewportWidth >= MOBILE_BREAKPOINT_PX) {
    return 'main-content'
  }
  if (options.mobileLevel === 'panel' && options.panelOpen) {
    return 'panel-content'
  }
  if (options.mobileLevel === 'channels') {
    return 'channel-content'
  }
  return 'main-content'
}

/**
 * Resolves the responsive layout state for `チャンネル一覧へ` (`docs/ui.md` §3, §5):
 * opens the Channel drawer only at tablet widths (`600-959px`), enters the `'channels'`
 * screen level for phone (`< 600px`), and keeps desktop (`>= 960px`) drawer-free.
 */
export function resolveChannelListNavigation(viewportWidth: number): {
  drawerOpen: boolean
  mobileLevel: MobileLevel
} {
  return {
    drawerOpen: viewportWidth >= MOBILE_BREAKPOINT_PX && viewportWidth < DESKTOP_BREAKPOINT_PX,
    mobileLevel: 'channels',
  }
}

export type RestoreDecision =
  | { action: 'restore_now' }
  | { action: 'confirm_replace'; clientMessageId: string }

/**
 * Focuses `target` if present, connected and not disabled (`docs/ui.md` §2, §5, §6).
 * Returns true when `.focus()` was called.
 */
export function focusTarget(target: FocusableTarget | null | undefined): boolean {
  if (!target || target.isConnected === false || target.disabled === true) return false
  target.focus()
  return true
}

function defaultComputedStyle(target: VisibleFocusableTarget): ComputedVisibilityStyle | null {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null
  const viewStyle = target.ownerDocument?.defaultView?.getComputedStyle
  if (typeof viewStyle === 'function') return viewStyle.call(target.ownerDocument.defaultView, target)
  if (typeof getComputedStyle === 'function') return getComputedStyle(target)
  return null
}

/**
 * Checks whether `target` is connected, enabled, and actually rendered with non-zero layout boxes
 * (neither `display: none`, `visibility: hidden`/`collapse`, `[hidden]`/`[inert]`/`[aria-hidden="true"]`,
 * nor zero-size via `getClientRects`) so focus never moves to a hidden element (`docs/ui.md` §5, §6).
 */
export function isTargetVisible(
  target: VisibleFocusableTarget | null | undefined,
  getStyle: (el: VisibleFocusableTarget) => ComputedVisibilityStyle | null | undefined = defaultComputedStyle,
): boolean {
  if (!target || target.isConnected === false || target.disabled === true || Boolean(target.hidden)) {
    return false
  }
  if (typeof target.closest === 'function' && target.closest('[hidden], [inert], [aria-hidden="true"]')) {
    return false
  }
  const style = getStyle(target)
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) {
    return false
  }
  if (typeof target.getClientRects !== 'function') {
    return false
  }
  const rects = target.getClientRects()
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]
    if (rect && rect.width > 0 && rect.height > 0) {
      return true
    }
  }
  return false
}

/**
 * Focuses `target` only when `isTargetVisible(target)` holds (`docs/ui.md` §5 C9 `チャンネル一覧へ`).
 * Returns true when `.focus()` was called.
 */
export function focusIfVisible(
  target: VisibleFocusableTarget | null | undefined,
  getStyle?: (el: VisibleFocusableTarget) => ComputedVisibilityStyle | null | undefined,
): boolean {
  if (!isTargetVisible(target, getStyle)) return false
  return focusTarget(target)
}

/**
 * Discards a failed send and moves focus to the Composer (`docs/ui.md` §5 "After 破棄", §6).
 */
export function discardAndFocusComposer(
  clientMessageId: string,
  discard: (id: string) => void,
  composer: FocusableTarget | null | undefined,
): void {
  discard(clientMessageId)
  focusTarget(composer)
}

/**
 * Submits a Composer draft and keeps focus in its own textarea immediately at submit time
 * (`docs/ui.md` §3, §6), never asynchronously when the HTTP send settles (which would steal
 * focus after the user has moved focus elsewhere or into a remounted view's Composer).
 */
export function submitAndFocusComposer(
  onsubmit: () => Promise<boolean>,
  composer: FocusableTarget | null | undefined,
): void {
  void onsubmit().catch(console.error)
  focusTarget(composer)
}

export type MainTimelineFocusStatus = 'loading' | 'ready' | 'error' | 'unavailable'

/**
 * Classifies whether the returning Channel's main timeline is still loading Topic lines,
 * definitively ready, errored, or unavailable (`docs/ui.md` §2, §5).
 */
export function resolveMainTimelineFocusStatus(options: {
  channelListStatus: 'loading' | 'ready' | 'error'
  hasSelectedTimeline: boolean
  organizationUnavailable: boolean
  timelineStatus: 'loading' | 'ready' | 'unavailable' | 'error' | null
  hasTopics: boolean
  topicsMain: { readonly asOfSeq?: number; readonly loading: boolean; readonly error: boolean } | null
  topicsUnavailable: boolean
  topicPendingSend: boolean
}): MainTimelineFocusStatus {
  if (options.organizationUnavailable || options.timelineStatus === 'unavailable' || options.topicsUnavailable) {
    return 'unavailable'
  }
  if (!options.hasSelectedTimeline) {
    return options.channelListStatus === 'error' ? 'error' : 'loading'
  }
  if (options.timelineStatus === 'error') {
    return 'error'
  }
  if (options.timelineStatus === null || options.timelineStatus === 'loading') {
    return 'loading'
  }
  if (options.hasTopics) {
    if (!options.topicsMain) return 'loading'
    if (options.topicsMain.asOfSeq === undefined) {
      return options.topicsMain.error ? 'error' : 'loading'
    }
  }
  if (options.topicPendingSend) {
    return 'loading'
  }
  return 'ready'
}

export type FocusDocument = {
  readonly activeElement?: unknown
  readonly body?: unknown
  readonly documentElement?: unknown
  addEventListener?: (type: string, listener: (event: { target?: unknown }) => void, capture?: boolean) => void
  removeEventListener?: (type: string, listener: (event: { target?: unknown }) => void, capture?: boolean) => void
}

export type TopicSummaryFocusStepResult = 'focused_summary' | 'focused_composer' | 'waiting' | 'cancelled'

function defaultFocusDocument(): FocusDocument | null {
  return typeof document !== 'undefined' ? (document as unknown as FocusDocument) : null
}

/**
 * Coordinates `topic-summary` return focus across remounted Channel timelines (`docs/ui.md` §2):
 * focuses the returning Topic's summary line as soon as it renders for the active navigation revision,
 * falls back to the Composer only once the main timeline is ready (with the Topic line absent) or errored/unavailable,
 * and cancels immediately if navigation advances or the user moves focus elsewhere.
 */
export function createTopicSummaryFocusController(
  getDoc: () => FocusDocument | null = defaultFocusDocument,
) {
  type Pending = {
    revision: number
    topicId: string | null
    baselineActive: unknown
  }

  let pending: Pending | null = null
  let lastHandledRevision = -1
  let applyingFocus = false
  let attachedDoc: FocusDocument | null = null

  const isResetOrDisconnectedActive = (active: unknown, doc: FocusDocument | null): boolean => {
    if (!active) return true
    if (doc && (active === doc.body || active === doc.documentElement)) return true
    if (
      typeof active === 'object' &&
      'isConnected' in active &&
      (active as { isConnected?: boolean }).isConnected === false
    ) {
      return true
    }
    return false
  }

  const onFocusIn = (event: { target?: unknown }) => {
    if (!pending || applyingFocus) return
    const doc = getDoc()
    const target = event.target
    if (isResetOrDisconnectedActive(target, doc) || target === pending.baselineActive) return
    lastHandledRevision = pending.revision
    clearPending()
  }

  const detachListener = () => {
    if (attachedDoc?.removeEventListener) {
      attachedDoc.removeEventListener('focusin', onFocusIn, true)
    }
    attachedDoc = null
  }

  const clearPending = () => {
    detachListener()
    pending = null
  }

  const hasUserMovedFocus = (entry: Pending, doc: FocusDocument | null): boolean => {
    if (!doc) return false
    const active = doc.activeElement
    if (isResetOrDisconnectedActive(active, doc)) return false
    return active !== entry.baselineActive
  }

  const focusWithGuard = (target: FocusableTarget | null | undefined): boolean => {
    applyingFocus = true
    try {
      return focusTarget(target)
    } finally {
      applyingFocus = false
    }
  }

  return {
    syncNavigation(snapshot: { revision: number; focus: string }, returningTopicId: string | null): void {
      if (snapshot.focus !== 'topic-summary') {
        clearPending()
        return
      }
      if (pending?.revision === snapshot.revision || lastHandledRevision === snapshot.revision) {
        return
      }
      clearPending()
      const doc = getDoc()
      pending = {
        revision: snapshot.revision,
        topicId: returningTopicId,
        baselineActive: doc?.activeElement ?? null,
      }
      if (doc?.addEventListener) {
        doc.addEventListener('focusin', onFocusIn, true)
        attachedDoc = doc
      }
    },

    isPending(revision: number): boolean {
      return pending !== null && pending.revision === revision
    },

    step(options: {
      revision: number
      status: MainTimelineFocusStatus
      findSummary: (topicId: string) => FocusableTarget | null | undefined
      composer: FocusableTarget | null | undefined
    }): TopicSummaryFocusStepResult {
      if (!pending || pending.revision !== options.revision) {
        return 'cancelled'
      }
      const doc = getDoc()
      if (hasUserMovedFocus(pending, doc)) {
        lastHandledRevision = options.revision
        clearPending()
        return 'cancelled'
      }
      if (pending.topicId) {
        const summary = options.findSummary(pending.topicId)
        if (focusWithGuard(summary)) {
          lastHandledRevision = options.revision
          clearPending()
          return 'focused_summary'
        }
      }
      if (options.status === 'loading') {
        return 'waiting'
      }
      lastHandledRevision = options.revision
      clearPending()
      focusWithGuard(options.composer)
      return 'focused_composer'
    },

    destroy(): void {
      clearPending()
    },
  }
}

/**
 * Decides whether `編集して送り直す` can restore immediately or must first ask to replace an existing draft
 * (`docs/ui.md` §5 "Send refused": `入力中の下書きを置き換えますか？`).
 */
export function decideEditAndResend(
  clientMessageId: string,
  currentDraft: string,
  currentTopicDraft = '',
): RestoreDecision {
  if (currentDraft.length > 0 || currentTopicDraft.length > 0) {
    return { action: 'confirm_replace', clientMessageId }
  }
  return { action: 'restore_now' }
}

/**
 * Replaces the current Composer draft (and optional Topic-name draft) with the refused send's body
 * (via `setDraft('')` + `restore(id)`) and moves focus to the Composer (`docs/ui.md` §5 "Send refused").
 * Checks `canRestore` first and restores `currentDraft` (and `currentTopicDraft`) if `restore` fails
 * so the user's draft is never lost.
 */
export function confirmReplaceDraftWithFailedSend(
  clientMessageId: string,
  currentDraft: string,
  canRestore: boolean,
  setDraft: (draft: string) => void,
  restore: (id: string) => boolean,
  composer: FocusableTarget | null | undefined,
  topicDraftOptions?: {
    currentTopicDraft: string
    setTopicDraft: (topicDraft: string) => void
  },
): boolean {
  if (!canRestore) return false
  setDraft('')
  topicDraftOptions?.setTopicDraft('')
  const restored = restore(clientMessageId)
  if (!restored) {
    setDraft(currentDraft)
    topicDraftOptions?.setTopicDraft(topicDraftOptions.currentTopicDraft)
    return false
  }
  focusTarget(composer)
  return true
}

/**
 * Restores focus when the right panel closes (`×`, `Esc`): focuses the control that opened the panel,
 * or falls back to the main Composer if that control is gone (`docs/ui.md` §2).
 */
export function focusAfterPanelClose(
  invoker: FocusableTarget | null | undefined,
  composer: FocusableTarget | null | undefined,
): void {
  if (!focusTarget(invoker)) {
    focusTarget(composer)
  }
}

/**
 * Moves focus into a modal dialog on open: focuses the first connected focusable control inside the dialog,
 * or falls back to the dialog container itself (`docs/ui.md` §6, §9).
 */
export function focusDialogOnOpen(
  focusables: readonly FocusableTarget[],
  dialogFallback?: FocusableTarget | null,
): FocusableTarget | null {
  for (const el of focusables) {
    if (focusTarget(el)) return el
  }
  if (focusTarget(dialogFallback)) return dialogFallback ?? null
  return null
}

/**
 * Traps `Tab` and `Shift+Tab` inside a modal dialog (`docs/ui.md` §6, §9).
 * Returns the element that received focus.
 */
export function stepDialogTab(
  focusables: readonly FocusableTarget[],
  active: FocusableTarget | null | undefined,
  shiftKey: boolean,
  dialogFallback?: FocusableTarget | null,
): FocusableTarget | null {
  const isEnabled = (el: FocusableTarget) => el.isConnected !== false && el.disabled !== true
  const connected = focusables.filter(isEnabled)
  if (connected.length === 0) {
    if (focusTarget(dialogFallback)) return dialogFallback ?? null
    return null
  }
  const rawIdx = active ? focusables.indexOf(active) : -1
  if (rawIdx === -1) {
    const target = connected[shiftKey ? connected.length - 1 : 0]
    focusTarget(target)
    return target
  }
  const step = shiftKey ? -1 : 1
  for (let offset = 1; offset <= focusables.length; offset++) {
    const candidate = focusables[(rawIdx + step * offset + focusables.length) % focusables.length]
    if (isEnabled(candidate)) {
      focusTarget(candidate)
      return candidate
    }
  }
  return null
}

/**
 * Restores focus to the opener when a modal dialog closes, or falls back if the opener is gone (`docs/ui.md` §6, §9).
 */
export function restoreFocusAfterDialogClose(
  opener: FocusableTarget | null | undefined,
  fallback?: FocusableTarget | null,
): boolean {
  if (focusTarget(opener)) return true
  return focusTarget(fallback)
}
