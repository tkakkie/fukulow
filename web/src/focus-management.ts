export type FocusableTarget = {
  focus(): void
  isConnected?: boolean
  disabled?: boolean
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

/**
 * Moves focus into the Channel list (`docs/ui.md` §5 C9 `チャンネル一覧へ`):
 * prefers the selected Channel row, then the first Channel row, then any enabled
 * control in the Channel column (e.g. Channel creation input when empty),
 * and finally the Channel navigation landmark (`tabindex="-1"`).
 */
export function focusChannelList(options: {
  selectedChannel?: FocusableTarget | null
  channelButtons?: readonly FocusableTarget[]
  fallbackControls?: readonly FocusableTarget[]
  landmarkFallback?: FocusableTarget | null
}): FocusableTarget | null {
  if (focusTarget(options.selectedChannel)) return options.selectedChannel ?? null
  for (const btn of options.channelButtons ?? []) {
    if (focusTarget(btn)) return btn
  }
  for (const ctrl of options.fallbackControls ?? []) {
    if (focusTarget(ctrl)) return ctrl
  }
  if (focusTarget(options.landmarkFallback)) return options.landmarkFallback ?? null
  return null
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
 * Decides whether `編集して送り直す` can restore immediately or must first ask to replace an existing draft
 * (`docs/ui.md` §5 "Send refused": `入力中の下書きを置き換えますか？`).
 */
export function decideEditAndResend(clientMessageId: string, currentDraft: string): RestoreDecision {
  if (currentDraft.length > 0) {
    return { action: 'confirm_replace', clientMessageId }
  }
  return { action: 'restore_now' }
}

/**
 * Replaces the current Composer draft with the refused send's body (via `setDraft('')` + `restore(id)`)
 * and moves focus to the Composer (`docs/ui.md` §5 "Send refused").
 * Checks `canRestore` first and restores `currentDraft` if `restore` fails so the user's draft is never lost.
 */
export function confirmReplaceDraftWithFailedSend(
  clientMessageId: string,
  currentDraft: string,
  canRestore: boolean,
  setDraft: (draft: string) => void,
  restore: (id: string) => boolean,
  composer: FocusableTarget | null | undefined,
): boolean {
  if (!canRestore) return false
  setDraft('')
  const restored = restore(clientMessageId)
  if (!restored) {
    setDraft(currentDraft)
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
