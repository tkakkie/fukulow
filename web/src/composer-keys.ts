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
