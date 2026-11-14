import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mount, settle } from './adapter-test-helpers.svelte'
import {
  applyUiSettings,
  createUiSettings,
  DEFAULT_UI_SETTINGS,
  initUiSettings,
  readUiSettings,
  UI_SETTINGS_STORAGE_KEYS,
  type UiRootElement,
  type UiStorage,
  type UiTextSize,
  type UiTheme,
} from './ui-settings'
import { uiSettingsAdapter } from './ui-settings.svelte'

const webDir = resolve(import.meta.dirname, '..')

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  const setCalls: [string, string][] = []
  const removeCalls: string[] = []
  const getCalls: string[] = []
  const storage: UiStorage = {
    getItem(key: string) {
      getCalls.push(key)
      return map.has(key) ? map.get(key)! : null
    },
    setItem(key: string, value: string) {
      setCalls.push([key, value])
      map.set(key, value)
    },
    removeItem(key: string) {
      removeCalls.push(key)
      map.delete(key)
    },
  }
  return { storage, map, getCalls, setCalls, removeCalls }
}

function fakeRoot(): UiRootElement & { attrs: Map<string, string> } {
  const attrs = new Map<string, string>()
  return {
    attrs,
    setAttribute(name: string, value: string) {
      attrs.set(name, value)
    },
    removeAttribute(name: string) {
      attrs.delete(name)
    },
  }
}

describe('ui-settings: allow-listed keys/values, validation, storage errors and DOM application (docs/ui.md §7)', () => {
  it('stores only allow-listed keys and values and never stores credentials', () => {
    expect(UI_SETTINGS_STORAGE_KEYS).toEqual({
      theme: 'fukulow.ui.theme',
      textSize: 'fukulow.ui.text-size',
    })
    expect(Object.isFrozen(UI_SETTINGS_STORAGE_KEYS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_UI_SETTINGS)).toBe(true)

    const { storage, map, setCalls, removeCalls } = fakeStorage()
    const root = fakeRoot()
    const ctrl = createUiSettings({ storage, root })

    expect(ctrl.get()).toEqual({ theme: 'system', textSize: 'standard' })
    expect(root.attrs.size).toBe(0)
    expect(setCalls).toEqual([])

    // Valid non-default values persist and set data-* attributes
    expect(ctrl.setTheme('dark')).toBe(true)
    expect(ctrl.get().theme).toBe('dark')
    expect(map.get('fukulow.ui.theme')).toBe('dark')
    expect(root.attrs.get('data-theme')).toBe('dark')

    expect(ctrl.setTheme('light')).toBe(true)
    expect(ctrl.get().theme).toBe('light')
    expect(map.get('fukulow.ui.theme')).toBe('light')
    expect(root.attrs.get('data-theme')).toBe('light')

    for (const size of ['s', 'l', 'xl'] as const) {
      expect(ctrl.setTextSize(size)).toBe(true)
      expect(ctrl.get().textSize).toBe(size)
      expect(map.get('fukulow.ui.text-size')).toBe(size)
      expect(root.attrs.get('data-text-size')).toBe(size)
    }

    // Default values remove the key from storage and remove the attribute
    expect(ctrl.setTheme('system')).toBe(true)
    expect(ctrl.get().theme).toBe('system')
    expect(map.has('fukulow.ui.theme')).toBe(false)
    expect(root.attrs.has('data-theme')).toBe(false)
    expect(removeCalls).toContain('fukulow.ui.theme')

    expect(ctrl.setTextSize('standard')).toBe(true)
    expect(ctrl.get().textSize).toBe('standard')
    expect(map.has('fukulow.ui.text-size')).toBe(false)
    expect(root.attrs.has('data-text-size')).toBe(false)
    expect(removeCalls).toContain('fukulow.ui.text-size')

    // Rejects every unlisted string, credential or non-string at runtime
    ctrl.setTheme('dark')
    ctrl.setTextSize('l')
    const writesBeforeInvalid = setCalls.length
    const removesBeforeInvalid = removeCalls.length

    const invalidInputs: unknown[] = [
      '',
      'auto',
      'sepia',
      'm',
      'xxl',
      '15px',
      '93.75%',
      'correct horse battery staple',
      'Bearer eyJhbGciOiJIUzI1NiJ9.secret',
      'session_token=secret-cookie-value',
      'setup-token-secret',
      'invite-token-secret',
      'user@example.com',
      '{"theme":"dark","token":"secret"}',
      'dark; color: red',
      null,
      undefined,
      123,
      { value: 'dark' },
    ]

    for (const bad of invalidInputs) {
      expect(ctrl.setTheme(bad as UiTheme)).toBe(false)
      expect(ctrl.setTextSize(bad as UiTextSize)).toBe(false)
    }

    // State, DOM and storage were not touched by any rejected call
    expect(setCalls.length).toBe(writesBeforeInvalid)
    expect(removeCalls.length).toBe(removesBeforeInvalid)
    expect(ctrl.get()).toEqual({ theme: 'dark', textSize: 'l' })
    expect(root.attrs.get('data-theme')).toBe('dark')
    expect(root.attrs.get('data-text-size')).toBe('l')

    // Every write ever recorded used only the two allow-listed keys and their allow-listed values
    for (const [k, v] of setCalls) {
      expect(['fukulow.ui.theme', 'fukulow.ui.text-size']).toContain(k)
      if (k === 'fukulow.ui.theme') expect(['light', 'dark']).toContain(v)
      if (k === 'fukulow.ui.text-size') expect(['s', 'l', 'xl']).toContain(v)
    }
  })

  it('validates reads, removes unknown stored values, and uses defaults', () => {
    // 1. Valid stored values are preserved
    const valid = fakeStorage({
      'fukulow.ui.theme': 'dark',
      'fukulow.ui.text-size': 'xl',
    })
    expect(readUiSettings(valid.storage)).toEqual({ theme: 'dark', textSize: 'xl' })
    expect(valid.removeCalls).toEqual([])

    // 2. Unknown values (including "system", "standard", empty strings or credential-like strings) are removed
    for (const badTheme of ['system', 'auto', '', 'Bearer secret', 'light ']) {
      const f = fakeStorage({
        'fukulow.ui.theme': badTheme,
        'fukulow.ui.text-size': 's',
      })
      expect(readUiSettings(f.storage)).toEqual({ theme: 'system', textSize: 's' })
      expect(f.removeCalls).toEqual(['fukulow.ui.theme'])
      expect(f.map.has('fukulow.ui.theme')).toBe(false)
      expect(f.map.get('fukulow.ui.text-size')).toBe('s')
    }

    for (const badSize of ['standard', 'm', '15px', '', 'password123456']) {
      const f = fakeStorage({
        'fukulow.ui.theme': 'light',
        'fukulow.ui.text-size': badSize,
      })
      expect(readUiSettings(f.storage)).toEqual({ theme: 'light', textSize: 'standard' })
      expect(f.removeCalls).toEqual(['fukulow.ui.text-size'])
      expect(f.map.has('fukulow.ui.text-size')).toBe(false)
      expect(f.map.get('fukulow.ui.theme')).toBe('light')
    }

    // 3. applyUiSettings ignores invalid settings objects passed via cast
    const root = fakeRoot()
    applyUiSettings({ theme: 'dark', textSize: 'l' }, root)
    expect(root.attrs.get('data-theme')).toBe('dark')
    expect(root.attrs.get('data-text-size')).toBe('l')

    applyUiSettings({ theme: 'invalid' as UiTheme, textSize: 'invalid' as UiTextSize }, root)
    expect(root.attrs.has('data-theme')).toBe(false)
    expect(root.attrs.has('data-text-size')).toBe(false)
  })

  it('falls back to in-memory defaults and keeps the UI working when storage is blocked or throws', () => {
    // 1. Storage unavailable (null)
    const root1 = fakeRoot()
    const ctrlNull = createUiSettings({ storage: null, root: root1 })
    expect(ctrlNull.get()).toEqual({ theme: 'system', textSize: 'standard' })
    expect(ctrlNull.setTheme('dark')).toBe(true)
    expect(ctrlNull.setTextSize('s')).toBe(true)
    expect(ctrlNull.get()).toEqual({ theme: 'dark', textSize: 's' })
    expect(root1.attrs.get('data-theme')).toBe('dark')
    expect(root1.attrs.get('data-text-size')).toBe('s')

    // 2. Storage methods throw (SecurityError / QuotaExceededError / private mode)
    const throwingStorage: UiStorage = {
      getItem() {
        throw new Error('SecurityError: storage blocked')
      },
      setItem() {
        throw new Error('QuotaExceededError: quota exceeded')
      },
      removeItem() {
        throw new Error('SecurityError: storage blocked')
      },
    }
    const root2 = fakeRoot()
    const listener = vi.fn()
    const ctrlThrow = createUiSettings({ storage: throwingStorage, root: root2 })
    ctrlThrow.subscribe(listener)

    expect(ctrlThrow.get()).toEqual({ theme: 'system', textSize: 'standard' })
    expect(ctrlThrow.setTheme('light')).toBe(true)
    expect(ctrlThrow.setTextSize('xl')).toBe(true)
    expect(ctrlThrow.get()).toEqual({ theme: 'light', textSize: 'xl' })
    expect(root2.attrs.get('data-theme')).toBe('light')
    expect(root2.attrs.get('data-text-size')).toBe('xl')
    expect(listener).toHaveBeenCalledTimes(2)

    expect(ctrlThrow.setTheme('system')).toBe(true)
    expect(ctrlThrow.setTextSize('standard')).toBe(true)
    expect(ctrlThrow.get()).toEqual({ theme: 'system', textSize: 'standard' })
    expect(root2.attrs.has('data-theme')).toBe(false)
    expect(root2.attrs.has('data-text-size')).toBe(false)
  })

  it('applies settings in main.ts before mount without inline scripts and matches docs/ui.md §7 copy', async () => {
    const indexHtml = readFileSync(join(webDir, 'index.html'), 'utf8')
    const scripts = [...indexHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    expect(scripts).toHaveLength(1)
    expect(scripts[0][0]).toContain('src="/src/main.ts"')
    expect(scripts[0][1].trim()).toBe('')

    const mainTs = readFileSync(join(webDir, 'src/main.ts'), 'utf8')
    const initIndex = mainTs.indexOf('initUiSettings()')
    const mountIndex = mainTs.indexOf('mount(App')
    expect(initIndex).toBeGreaterThanOrEqual(0)
    expect(mountIndex).toBeGreaterThan(initIndex)

    const accountSettings = readFileSync(join(webDir, 'src/AccountSettings.svelte'), 'utf8')
    for (const copy of ['テーマ', 'システムに合わせる', 'ライト', 'ダーク', '文字サイズ', '小', '標準', '大', '特大']) {
      expect(accountSettings).toContain(copy)
    }

    const { storage } = fakeStorage({ 'fukulow.ui.theme': 'dark', 'fukulow.ui.text-size': 'l' })
    const root = fakeRoot()
    const ctrl = initUiSettings({ storage, root })
    const adapter = uiSettingsAdapter(ctrl)
    const view = await mount(() => adapter.state)
    expect(view.last).toEqual({ theme: 'dark', textSize: 'l' })
    expect(root.attrs.get('data-theme')).toBe('dark')
    expect(root.attrs.get('data-text-size')).toBe('l')

    adapter.setTheme('light')
    adapter.setTextSize('s')
    await settle()
    expect(view.last).toEqual({ theme: 'light', textSize: 's' })
    expect(root.attrs.get('data-theme')).toBe('light')
    expect(root.attrs.get('data-text-size')).toBe('s')
    await view.unmount()
  })
})
