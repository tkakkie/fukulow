export const UI_SETTINGS_STORAGE_KEYS = Object.freeze({
  theme: 'fukulow.ui.theme',
  textSize: 'fukulow.ui.text-size',
} as const)

export type UiSettingsStorageKey = (typeof UI_SETTINGS_STORAGE_KEYS)[keyof typeof UI_SETTINGS_STORAGE_KEYS]

export type StoredUiTheme = 'light' | 'dark'
export type UiTheme = 'system' | StoredUiTheme

export type StoredUiTextSize = 's' | 'l' | 'xl'
export type UiTextSize = 's' | 'standard' | 'l' | 'xl'

export type UiSettings = {
  readonly theme: UiTheme
  readonly textSize: UiTextSize
}

export type UiStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type UiRootElement = Pick<Element, 'setAttribute' | 'removeAttribute'>

const ALLOWED_KEYS: ReadonlySet<string> = new Set<UiSettingsStorageKey>([
  UI_SETTINGS_STORAGE_KEYS.theme,
  UI_SETTINGS_STORAGE_KEYS.textSize,
])
const STORED_THEMES: ReadonlySet<string> = new Set<StoredUiTheme>(['light', 'dark'])
const ALL_THEMES: ReadonlySet<string> = new Set<UiTheme>(['system', 'light', 'dark'])
const STORED_TEXT_SIZES: ReadonlySet<string> = new Set<StoredUiTextSize>(['s', 'l', 'xl'])
const ALL_TEXT_SIZES: ReadonlySet<string> = new Set<UiTextSize>(['s', 'standard', 'l', 'xl'])

export const DEFAULT_UI_SETTINGS: UiSettings = Object.freeze({
  theme: 'system',
  textSize: 'standard',
})

function defaultStorage(): UiStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function defaultRoot(): UiRootElement | null {
  try {
    return typeof document !== 'undefined' ? document.documentElement : null
  } catch {
    return null
  }
}

function safeGet(storage: UiStorage | null, key: UiSettingsStorageKey): { ok: true; value: string | null } | { ok: false } {
  if (!storage || !ALLOWED_KEYS.has(key)) return { ok: false }
  try {
    return { ok: true, value: storage.getItem(key) }
  } catch {
    return { ok: false }
  }
}

function safeRemove(storage: UiStorage | null, key: UiSettingsStorageKey): void {
  if (!storage || !ALLOWED_KEYS.has(key)) return
  try {
    storage.removeItem(key)
  } catch {
    // Blocked, quota or private-mode error: keep in-memory state working.
  }
}

function safeSet(
  storage: UiStorage | null,
  key: UiSettingsStorageKey,
  value: StoredUiTheme | StoredUiTextSize,
): boolean {
  if (!storage || !ALLOWED_KEYS.has(key)) return false
  const valid =
    key === UI_SETTINGS_STORAGE_KEYS.theme
      ? STORED_THEMES.has(value)
      : key === UI_SETTINGS_STORAGE_KEYS.textSize
        ? STORED_TEXT_SIZES.has(value)
        : false
  if (!valid) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    // Blocked, quota or private-mode error: keep in-memory state working.
    return false
  }
}

/** Reads and validates UI settings from storage; removes unknown values and falls back to defaults on error. */
export function readUiSettings(storage: UiStorage | null = defaultStorage()): UiSettings {
  const themeResult = safeGet(storage, UI_SETTINGS_STORAGE_KEYS.theme)
  let theme: UiTheme = DEFAULT_UI_SETTINGS.theme
  if (themeResult.ok && themeResult.value !== null) {
    if (STORED_THEMES.has(themeResult.value)) {
      theme = themeResult.value as StoredUiTheme
    } else {
      safeRemove(storage, UI_SETTINGS_STORAGE_KEYS.theme)
    }
  }

  const textSizeResult = safeGet(storage, UI_SETTINGS_STORAGE_KEYS.textSize)
  let textSize: UiTextSize = DEFAULT_UI_SETTINGS.textSize
  if (textSizeResult.ok && textSizeResult.value !== null) {
    if (STORED_TEXT_SIZES.has(textSizeResult.value)) {
      textSize = textSizeResult.value as StoredUiTextSize
    } else {
      safeRemove(storage, UI_SETTINGS_STORAGE_KEYS.textSize)
    }
  }

  return Object.freeze({ theme, textSize })
}

/** Applies validated theme and text size attributes to the root element (`<html>`). */
export function applyUiSettings(settings: UiSettings, root: UiRootElement | null = defaultRoot()): void {
  if (!root) return
  try {
    if (STORED_THEMES.has(settings.theme)) {
      root.setAttribute('data-theme', settings.theme)
    } else {
      root.removeAttribute('data-theme')
    }
    if (STORED_TEXT_SIZES.has(settings.textSize)) {
      root.setAttribute('data-text-size', settings.textSize)
    } else {
      root.removeAttribute('data-text-size')
    }
  } catch {
    // Ignore DOM errors in non-browser environments.
  }
}

export type UiSettingsOptions = {
  storage?: UiStorage | null
  root?: UiRootElement | null
}

export function createUiSettings(options: UiSettingsOptions = {}) {
  const resolveStorage = () => ('storage' in options ? (options.storage ?? null) : defaultStorage())
  const resolveRoot = () => ('root' in options ? (options.root ?? null) : defaultRoot())
  let state: UiSettings = readUiSettings(resolveStorage())
  applyUiSettings(state, resolveRoot())
  const listeners = new Set<() => void>()

  function publish(next: UiSettings) {
    const changed = next.theme !== state.theme || next.textSize !== state.textSize
    state = Object.freeze(next)
    applyUiSettings(state, resolveRoot())
    if (changed) {
      for (const listener of listeners) listener()
    }
  }

  return {
    get: (): UiSettings => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setTheme(theme: UiTheme): boolean {
      if (typeof theme !== 'string' || !ALL_THEMES.has(theme)) return false
      const storage = resolveStorage()
      if (theme === 'system') {
        safeRemove(storage, UI_SETTINGS_STORAGE_KEYS.theme)
      } else {
        safeSet(storage, UI_SETTINGS_STORAGE_KEYS.theme, theme)
      }
      publish({ theme, textSize: state.textSize })
      return true
    },
    setTextSize(textSize: UiTextSize): boolean {
      if (typeof textSize !== 'string' || !ALL_TEXT_SIZES.has(textSize)) return false
      const storage = resolveStorage()
      if (textSize === 'standard') {
        safeRemove(storage, UI_SETTINGS_STORAGE_KEYS.textSize)
      } else {
        safeSet(storage, UI_SETTINGS_STORAGE_KEYS.textSize, textSize)
      }
      publish({ theme: state.theme, textSize })
      return true
    },
  }
}

export type UiSettingsController = ReturnType<typeof createUiSettings>

let sharedUiSettings: UiSettingsController | null = null

/** Reads and applies UI settings before mounting, and sets the shared device controller. */
export function initUiSettings(options?: UiSettingsOptions): UiSettingsController {
  sharedUiSettings = createUiSettings(options)
  return sharedUiSettings
}

export function getUiSettings(): UiSettingsController {
  if (!sharedUiSettings) sharedUiSettings = createUiSettings()
  return sharedUiSettings
}
