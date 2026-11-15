/** IME composition keyCode used by browsers when an IME processes the key event (`docs/ui.md` §6, §9). */
export const IME_COMPOSING_KEY_CODE = 229

export type KeyEventLike = {
  key: string
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
  keyCode?: number
  which?: number
  defaultPrevented?: boolean
}

/** True when an IME composition is active (`isComposing` or `keyCode === 229`). */
export function isImeComposing(event: Pick<KeyEventLike, 'isComposing' | 'keyCode' | 'which'>): boolean {
  return Boolean(event.isComposing) || event.keyCode === IME_COMPOSING_KEY_CODE || event.which === IME_COMPOSING_KEY_CODE
}

/**
 * True when a Composer keydown event should submit the Message (`docs/ui.md` §6, §9):
 * plain `Enter` without modifiers, not `defaultPrevented`, and not while the IME is composing.
 */
export function shouldSubmitOnEnter(event: KeyEventLike): boolean {
  if (event.defaultPrevented) return false
  if (isImeComposing(event)) return false
  if (event.key !== 'Enter') return false
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}

/**
 * True when an `Escape` keydown event should close the topmost layer or return focus (`docs/ui.md` §9):
 * plain `Escape` without modifiers, not `defaultPrevented`, and not while the IME is composing.
 */
export function shouldCloseOnEscape(event: KeyEventLike): boolean {
  if (event.defaultPrevented) return false
  if (isImeComposing(event)) return false
  if (event.key !== 'Escape') return false
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}

/**
 * True when a keydown event matches the `⌘.` (`Ctrl+.` on non-macOS) shortcut to open or close the right panel
 * (`docs/ui.md` §2, §9): exact modifier (`metaKey` XOR `ctrlKey`), no `shiftKey`/`altKey`, not `defaultPrevented`,
 * and not while the IME is composing.
 */
export function shouldTogglePanelShortcut(event: KeyEventLike): boolean {
  if (event.defaultPrevented) return false
  if (isImeComposing(event)) return false
  if (event.key !== '.') return false
  if (event.shiftKey || event.altKey) return false
  return Boolean(event.metaKey) !== Boolean(event.ctrlKey)
}

/**
 * Computes the next active tab ID for horizontal ARIA `tablist` keyboard navigation
 * (`ArrowRight`, `ArrowLeft`, `Home`, `End`) (`docs/ui.md` §2, §6, §9).
 */
export function stepTabListKey<T extends string>(
  tabs: readonly T[],
  currentId: T,
  event: KeyEventLike,
): T | null {
  if (tabs.length === 0) return null
  if (event.defaultPrevented || isImeComposing(event)) return null
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null

  const idx = Math.max(0, tabs.indexOf(currentId))
  switch (event.key) {
    case 'ArrowRight':
      return tabs[(idx + 1) % tabs.length]
    case 'ArrowLeft':
      return tabs[(idx - 1 + tabs.length) % tabs.length]
    case 'Home':
      return tabs[0]
    case 'End':
      return tabs[tabs.length - 1]
    default:
      return null
  }
}

/**
 * True when pressing `ArrowUp` in an empty Composer (`draft === ''` and `topicDraft === ''`)
 * should move focus to the latest Message row (`docs/ui.md` §9).
 */
export function shouldFocusLatestMessageOnArrowUp(
  event: KeyEventLike,
  draft: string,
  topicDraft = '',
): boolean {
  if (event.defaultPrevented || isImeComposing(event)) return false
  if (event.key !== 'ArrowUp') return false
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
  return draft.length === 0 && topicDraft.length === 0
}

/**
 * True when pressing `Enter` or `R` (`r`/`R`) on a focused Message row should open its
 * Reply chain (`返信のつながり`) (`docs/ui.md` §9).
 */
export function shouldOpenRepliesFromRowKey(event: KeyEventLike): boolean {
  if (event.defaultPrevented || isImeComposing(event)) return false
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
  return event.key === 'Enter' || event.key === 'r' || event.key === 'R'
}

/**
 * Computes the next Message row index for vertical keyboard navigation
 * (`ArrowUp`, `ArrowDown`, `Home`, `End`) on a focused Message row (`docs/ui.md` §9).
 */
export function stepMessageRowIndex(
  currentIndex: number,
  totalRows: number,
  event: KeyEventLike,
): number | null {
  if (totalRows <= 0 || currentIndex < 0 || currentIndex >= totalRows) return null
  if (event.defaultPrevented || isImeComposing(event)) return null
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null

  switch (event.key) {
    case 'ArrowUp':
      return Math.max(0, currentIndex - 1)
    case 'ArrowDown':
      return Math.min(totalRows - 1, currentIndex + 1)
    case 'Home':
      return 0
    case 'End':
      return totalRows - 1
    default:
      return null
  }
}

/**
 * Resolves which focusable Message row ID receives `tabindex="0"` in a roving-tabindex timeline (`docs/ui.md` §9):
 * keeps `activeId` while it remains in `messageIds`, otherwise defaults to the latest Message.
 */
export function resolveRovingMessageId(
  messageIds: readonly string[],
  activeId: string | null,
): string | null {
  if (messageIds.length === 0) return null
  if (activeId !== null && messageIds.includes(activeId)) return activeId
  return messageIds[messageIds.length - 1]
}

/** The autocomplete consumes keys only while a suggestion list is open. */
export function mentionKey(event: KeyEventLike): 'accept' | 'next' | 'previous' | 'dismiss' | null {
  if (event.defaultPrevented || isImeComposing(event) || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null
  switch (event.key) {
    case 'Enter': return 'accept'
    case 'ArrowDown': return 'next'
    case 'ArrowUp': return 'previous'
    case 'Escape': return 'dismiss'
    default: return null
  }
}
