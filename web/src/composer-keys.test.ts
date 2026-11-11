import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IME_COMPOSING_KEY_CODE,
  isImeComposing,
  shouldCloseOnEscape,
  shouldSubmitOnEnter,
  shouldTogglePanelShortcut,
  stepTabListKey,
} from './composer-keys'

const webDir = resolve(import.meta.dirname, '..')

describe('composer-keys: IME-safe Enter, Escape, shortcuts and ARIA tabs (docs/ui.md §6, §9)', () => {
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

  it('matches ⌘. / Ctrl+. panel shortcut only with exact modifier and not during IME composition', () => {
    expect(shouldTogglePanelShortcut({ key: '.', metaKey: true })).toBe(true)
    expect(shouldTogglePanelShortcut({ key: '.', ctrlKey: true })).toBe(true)
    expect(shouldTogglePanelShortcut({ key: '.', metaKey: true, ctrlKey: true })).toBe(false)
    expect(shouldTogglePanelShortcut({ key: '.', metaKey: true, shiftKey: true })).toBe(false)
    expect(shouldTogglePanelShortcut({ key: '.', metaKey: true, altKey: true })).toBe(false)
    expect(shouldTogglePanelShortcut({ key: '.', metaKey: true, isComposing: true })).toBe(false)
    expect(shouldTogglePanelShortcut({ key: '.', metaKey: true, keyCode: 229 })).toBe(false)
    expect(shouldTogglePanelShortcut({ key: '.', metaKey: true, defaultPrevented: true })).toBe(false)
    expect(shouldTogglePanelShortcut({ key: '.' })).toBe(false)
  })

  it('navigates ARIA tablist tabs with ArrowRight, ArrowLeft, Home and End', () => {
    const tabs = ['topics', 'overview', 'members'] as const
    expect(stepTabListKey(tabs, 'topics', { key: 'ArrowRight' })).toBe('overview')
    expect(stepTabListKey(tabs, 'members', { key: 'ArrowRight' })).toBe('topics')
    expect(stepTabListKey(tabs, 'topics', { key: 'ArrowLeft' })).toBe('members')
    expect(stepTabListKey(tabs, 'overview', { key: 'Home' })).toBe('topics')
    expect(stepTabListKey(tabs, 'topics', { key: 'End' })).toBe('members')
    expect(stepTabListKey(tabs, 'topics', { key: 'ArrowRight', isComposing: true })).toBeNull()
    expect(stepTabListKey(tabs, 'topics', { key: 'ArrowRight', shiftKey: true })).toBeNull()
    expect(stepTabListKey(tabs, 'topics', { key: 'Tab' })).toBeNull()
  })

  it('wires IME-safe key handlers, Dialog focus trap and ARIA tabs in Svelte components', () => {
    const composerSrc = readFileSync(join(webDir, 'src/Composer.svelte'), 'utf8')
    expect(composerSrc).toMatch(/if\s*\(\s*shouldSubmitOnEnter\s*\(\s*e\s*\)\s*\)/)
    expect(composerSrc).not.toMatch(/e\.key\s*===\s*['"]Enter['"]/)

    const dialogSrc = readFileSync(join(webDir, 'src/ui/Dialog.svelte'), 'utf8')
    expect(dialogSrc).toContain('focusDialogOnOpen')
    expect(dialogSrc).toContain('stepDialogTab')
    expect(dialogSrc).toContain('restoreFocusAfterDialogClose')
    expect(dialogSrc).toContain('e.stopPropagation()')
    expect(dialogSrc).not.toContain('<svelte:window')

    const panelSrc = readFileSync(join(webDir, 'src/ui/Panel.svelte'), 'utf8')
    expect(panelSrc).toContain('role="tablist"')
    expect(panelSrc).toContain('role="tab"')
    expect(panelSrc).toContain('aria-controls={activeTab === tab.id ? `panel-tabpanel-${tab.id}` : undefined}')
    expect(panelSrc).not.toContain('aria-controls={`panel-tabpanel-${tab.id}`}')
    expect(panelSrc).toContain('role="tabpanel"')
    expect(panelSrc).toContain('tabindex={activeTab === tab.id ? 0 : -1}')
    expect(panelSrc).toContain('stepTabListKey')

    const workspaceSrc = readFileSync(join(webDir, 'src/Workspace.svelte'), 'utf8')
    expect(workspaceSrc).toContain('shouldTogglePanelShortcut')
    expect(workspaceSrc).toContain('resolveSenderName: resolveSender')
    expect(workspaceSrc).toContain('resolveSkipLinkTargetId')
    expect(workspaceSrc).toContain('id="channel-content"')
    expect(workspaceSrc).toContain('id="main-content"')
    expect(workspaceSrc).toContain('id="panel-content"')
    expect(workspaceSrc).toContain(
      "const effectiveMobileLevel = $derived(!selected && mobileLevel === 'view' ? 'channels' : mobileLevel)",
    )
    expect(workspaceSrc).not.toContain('左のフォーム')
    expect(workspaceSrc).not.toContain('トピックはまだありません。')

    const appSrc = readFileSync(join(webDir, 'src/App.svelte'), 'utf8')
    expect(appSrc).toContain('href={`#${skipTargetId}`}')
    expect(appSrc).toContain('bind:skipTargetId={workspaceSkipTargetId}')
  })
})
