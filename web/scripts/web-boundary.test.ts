import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scanSource, scanWeb } from './web-boundary.ts'

const uses = (src: string, file = 'src/App.svelte') => scanSource(src, file).map((v) => v.message.split('`')[1])

describe('web boundary: network', () => {
  it('real web/src has no violations', () => {
    expect(scanWeb(resolve(import.meta.dirname, '..'))).toEqual([])
  })

  it('allows network use in the API layer', () => {
    expect(uses('export const f = () => fetch("/x"); new WebSocket("/ws")', 'src/api.ts')).toEqual([])
    expect(uses('new WebSocket("/ws")', 'src/realtime.ts')).toEqual([])
  })

  it('rejects network use elsewhere (negative)', () => {
    expect(uses('fetch("/x")', 'src/auth.ts')).toEqual(['fetch'])
    expect(uses('new XMLHttpRequest()', 'src/auth.ts')).toEqual(['XMLHttpRequest'])
    expect(uses('new WebSocket("/ws")', 'src/auth.ts')).toEqual(['WebSocket'])
    expect(uses('new EventSource("/e")', 'src/auth.ts')).toEqual(['EventSource'])
    expect(uses('window.fetch("/x")', 'src/auth.ts')).toEqual(['fetch'])
    expect(uses('globalThis["fetch"]("/x")', 'src/auth.ts')).toEqual(['fetch'])
    expect(uses('const f = fetch; f("/x")', 'src/auth.ts')).toEqual(['fetch'])
  })

  it('rejects network use in a Svelte script and in the template (negative)', () => {
    expect(uses('<script lang="ts">const r = fetch("/x")</script>')).toEqual(['fetch'])
    expect(uses('<script lang="ts"></script><button onclick={() => fetch("/x")}>x</button>')).toEqual(['fetch'])
  })

  it('does not flag unrelated names, comments, strings or types', () => {
    expect(uses('const fetchFn = 1; const s = "fetch"; // fetch(\n obj.fetch(); type T = typeof fetch', 'src/auth.ts')).toEqual([])
    expect(uses('<script lang="ts">let { fetchFn }: { fetchFn: typeof fetch } = $props()</script><p>fetch</p>')).toEqual([])
  })
})

describe('web boundary: storage', () => {
  it('rejects web storage, IndexedDB and document.cookie outside the helper (negative)', () => {
    expect(uses('localStorage.setItem("token", t)', 'src/auth.ts')).toEqual(['localStorage'])
    expect(uses('window.sessionStorage.getItem("a")', 'src/auth.ts')).toEqual(['sessionStorage'])
    expect(uses('indexedDB.open("db")', 'src/auth.ts')).toEqual(['indexedDB'])
    expect(uses('document.cookie = "s=1"', 'src/auth.ts')).toEqual(['document.cookie'])
    expect(uses('<script>localStorage.x = 1</script>')).toEqual(['localStorage'])
  })

  it('has no file-name exemption until the ui-settings helper exists (negative)', () => {
    expect(uses('localStorage.setItem("theme", "dark")', 'src/ui-settings.ts')).toEqual(['localStorage'])
    expect(uses('fetch("/x")', 'src/ui-settings.ts')).toEqual(['fetch'])
  })

  it('does not allow storage in the API layer (negative)', () => {
    expect(uses('localStorage.x = 1', 'src/api.ts')).toEqual(['localStorage'])
  })
})

describe('web boundary: wrapped and chained owners (negative)', () => {
  const ts = (src: string) => uses(src, 'src/x.ts')
  const sv = (src: string) => uses(`<script lang="ts">${src}</script>`)
  const cases: [string, string, string][] = [
    ['parenthesised cast', '(window as any).fetch("/x")', 'fetch'],
    ['parenthesised cast on globalThis', '(globalThis as any).localStorage.x = 1', 'localStorage'],
    ['non-null assertion', 'window!.fetch("/x")', 'fetch'],
    ['member chain', 'window.document.cookie = "a"', 'document.cookie'],
    ['globalThis member chain', 'globalThis.document.cookie', 'document.cookie'],
    ['angle-bracket cast', '(<any>window).fetch("/x")', 'fetch'],
  ]
  for (const [name, src, use] of cases) {
    it(`${name} in .ts`, () => expect(ts(src)).toEqual([use]))
    it(`${name} in .svelte script`, () => expect(sv(src)).toEqual([use]))
  }
  it('is caught in a .svelte template', () => {
    expect(uses('<script lang="ts"></script><button onclick={() => (window as any).fetch("/x")}>x</button>')).toEqual(['fetch'])
  })
})

describe('web boundary: aliases, computed keys, beacons, workers (#48)', () => {
  const ts = (src: string, file = 'src/x.ts') => uses(src, file)
  const sv = (src: string) => uses(`<script lang="ts">${src}</script>`)
  const cases: [string, string, string][] = [
    ['object alias', 'const w = window; w.fetch("/x")', 'fetch'],
    ['globalThis alias', 'const g = globalThis; g.fetch("/x")', 'fetch'],
    ['self alias', 'const s = self; s.localStorage.x = 1', 'localStorage'],
    ['alias of alias', 'const a = window; const b = a; b.fetch("/x")', 'fetch'],
    ['alias declared after use', 'function f() { return b.fetch("/x") } const b = a; const a = window', 'fetch'],
    ['cast alias', 'const w = window as any; w.sessionStorage.x = 1', 'sessionStorage'],
    ['alias with computed key', 'const w = window; w["fetch"]("/x")', 'fetch'],
    ['document alias', 'const d = document; d.cookie = "a=1"', 'document.cookie'],
    ['navigator.sendBeacon', 'navigator.sendBeacon("/x")', 'navigator.sendBeacon'],
    ['window.navigator.sendBeacon', 'window.navigator.sendBeacon("/x")', 'navigator.sendBeacon'],
    ['navigator alias', 'const n = navigator; n.sendBeacon("/x")', 'navigator.sendBeacon'],
    ['computed concatenation', 'window["local" + "Storage"].x = 1', 'localStorage'],
    ['computed nested concatenation', 'globalThis["f" + ("e" + "tch")]("/x")', 'fetch'],
    ['computed template without substitution', 'window[`fetch`]("/x")', 'fetch'],
    ['computed sendBeacon', 'navigator["send" + "Beacon"]("/x")', 'navigator.sendBeacon'],
    ['new Worker', 'new Worker("/w.js")', 'Worker'],
    ['new SharedWorker', 'new SharedWorker("/w.js")', 'SharedWorker'],
    ['window.Worker', 'new window.Worker("/w.js")', 'Worker'],
  ]
  for (const [name, src, use] of cases) {
    it(`${name} in .ts`, () => expect(ts(src)).toEqual([use]))
    it(`${name} in .svelte script`, () => expect(sv(src)).toEqual([use]))
  }

  it('catches an alias used in a .svelte template', () => {
    expect(uses('<script lang="ts">const w = window</script><button onclick={() => w.fetch("/x")}>x</button>')).toEqual(['fetch'])
  })

  describe('same alias name in different scopes (terminates, fails closed)', () => {
    const src = 'function a() { const w = window } function b() { const w = document }'
    it('terminates and reports nothing for harmless uses (.ts)', () => expect(ts(src)).toEqual([]))
    it('terminates and reports nothing for harmless uses (.svelte)', () => expect(sv(src)).toEqual([]))
    it('still catches a forbidden use through the ambiguous name (.ts)', () => {
      expect(ts(src + ' function c() { w.fetch("/x") }')).toEqual(['fetch'])
      expect(ts(src + ' function c() { w.cookie }')).toEqual(['document.cookie'])
    })
    it('still catches a forbidden use through the ambiguous name (.svelte)', () => {
      expect(sv(src + ' function c() { w.fetch("/x") }')).toEqual(['fetch'])
      expect(sv(src + ' function c() { w.cookie }')).toEqual(['document.cookie'])
    })
    it('three different owners also terminate', () => {
      const three = 'function a() { const w = window } function b() { const w = document } function c() { const w = navigator }'
      expect(ts(three)).toEqual([])
      expect(sv(three)).toEqual([])
    })
  })

  it('regression: already detected forms', () => {
    expect(ts('const f = fetch; f("/x")')).toEqual(['fetch'])
    expect(ts("globalThis['fetch']('/x')")).toEqual(['fetch'])
    expect(sv('const f = fetch; f("/x")')).toEqual(['fetch'])
    expect(sv("globalThis['fetch']('/x')")).toEqual(['fetch'])
  })

  it('allows network, beacons and Workers in the API layer (positive)', () => {
    const src =
      'const w = window; w.fetch("/x"); navigator.sendBeacon("/b"); window["Web" + "Socket"]; new Worker("/w.js"); new SharedWorker("/s.js")'
    expect(ts(src, 'src/api.ts')).toEqual([])
    expect(ts(src, 'src/realtime.ts')).toEqual([])
  })

  it('does not flag ordinary code (positive)', () => {
    const src = [
      'const w = window; w.addEventListener("resize", () => {}); w.location.href',
      'const d = document; d.title = "x"; d.getElementById("a")',
      'const n = navigator; n.language',
      'const k = "fetch"; const o: Record<string, number> = {}; o[k]; o["lo" + "cal"]',
      'const obj = { fetch: 1, Worker: 2 }; obj.fetch; obj["fetch"]',
      'const other = { fetch() {} }; const alias = other; alias.fetch()',
      'let worker: Worker | undefined; type W = SharedWorker; const t: typeof Worker = undefined as never',
      'window[key]; window[key + "x"]',
    ].join('\n')
    expect(ts(src, 'src/auth.ts')).toEqual([])
    expect(sv(src)).toEqual([])
  })
})

describe('web boundary: file extensions', () => {
  const dir = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'wb-'))
    mkdirSync(join(root, 'src'))
    for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c)
    return root
  }
  for (const ext of ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx']) {
    it(`scans .${ext} (negative)`, () => {
      const root = dir({ [`src/x.${ext}`]: 'fetch("/x")' })
      expect(scanWeb(root).map((v) => v.file)).toEqual([`src/x.${ext}`])
    })
  }
  it('skips tests and declarations, scans the rest (positive)', () => {
    const root = dir({
      'src/a.test.ts': 'fetch("/x")',
      'src/a.spec.mts': 'fetch("/x")',
      'src/a.d.ts': 'declare const x: number',
      'src/a.d.mts': 'declare const x: number',
      'src/style.css': 'a { color: red }',
      'src/ok.ts': 'export const a = 1',
    })
    expect(scanWeb(root)).toEqual([])
  })
})

describe('web boundary: Vite worker imports (#60)', () => {
  const ts = (src: string, file = 'src/x.ts') => uses(src, file)
  const sv = (src: string, file = 'src/App.svelte') => uses(`<script lang="ts">${src}</script>`, file)
  const cases: [string, string, string][] = [
    ['?worker import', 'import W from "./w.ts?worker"', '?worker'],
    ['?sharedworker import', 'import W from "./w.ts?sharedworker"', '?sharedworker'],
    ['?worker&inline', 'import W from "./w.ts?worker&inline"', '?worker'],
    ['?worker&url', 'import u from "./w.ts?worker&url"', '?worker'],
    ['query in any order', 'import W from "./w.ts?inline&worker"', '?worker'],
    ['?sharedworker&inline', 'import W from "./w.ts?sharedworker&inline"', '?sharedworker'],
    ['side-effect import', 'import "./w.ts?worker"', '?worker'],
    ['re-export', 'export { default } from "./w.ts?worker"', '?worker'],
    ['export all', 'export * from "./w.ts?worker"', '?worker'],
    ['dynamic import', 'const m = import("./w.ts?worker")', '?worker'],
  ]
  for (const [name, src, use] of cases) {
    it(`${name} is flagged in .ts`, () => expect(ts(src)).toEqual([use]))
    it(`${name} is flagged in .svelte`, () => expect(sv(src)).toEqual([use]))
    it(`${name} passes in the API layer (.ts)`, () => {
      expect(ts(src, 'src/api.ts')).toEqual([])
      expect(ts(src, 'src/realtime.ts')).toEqual([])
    })
  }
  const ordinary = [
    'import a from "./worker.ts"',
    'import a from "./w.ts?raw"',
    'import a from "./w.ts?url&inline"',
    'import a from "./w.ts?workers"',
    'import a from "./w.ts?x=worker"',
    'import a from "./w.ts#worker"',
    'import("./w.ts")',
    'export { a } from "./a"',
    'const s = "./w.ts?worker"',
  ]
  for (const src of ordinary) {
    it(`does not flag \`${src}\``, () => {
      expect(ts(src)).toEqual([])
      expect(sv(src)).toEqual([])
    })
  }
})

describe('web boundary: destructuring (#60)', () => {
  const ts = (src: string, file = 'src/x.ts') => uses(src, file)
  const sv = (src: string, file = 'src/App.svelte') => uses(`<script lang="ts">${src}</script>`, file)
  const cases: [string, string, string[]][] = [
    ['shorthand from window', 'const { fetch } = window', ['fetch']],
    ['renamed from globalThis', 'const { fetch: f } = globalThis', ['fetch']],
    ['storage renamed', 'const { localStorage: s } = globalThis', ['localStorage']],
    ['from self', 'const { sessionStorage } = self', ['sessionStorage']],
    ['cast source', 'const { fetch: f } = window as any', ['fetch']],
    ['alias source', 'const w = window; const { fetch: f } = w', ['fetch']],
    ['string key', 'const { "fetch": f } = window', ['fetch']],
    ['computed constant key', 'const { ["fe" + "tch"]: f } = window', ['fetch']],
    ['default value', 'const { fetch: f = undefined } = window', ['fetch']],
    ['nested', 'const { document: { cookie } } = window', ['document.cookie']],
    ['document cookie', 'const { cookie } = document', ['document.cookie']],
    ['navigator sendBeacon', 'const { sendBeacon: b } = navigator', ['navigator.sendBeacon']],
    ['Worker', 'const { Worker: W } = window', ['Worker']],
    ['assignment shorthand', 'let fetch; ({ fetch } = window)', ['fetch']],
    ['assignment renamed', 'let f; ({ fetch: f } = window)', ['fetch']],
    ['alias via destructuring', 'const { document: d } = window; d.cookie', ['document.cookie']],
    ['from top', 'const { fetch: f } = top', ['fetch']],
    ['from parent', 'const { localStorage: s } = parent', ['localStorage']],
  ]
  for (const [name, src, use] of cases) {
    it(`${name} is flagged in .ts`, () => expect(ts(src)).toEqual(use))
    it(`${name} is flagged in .svelte`, () => expect(sv(src)).toEqual(use))
  }
  it('network destructuring passes in the API layer', () => {
    expect(ts('const { fetch: f } = window; const { sendBeacon } = navigator', 'src/api.ts')).toEqual([])
  })
  it('storage destructuring is flagged even in the API layer', () => {
    expect(ts('const { localStorage: s } = window', 'src/api.ts')).toEqual(['localStorage'])
    expect(sv('const { localStorage: s } = window')).toEqual(['localStorage'])
  })
  it('does not flag destructuring from ordinary objects', () => {
    const src = [
      'const obj = { fetch: 1, localStorage: 2, Worker: 3, cookie: 4 }',
      'const { fetch: a, localStorage: b } = obj',
      'const { Worker: w, cookie } = { Worker: 1, cookie: 2 }',
      'const { x: { fetch: nested } } = { x: obj }',
      'const o = window; const { innerWidth: iw, location: { href } } = o',
      'const { addEventListener, document: dd } = window',
      'const { language, userAgent: ua } = navigator',
      'const { title } = document',
      'let q; ({ fetch: q } = obj)',
      'const { [key]: dyn } = window',
      'const { ...rest } = window',
    ].join('\n')
    expect(ts(src, 'src/auth.ts')).toEqual([])
    expect(sv(src)).toEqual([])
  })
  it('does not flag parameter or $props destructuring', () => {
    const src = 'function f({ fetch: g }: { fetch: () => void }) {} const h = ({ Worker: W }: any) => W'
    expect(ts(src)).toEqual([])
    expect(sv(src)).toEqual([])
    expect(uses('<script lang="ts">let { fetch: f }: { fetch: () => void } = $props()</script>')).toEqual([])
  })
  it('flags destructuring in a .svelte template handler', () => {
    expect(uses('<script lang="ts"></script><button onclick={() => { const { fetch: f } = window }}>x</button>')).toEqual(['fetch'])
  })
})

describe('web boundary: top and parent roots (#60)', () => {
  const ts = (src: string, file = 'src/x.ts') => uses(src, file)
  const sv = (src: string, file = 'src/App.svelte') => uses(`<script lang="ts">${src}</script>`, file)
  const cases: [string, string, string][] = [
    ['top.fetch', 'top.fetch("/x")', 'fetch'],
    ['parent.fetch', 'parent.fetch("/x")', 'fetch'],
    ['top.localStorage', 'top.localStorage.x = 1', 'localStorage'],
    ['parent computed', 'parent["fetch"]("/x")', 'fetch'],
    ['window.parent', 'window.parent.fetch("/x")', 'fetch'],
    ['window.top storage', 'window.top.sessionStorage.x = 1', 'sessionStorage'],
    ['globalThis.parent.parent', 'globalThis.parent.parent.fetch("/x")', 'fetch'],
    ['parent.document.cookie', 'parent.document.cookie', 'document.cookie'],
    ['alias of top', 'const t = top; t.fetch("/x")', 'fetch'],
    ['alias of window.parent', 'const p = window.parent; p.indexedDB', 'indexedDB'],
    ['cast', '(window.parent as any).fetch("/x")', 'fetch'],
  ]
  for (const [name, src, use] of cases) {
    it(`${name} in .ts`, () => expect(ts(src)).toEqual([use]))
    it(`${name} in .svelte`, () => expect(sv(src)).toEqual([use]))
  }
  it('passes network use via top/parent in the API layer', () => {
    expect(ts('top.fetch("/x"); window.parent.fetch("/y")', 'src/api.ts')).toEqual([])
  })
  it('does not flag ordinary uses', () => {
    const src = 'window.parent.postMessage("x", "*"); top.location.href; const p = window.parent; p.document.title; parent.length; window.top === window'
    expect(ts(src)).toEqual([])
    expect(sv(src)).toEqual([])
  })
  it('states the known limits: frames[n] is not tracked', () => {
    expect(ts('frames[0].fetch("/x")')).toEqual([])
    expect(sv('frames[0].fetch("/x")')).toEqual([])
  })
})

describe('web boundary: alias scope limit (#60)', () => {
  const src = 'const w = window; function f(w: { fetch(u: string): void }) { w.fetch("/x") }'
  it('pins the false positive: a parameter shadowing an alias name is flagged (.ts)', () => {
    expect(uses(src, 'src/x.ts')).toEqual(['fetch'])
  })
  it('pins the false positive: a parameter shadowing an alias name is flagged (.svelte)', () => {
    expect(uses(`<script lang="ts">${src}</script>`)).toEqual(['fetch'])
  })
  it('does not flag the same parameter without the alias', () => {
    const plain = 'function f(w: { fetch(u: string): void }) { w.fetch("/x") }'
    expect(uses(plain, 'src/x.ts')).toEqual([])
    expect(uses(`<script lang="ts">${plain}</script>`)).toEqual([])
  })
})
