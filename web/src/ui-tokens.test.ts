import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const webDir = resolve(import.meta.dirname, '..')
const appCss = readFileSync(join(webDir, 'src/app.css'), 'utf8')

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '')
  if (clean.length !== 6) throw new Error(`Expected 6-digit hex, got ${hex}`)
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ]
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex)
  const l2 = relativeLuminance(bgHex)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function extractColorTokens(cssBlock: string): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const m of cssBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    tokens[m[1]] = m[2].toUpperCase()
  }
  return tokens
}

function parseAppThemes(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const darkMatch = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/)
  const darkBlock = darkMatch ? darkMatch[1] : ''
  const lightBlock = darkMatch ? css.slice(0, darkMatch.index) : css
  return {
    light: extractColorTokens(lightBlock),
    dark: extractColorTokens(darkBlock),
  }
}

export function scanComponentStyleViolations(svelteSource: string, file: string): string[] {
  const violations: string[] = []
  const styleMatch = svelteSource.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  if (!styleMatch) return violations
  const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '')

  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/g)) {
    violations.push(`${file}: literal colour "${m[0]}" in component style (use CSS tokens only)`)
  }
  for (const m of css.matchAll(/font-size\s*:\s*([^;]+);/g)) {
    const val = m[1].trim()
    if (!val.startsWith('var(--')) {
      violations.push(`${file}: literal font-size "${val}" in component style (use --font-size-* token)`)
    }
  }
  for (const m of css.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
    const val = m[1].trim()
    if (!val.startsWith('var(--')) {
      violations.push(`${file}: literal border-radius "${val}" in component style (use --radius-* token)`)
    }
  }
  return violations
}

function walkSvelte(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walkSvelte(p, out)
    else if (p.endsWith('.svelte')) out.push(p)
  }
  return out
}

describe('design tokens and WCAG 2.2 AA contrast pairs (docs/ui.md §4)', () => {
  const { light, dark } = parseAppThemes(appCss)

  it('defines every required light and dark token from docs/ui.md §4 in web/src/app.css', () => {
    expect(light).toEqual({
      '--app': '#E9EFED',
      '--navbox': '#F5F8F7',
      '--surface': '#FFFFFF',
      '--bg': '#F6F8F7',
      '--hover': '#E3EBE8',
      '--text': '#15201E',
      '--text2': '#46534F',
      '--muted': '#5F6C68',
      '--border': '#DDE5E2',
      '--border-input': '#7E8C88',
      '--primary': '#0B6B63',
      '--on-primary': '#FFFFFF',
      '--tint': '#DDF0EC',
      '--on-tint': '#0A5650',
      '--link': '#0A5E57',
      '--focus': '#0B6B63',
      '--amber': '#F59E0B',
      '--on-amber': '#3B2300',
      '--mention': '#FFF3D6',
      '--on-mention': '#6B3F00',
      '--danger': '#B42318',
      '--danger-bg': '#FDECEA',
      '--info-bg': '#E6F1F8',
      '--on-info': '#0B4A6F',
    })

    expect(dark).toEqual({
      '--app': '#0A0F0E',
      '--navbox': '#121918',
      '--surface': '#161E1D',
      '--bg': '#0F1514',
      '--hover': '#1A2423',
      '--text': '#E5ECEA',
      '--text2': '#A8B5B1',
      '--muted': '#93A19D',
      '--border': '#26312F',
      '--border-input': '#66736F',
      '--primary': '#3CC4B1',
      '--on-primary': '#04211D',
      '--tint': '#133430',
      '--on-tint': '#9DE6D9',
      '--link': '#6FD9C9',
      '--focus': '#6FD9C9',
      '--amber': '#F5A524',
      '--on-amber': '#3B2300',
      '--mention': '#36290C',
      '--on-mention': '#FCE3A6',
      '--danger': '#F97066',
      '--danger-bg': '#3A1714',
      '--info-bg': '#10283A',
      '--on-info': '#B9DDF5',
    })
  })

  it('satisfies WCAG 2.2 AA contrast (>= 4.5:1 text, >= 3:1 non-text) for all allowed pairs in light and dark', () => {
    for (const [themeName, palette] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const textTokens = ['--text', '--text2', '--muted'] as const
      const bgSurfaces = ['--app', '--navbox', '--surface', '--bg', '--hover', '--tint', '--mention'] as const
      for (const fg of textTokens) {
        for (const bg of bgSurfaces) {
          const ratio = contrastRatio(palette[fg], palette[bg])
          expect(ratio, `${themeName}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
      }

      const onPairs: [string, string][] = [
        ['--on-primary', '--primary'],
        ['--on-tint', '--tint'],
        ['--on-mention', '--mention'],
        ['--on-info', '--info-bg'],
        ['--on-amber', '--amber'],
        ['--danger', '--danger-bg'],
      ]
      for (const [fg, bg] of onPairs) {
        const ratio = contrastRatio(palette[fg], palette[bg])
        expect(ratio, `${themeName}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }

      for (const fg of ['--link', '--primary', '--danger'] as const) {
        for (const bg of ['--surface', '--bg'] as const) {
          const ratio = contrastRatio(palette[fg], palette[bg])
          expect(ratio, `${themeName}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
        }
      }

      for (const control of ['--border-input', '--focus'] as const) {
        for (const bg of ['--surface', '--bg', '--app'] as const) {
          const ratio = contrastRatio(palette[control], palette[bg])
          expect(ratio, `${themeName}: ${control} on ${bg}`).toBeGreaterThanOrEqual(3.0)
        }
      }
    }
  })

  it('rejects disallowed or low-contrast colour pairs (negative)', () => {
    // Disallowed: --amber as text on light --surface
    expect(contrastRatio(light['--amber'], light['--surface'])).toBeLessThan(4.5)
    // Disallowed: --border used as an input boundary on --surface (< 3:1)
    expect(contrastRatio(light['--border'], light['--surface'])).toBeLessThan(3.0)
    // Disallowed: inputs sitting on --hover (--border-input on light --hover is 2.78:1 < 3:1)
    expect(contrastRatio(light['--border-input'], light['--hover'])).toBeLessThan(3.0)
    // Old pre-#205 muted #65726E on --hover (4.35:1 < 4.5:1)
    expect(contrastRatio('#65726E', light['--hover'])).toBeLessThan(4.5)
  })
})

describe('component token-only styles and accessibility structure (docs/ui.md §4, §6)', () => {
  it('all .svelte components in web/src use tokens only (no literal colours, font-sizes or radii)', () => {
    const files = walkSvelte(join(webDir, 'src'))
    expect(files.length).toBeGreaterThan(0)
    const violations = files.flatMap((f) =>
      scanComponentStyleViolations(readFileSync(f, 'utf8'), relative(webDir, f)),
    )
    expect(violations).toEqual([])
  })

  it('detects literal colours, font-sizes and border-radius in component styles (negative)', () => {
    const bad = `<style>
      .x { color: #ff0000; background: rgb(0, 0, 0); font-size: 14px; border-radius: 8px; }
    </style>`
    const violations = scanComponentStyleViolations(bad, 'src/Bad.svelte')
    expect(violations).toHaveLength(4)
    expect(violations[0]).toContain('#ff0000')
    expect(violations[1]).toContain('rgb(')
    expect(violations[2]).toContain('font-size')
    expect(violations[3]).toContain('border-radius')
  })

  it('enforces timeline non-live semantics and a single polite role="status" region across all components', () => {
    const timelineSrc = readFileSync(join(webDir, 'src/Timeline.svelte'), 'utf8')
    expect(timelineSrc).not.toContain('role="log"')
    expect(timelineSrc).not.toContain('aria-live')

    const files = walkSvelte(join(webDir, 'src'))
    const statusRegions = files.flatMap((f) => {
      const template = readFileSync(f, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '')
      return [...template.matchAll(/role="status"/g)].map(() => relative(webDir, f))
    })
    expect(statusRegions).toEqual(['src/App.svelte'])

    const appSrc = readFileSync(join(webDir, 'src/App.svelte'), 'utf8')
    expect(appSrc).toContain('メッセージへ移動')
  })
})
