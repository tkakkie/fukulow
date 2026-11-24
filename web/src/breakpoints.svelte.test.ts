import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flushSync, mount, tick, unmount } from 'svelte'
import { MediaQuery } from 'svelte/reactivity'
import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, settle } from './adapter-test-helpers.svelte'
import { BREAKPOINT_QUERIES, resolveViewportClass } from './breakpoints'
import { channelsAdapter } from './channels.svelte'
import type { SkipLinkTargetId } from './focus-management'
import { createNavigation, type NavigationBrowser } from './navigation'
import { repliesAdapter } from './replies.svelte'
import { createSession } from './session'
import { installMiniDom, MiniDomEvent, queryAll } from './svelte-dom-test-helpers'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import Workspace from './Workspace.svelte'

const dom = installMiniDom()

function collectStyleFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectStyleFiles(full))
    else if (entry.name.endsWith('.svelte') || entry.name.endsWith('.css')) out.push(full)
  }
  return out
}

function findWidthMediaRules(source: string): string[] {
  const rules: string[] = []
  for (const match of source.matchAll(/@media\b([^{]*)\{/g)) {
    if (/\b(?:min-|max-)?width\b/i.test(match[1]!)) {
      rules.push(match[0])
    }
  }
  return rules
}

function findInvalidWidthMediaRules(source: string, allowedQueries: readonly string[]): string[] {
  const allowedRules = new Set(allowedQueries.map((q) => `@media ${q} {`))
  return findWidthMediaRules(source).filter((rule) => !allowedRules.has(rule))
}

describe('breakpoints and MediaQuery (docs/ui.md §3)', () => {
  it('matches phone, tablet and desktop classes at exact 599/599.5/600/959/959.5/960px boundaries and updates only on crossing', () => {
    const phone = new MediaQuery(BREAKPOINT_QUERIES.phone, false)
    const tablet = new MediaQuery(BREAKPOINT_QUERIES.tablet, false)
    const desktop = new MediaQuery(BREAKPOINT_QUERIES.desktop, true)
    const desktopOverlay = new MediaQuery(BREAKPOINT_QUERIES.desktopOverlay, false)

    let evaluations = 0
    let current = resolveViewportClass({ phone: phone.current, tablet: tablet.current, desktop: desktop.current })
    const cleanup = $effect.root(() => {
      $effect(() => {
        current = resolveViewportClass({
          phone: phone.current,
          tablet: tablet.current,
          desktop: desktop.current,
        })
        evaluations++
      })
    })
    try {
      flushSync()
      expect(current).toBe('desktop')
      expect(desktopOverlay.current).toBe(false)
      expect(evaluations).toBe(1)

      // Resizing within desktop (1280 -> 1279.5 -> 960) crosses no primary breakpoint
      dom.win.innerWidth = 1279.5
      flushSync()
      expect(desktopOverlay.current).toBe(true)
      expect(current).toBe('desktop')
      expect(evaluations).toBe(1)

      dom.win.innerWidth = 960
      flushSync()
      expect({ phone: phone.current, tablet: tablet.current, desktop: desktop.current, desktopOverlay: desktopOverlay.current }).toEqual({
        phone: false,
        tablet: false,
        desktop: true,
        desktopOverlay: true,
      })
      expect(current).toBe('desktop')
      expect(evaluations).toBe(1)

      // 960 -> 959.5 (fractional zoom width) crosses into tablet with no gap
      dom.win.innerWidth = 959.5
      flushSync()
      expect({ phone: phone.current, tablet: tablet.current, desktop: desktop.current, desktopOverlay: desktopOverlay.current }).toEqual({
        phone: false,
        tablet: true,
        desktop: false,
        desktopOverlay: false,
      })
      expect(current).toBe('tablet')
      expect(evaluations).toBe(2)

      // 959.5 -> 959 -> 600 stays in tablet without re-evaluating
      dom.win.innerWidth = 959
      flushSync()
      expect(current).toBe('tablet')
      expect(evaluations).toBe(2)

      dom.win.innerWidth = 600
      flushSync()
      expect({ phone: phone.current, tablet: tablet.current, desktop: desktop.current }).toEqual({
        phone: false,
        tablet: true,
        desktop: false,
      })
      expect(current).toBe('tablet')
      expect(evaluations).toBe(2)

      // 600 -> 599.5 (fractional zoom width) crosses into phone with no gap
      dom.win.innerWidth = 599.5
      flushSync()
      expect({ phone: phone.current, tablet: tablet.current, desktop: desktop.current }).toEqual({
        phone: true,
        tablet: false,
        desktop: false,
      })
      expect(current).toBe('phone')
      expect(evaluations).toBe(3)

      // 599.5 -> 599 -> 320 stays in phone without re-evaluating
      dom.win.innerWidth = 599
      flushSync()
      expect({ phone: phone.current, tablet: tablet.current, desktop: desktop.current }).toEqual({
        phone: true,
        tablet: false,
        desktop: false,
      })
      expect(current).toBe('phone')
      expect(evaluations).toBe(3)

      dom.win.innerWidth = 320
      flushSync()
      expect(current).toBe('phone')
      expect(evaluations).toBe(3)
    } finally {
      cleanup()
    }
  })

  it('requires every width @media rule in web/src to match BREAKPOINT_QUERIES exactly and rejects extra conditions', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url))
    const allowedQueries = Object.values(BREAKPOINT_QUERIES)
    const seenRules = new Set<string>()
    const invalid: string[] = []

    for (const file of collectStyleFiles(srcDir)) {
      const content = readFileSync(file, 'utf8')
      for (const rule of findWidthMediaRules(content)) seenRules.add(rule)
      for (const bad of findInvalidWidthMediaRules(content, allowedQueries)) {
        invalid.push(`${file}: ${bad}`)
      }
    }

    expect(invalid).toEqual([])
    expect(seenRules.has(`@media ${BREAKPOINT_QUERIES.phone} {`)).toBe(true)
    expect(seenRules.has(`@media ${BREAKPOINT_QUERIES.tablet} {`)).toBe(true)
    expect(seenRules.has(`@media ${BREAKPOINT_QUERIES.desktopOverlay} {`)).toBe(true)

    const workspaceSrc = readFileSync(new URL('./Workspace.svelte', import.meta.url), 'utf8')
    expect(workspaceSrc).not.toContain('bind:innerWidth')
    expect(workspaceSrc).not.toContain('window.innerWidth')

    const navigationSrc = readFileSync(new URL('./navigation.ts', import.meta.url), 'utf8')
    expect(navigationSrc).not.toContain('matchMedia')
    expect(navigationSrc).not.toContain('innerWidth')

    // Negative cases: extra condition, legacy syntax, unknown width query, or extra whitespace must fail
    const badSample = [
      `@media ${BREAKPOINT_QUERIES.phone} and (orientation: landscape) { .a {} }`,
      `@media (max-width: 599px) { .b {} }`,
      `@media (width >= 1024px) { .c {} }`,
      `@media ${BREAKPOINT_QUERIES.phone}  { .d {} }`,
      `@media (prefers-reduced-motion: reduce) { .e {} }`,
      `@media ${BREAKPOINT_QUERIES.phone} { .f {} }`,
    ].join('\n')
    expect(findInvalidWidthMediaRules(badSample, allowedQueries)).toEqual([
      `@media ${BREAKPOINT_QUERIES.phone} and (orientation: landscape) {`,
      `@media (max-width: 599px) {`,
      `@media (width >= 1024px) {`,
      `@media ${BREAKPOINT_QUERIES.phone}  {`,
    ])
  })

  it('preserves drawer state, panel back control, Escape order, skip target and focus restoration when crossing breakpoints', async () => {
    dom.win.innerWidth = 768
    const net = fakeNetwork()
    const historyGeneration = '00000000-0000-4000-8000-000000000836'
    const raw = createSession({ organizationId: 'org-1', selfId: 'me', onEnded: vi.fn(), ...net.options('me') })
    net.socket.onReady()
    net.lists[0]!.resolve(ok({ history_generation: historyGeneration, channels: [channel('c1', 'general')] }))
    net.pages.c1 = ok({ history_generation: historyGeneration, as_of_seq: 0, messages: [], has_more: false })
    net.timelines.c1 = ok({ history_generation: historyGeneration, as_of_seq: 0, items: [], has_more: false })
    net.topicLists.c1 = ok({ history_generation: historyGeneration, as_of_seq: 0, topics: [], has_more: false })

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(s: unknown, _: string, url?: string | URL | null) { historyState = s; href = String(url) },
        replaceState(s: unknown, _: string, url?: string | URL | null) { historyState = s; href = String(url) },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)

    let boundSkipTargetId: SkipLinkTargetId = 'main-content'
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        selectedOrganizationId: 'org-1',
        get skipTargetId() { return boundSkipTargetId },
        set skipTargetId(v: SkipLinkTargetId) { boundSkipTargetId = v },
        session: {
          channels: channelsAdapter(raw.channels),
          sync: syncAdapter(raw.sync),
          topics: (id: string) => topicsAdapter(raw.topics, id),
          replies: (id: string) => repliesAdapter(raw.replies, id),
          close: () => raw.close(),
        },
      },
    })

    const dispatchEscape = () => {
      const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc.key = 'Escape'
      dom.win.dispatchEvent(esc)
    }

    try {
      await settle()
      flushSync()

      const workspace = host.querySelector('.workspace')!
      const railChannelBtn = queryAll(host, '.rail button').find((b) => b.getAttribute('aria-label') === 'チャンネル一覧')!
      const panelToggleBtn = queryAll(host, '#main-content button').find((b) => b.getAttribute('aria-label') === 'パネルを開く(⌘.)')!
      const mainComposer = host.querySelector('#main-content textarea')!
      const findPanelBackBtn = () =>
        queryAll(host, '#panel-content button').find((b) => b.getAttribute('aria-label') === '前の表示に戻る')

      // 1. Tablet (768px): open panel via header button (recorded as opener), then open drawer
      panelToggleBtn.click()
      flushSync()
      await tick()
      expect(workspace.getAttribute('data-panel-open')).toBe('true')

      railChannelBtn.click()
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('true')
      expect(railChannelBtn.getAttribute('aria-expanded')).toBe('true')
      expect(boundSkipTargetId).toBe('main-content')
      expect(findPanelBackBtn()).toBeUndefined()

      // 2. Cross to phone (599.5px): drawer state is kept, panel shows phone back button and panel skip target
      dom.win.innerWidth = 599.5
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('true')
      expect(railChannelBtn.getAttribute('aria-expanded')).toBe('true')
      expect(workspace.getAttribute('data-panel-open')).toBe('true')
      expect(workspace.getAttribute('data-mobile-level')).toBe('panel')
      expect(boundSkipTargetId).toBe('panel-content')
      expect(findPanelBackBtn()).toBeDefined()

      // 3. Cross back to tablet (600px): skip target returns to main-content, back button hides, drawer state stays true
      dom.win.innerWidth = 600
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('true')
      expect(boundSkipTargetId).toBe('main-content')
      expect(findPanelBackBtn()).toBeUndefined()

      // 4. Cross to desktop (960px): drawer state is kept, rail button still toggles drawerOpen at desktop width
      dom.win.innerWidth = 960
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('true')
      expect(railChannelBtn.getAttribute('aria-expanded')).toBe('true')

      railChannelBtn.click()
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('false')
      railChannelBtn.click()
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('true')

      // 5. First Escape closes the drawer; panel stays open
      dispatchEscape()
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('false')
      expect(railChannelBtn.getAttribute('aria-expanded')).toBe('false')
      expect(workspace.getAttribute('data-panel-open')).toBe('true')

      // 6. Second Escape closes the panel and restores focus to the panel opener (docs/ui.md §2/§6)
      dispatchEscape()
      flushSync()
      await tick()
      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(host.querySelector('#panel-content')).toBeNull()
      expect(dom.doc.activeElement).toBe(panelToggleBtn)

      // 7. When the opener is gone after crossing breakpoints, Escape falls back to the main Composer
      const transientOpener = dom.doc.createElement('button')
      dom.doc.body.appendChild(transientOpener)
      navigation.navigate({ type: 'tab', tab: 'topics' }, transientOpener as unknown as HTMLElement)
      flushSync()
      await tick()
      expect(workspace.getAttribute('data-panel-open')).toBe('true')

      transientOpener.remove()
      dom.win.innerWidth = 600
      flushSync()
      dispatchEscape()
      flushSync()
      await tick()
      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(dom.doc.activeElement).toBe(mainComposer)
    } finally {
      navigation.destroy()
      await unmount(instance)
      raw.close()
    }
  })
})
