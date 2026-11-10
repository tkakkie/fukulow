export type FocusableTarget = {
  focus(): void
  isConnected?: boolean
}

export type RestoreDecision =
  | { action: 'restore_now' }
  | { action: 'confirm_replace'; clientMessageId: string }

/**
 * Focuses `target` if present and connected (`docs/ui.md` §2, §5, §6).
 * Returns true when `.focus()` was called.
 */
export function focusTarget(target: FocusableTarget | null | undefined): boolean {
  if (!target || target.isConnected === false) return false
  target.focus()
  return true
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
 */
export function confirmReplaceDraftWithFailedSend(
  clientMessageId: string,
  setDraft: (draft: string) => void,
  restore: (id: string) => boolean,
  composer: FocusableTarget | null | undefined,
): boolean {
  setDraft('')
  const restored = restore(clientMessageId)
  if (restored) focusTarget(composer)
  return restored
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
