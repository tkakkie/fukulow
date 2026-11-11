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

const CSS_NAMED_COLOURS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen',
  'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray',
  'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey',
  'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite',
  'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred',
  'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue',
  'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink',
  'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen',
  'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin',
  'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid',
  'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru',
  'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue',
  'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue',
  'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal',
  'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
])

const STRICT_TOKEN_VAR = /^var\(--[a-z0-9-]+\)$/

function extractTemplate(svelteSource: string): string {
  return svelteSource
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
}

export function scanComponentStyleViolations(svelteSource: string, file: string): string[] {
  const violations: string[] = []

  // 1. Disallow inline style= attributes and style: directives in templates
  const template = extractTemplate(svelteSource)
  for (const m of template.matchAll(/\bstyle\s*=|\bstyle:[a-zA-Z-]+/g)) {
    violations.push(`${file}: inline style "${m[0]}" in template (use component CSS tokens only)`)
  }

  // 2. Scan every <style> block in the component
  for (const styleMatch of svelteSource.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '')

    // Hex colours and CSS colour functions (rgb/rgba/hsl/hsla/hwb/lab/lch/oklab/oklch/color/color-mix/light-dark)
    for (const m of css.matchAll(
      /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\(/gi,
    )) {
      violations.push(`${file}: literal colour "${m[0]}" in component style (use CSS tokens only)`)
    }

    // var(--token, fallback) fallbacks
    for (const m of css.matchAll(/\bvar\(\s*--[a-zA-Z0-9-]+\s*,[^)]*\)/g)) {
      violations.push(`${file}: var() fallback "${m[0]}" in component style (use defined token without fallback)`)
    }

    // Inspect property declarations for named colours, font shorthand, font-size, and border-radius / per-corner radii
    for (const decl of css.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+);/g)) {
      const prop = decl[1].toLowerCase()
      const val = decl[2].trim()

      // Named colours in any CSS declaration value
      const withoutVars = val.replace(/var\([^)]*\)/g, '')
      for (const word of withoutVars.matchAll(/\b([a-zA-Z]+)\b/g)) {
        const lower = word[1].toLowerCase()
        if (CSS_NAMED_COLOURS.has(lower)) {
          violations.push(`${file}: named colour "${word[1]}" in "${prop}: ${val}" (use CSS tokens only)`)
        }
      }

      if (prop === 'font') {
        violations.push(`${file}: font shorthand "font: ${val}" in component style (use --font-* tokens)`)
      }

      if (prop === 'font-size' && !STRICT_TOKEN_VAR.test(val)) {
        violations.push(`${file}: literal font-size "${val}" in component style (use --font-size-* token)`)
      }

      if (/^border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius$/.test(prop)) {
        const parts = val.split(/\s+/).filter(Boolean)
        if (parts.length === 0 || !parts.every((p) => STRICT_TOKEN_VAR.test(p))) {
          violations.push(`${file}: literal ${prop} "${val}" in component style (use --radius-* token)`)
        }
      }
    }
  }

  return violations
}

export function scanLiveRegions(svelteSource: string, file: string): {
  statusRoles: string[]
  logRoles: string[]
  ariaLive: string[]
  outputElements: string[]
} {
  const template = extractTemplate(svelteSource)
  const statusRoles = [
    ...template.matchAll(/\brole\s*=\s*(?:"status"|'status'|\{[^}]*\bstatus\b[^}]*\})/g),
  ].map((m) => `${file}:${m[0]}`)
  const logRoles = [
    ...template.matchAll(/\brole\s*=\s*(?:"log"|'log'|\{[^}]*\blog\b[^}]*\})/g),
  ].map((m) => `${file}:${m[0]}`)
  const ariaLive = [...template.matchAll(/\baria-live\b/g)].map((m) => `${file}:${m[0]}`)
  const outputElements = [...template.matchAll(/<output\b/gi)].map((m) => `${file}:${m[0]}`)
  return { statusRoles, logRoles, ariaLive, outputElements }
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
    const bad = `
      <div style="color: var(--text)" style:padding="4px"></div>
      <style>
        .x {
          color: #ff0000;
          background: rgb(0, 0, 0);
          border-color: red;
          outline-color: oklch(0.7 0.1 180);
          box-shadow: 0 0 4px color-mix(in srgb, var(--text), white);
          font: 14px sans-serif;
          font-size: 14px;
          border-radius: 8px;
          border-top-left-radius: 6px;
        }
      </style>
      <style>
        .second-block {
          font-size: var(--font-size-14, 14px);
          border-radius: var(--radius-8, 8px);
          color: white;
        }
      </style>
    `
    const violations = scanComponentStyleViolations(bad, 'src/Bad.svelte')
    expect(violations.some((v) => v.includes('inline style "style="'))).toBe(true)
    expect(violations.some((v) => v.includes('inline style "style:padding"'))).toBe(true)
    expect(violations.some((v) => v.includes('#ff0000'))).toBe(true)
    expect(violations.some((v) => v.includes('rgb('))).toBe(true)
    expect(violations.some((v) => v.includes('named colour "red"'))).toBe(true)
    expect(violations.some((v) => v.includes('oklch('))).toBe(true)
    expect(violations.some((v) => v.includes('color-mix('))).toBe(true)
    expect(violations.some((v) => v.includes('font shorthand'))).toBe(true)
    expect(violations.some((v) => v.includes('literal font-size "14px"'))).toBe(true)
    expect(violations.some((v) => v.includes('literal border-radius "8px"'))).toBe(true)
    expect(violations.some((v) => v.includes('literal border-top-left-radius "6px"'))).toBe(true)
    expect(violations.some((v) => v.includes('var() fallback "var(--font-size-14, 14px)"'))).toBe(true)
    expect(violations.some((v) => v.includes('var() fallback "var(--radius-8, 8px)"'))).toBe(true)
    expect(violations.some((v) => v.includes('named colour "white"'))).toBe(true)
  })

  it('enforces timeline non-live semantics and a single polite role="status" region across all components', () => {
    const files = walkSvelte(join(webDir, 'src'))
    const allLive = files.map((f) => scanLiveRegions(readFileSync(f, 'utf8'), relative(webDir, f)))

    expect(allLive.flatMap((x) => x.statusRoles)).toEqual(['src/App.svelte:role="status"'])
    expect(allLive.flatMap((x) => x.ariaLive)).toEqual(['src/App.svelte:aria-live'])
    expect(allLive.flatMap((x) => x.logRoles)).toEqual([])
    expect(allLive.flatMap((x) => x.outputElements)).toEqual([])

    // Negative check for dynamic role={'status'}, role="log", <output>, and aria-live
    const badLive = scanLiveRegions(
      `<div role={'status'} aria-live="polite"></div><ul role="log"></ul><output>ok</output>`,
      'src/BadLive.svelte',
    )
    expect(badLive.statusRoles).toHaveLength(1)
    expect(badLive.ariaLive).toHaveLength(1)
    expect(badLive.logRoles).toHaveLength(1)
    expect(badLive.outputElements).toHaveLength(1)
  })
})
