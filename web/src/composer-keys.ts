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
