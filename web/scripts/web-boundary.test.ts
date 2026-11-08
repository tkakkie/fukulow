import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
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
    expect(uses('<button onclick={() => fetch("/x")}>x</button>')).toEqual(['fetch'])
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

  it('allows the named UI settings helper', () => {
    expect(uses('localStorage.setItem("theme", "dark")', 'src/ui-settings.ts')).toEqual([])
  })

  it('does not allow network use in the storage helper (negative)', () => {
    expect(uses('fetch("/x")', 'src/ui-settings.ts')).toEqual(['fetch'])
  })
})
