import { describe, expect, it } from 'vitest'
import {
  IME_COMPOSING_KEY_CODE,
  isImeComposing,
  shouldCloseOnEscape,
  shouldSubmitOnEnter,
} from './composer-keys'

describe('composer-keys: IME-safe Enter and Escape (docs/ui.md §6, §9)', () => {
  it('submits on plain Enter when not composing', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter' })).toBe(true)
    expect(
      shouldSubmitOnEnter({
        key: 'Enter',
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        isComposing: false,
        keyCode: 13,
      }),
    ).toBe(true)
  })

  it('never submits while IME is composing via isComposing or keyCode/which 229', () => {
    expect(isImeComposing({ isComposing: true })).toBe(true)
    expect(isImeComposing({ isComposing: false, keyCode: IME_COMPOSING_KEY_CODE })).toBe(true)
    expect(isImeComposing({ isComposing: false, which: IME_COMPOSING_KEY_CODE })).toBe(true)
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false)

    expect(shouldSubmitOnEnter({ key: 'Enter', isComposing: true })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Enter', isComposing: false, which: 229 })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Process', keyCode: 229 })).toBe(false)
  })

  it('requires exact modifiers and ignores Shift+Enter (newline) and defaultPrevented', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Enter', altKey: true })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Enter', ctrlKey: true })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Enter', metaKey: true })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Enter', defaultPrevented: true })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'a' })).toBe(false)
  })

  it('handles Escape only when not composing and without modifiers or defaultPrevented', () => {
    expect(shouldCloseOnEscape({ key: 'Escape' })).toBe(true)
    expect(shouldCloseOnEscape({ key: 'Escape', isComposing: true })).toBe(false)
    expect(shouldCloseOnEscape({ key: 'Escape', keyCode: 229 })).toBe(false)
    expect(shouldCloseOnEscape({ key: 'Escape', shiftKey: true })).toBe(false)
    expect(shouldCloseOnEscape({ key: 'Escape', defaultPrevented: true })).toBe(false)
  })
})
