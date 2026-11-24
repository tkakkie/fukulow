import { readFileSync } from 'node:fs'
import { flushSync, mount, unmount } from 'svelte'
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

describe('breakpoints and MediaQuery (docs/ui.md §3)', () => {
  it('matches phone, tablet and desktop classes at exact 599/600/959/960px boundaries and updates only on crossing', () => {
    const phone = new MediaQuery(BREAKPOINT_QUERIES.phone, false)
    const tablet = new MediaQuery(BREAKPOINT_QUERIES.tablet, false)
    const desktop = new MediaQuery(BREAKPOINT_QUERIES.desktop, true)

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
      expect(evaluations).toBe(1)

      // Resizing within desktop (1280 -> 960) crosses no breakpoint and does not re-evaluate
      dom.win.innerWidth = 960
      flushSync()
      expect({ phone: phone.current, tablet: tablet.current, desktop: desktop.current }).toEqual({
        phone: false,
        tablet: false,
        desktop: true,
      })
      expect(current).toBe('desktop')
      expect(evaluations).toBe(1)

      // 960 -> 959 crosses into tablet
      dom.win.innerWidth = 959
      flushSync()
      expect({ phone: phone.current, tablet: tablet.current, desktop: desktop.current }).toEqual({
        phone: false,
        tablet: true,
        desktop: false,
      })
      expect(current).toBe('tablet')
      expect(evaluations).toBe(2)

      // 959 -> 600 stays in tablet without re-evaluating
      dom.win.innerWidth = 600
      flushSync()
      expect({ phone: phone.current, tablet: tablet.current, desktop: desktop.current }).toEqual({
        phone: false,
        tablet: true,
        desktop: false,
      })
      expect(current).toBe('tablet')
      expect(evaluations).toBe(2)

      // 600 -> 599 crosses into phone
      dom.win.innerWidth = 599
      flushSync()
      expect({ phone: phone.current, tablet: tablet.current, desktop: desktop.current }).toEqual({
        phone: true,
        tablet: false,
        desktop: false,
      })
      expect(current).toBe('phone')
      expect(evaluations).toBe(3)

      // 599 -> 320 stays in phone without re-evaluating
      dom.win.innerWidth = 320
      flushSync()
      expect(current).toBe('phone')
      expect(evaluations).toBe(3)
    } finally {
      cleanup()
    }
  })

  it('keeps shared MediaQuery strings identical to Workspace CSS @media rules', () => {
    const workspaceSrc = readFileSync(new URL('./Workspace.svelte', import.meta.url), 'utf8')
    expect(workspaceSrc).toContain(`@media ${BREAKPOINT_QUERIES.phone}`)
    expect(workspaceSrc).toContain(`@media ${BREAKPOINT_QUERIES.tablet}`)
    expect(workspaceSrc).not.toContain('bind:innerWidth')
    expect(workspaceSrc).not.toContain('window.innerWidth')
  })

  it('navigation uses matchMedia(BREAKPOINT_QUERIES.phone) at the 599/600px boundary when intent.phone is omitted', () => {
    const makeNav = (width: number) => {
      dom.win.innerWidth = width
      let href = '/o/org/c/c1?panel=topics'
      let state: unknown = null
      const browser: NavigationBrowser = {
        location: { get href() { return href } } as Location,
        history: {
          get state() { return state },
          pushState(s: unknown, _: string, url?: string | URL | null) { state = s; href = String(url) },
          replaceState(s: unknown, _: string, url?: string | URL | null) { state = s; href = String(url) },
        } as History,
        matchMedia: (q: string) => dom.win.matchMedia(q) as unknown as MediaQueryList,
        addEventListener: () => {},
        removeEventListener: () => {},
      }
      return createNavigation(browser)
    }

    const phoneNav = makeNav(599)
    phoneNav.navigate({ type: 'topic', topicId: 't1' })
    expect(phoneNav.get().target?.panel).toBeNull()
    phoneNav.destroy()

    const tabletNav = makeNav(600)
    tabletNav.navigate({ type: 'topic', topicId: 't1' })
    expect(tabletNav.get().target?.panel).toBe('topics')
    tabletNav.destroy()
  })

  it('updates drawer, panel back control, Escape handling and skip target when crossing breakpoints while drawer and panel are open', async () => {
    dom.win.innerWidth = 768
    const net = fakeNetwork()
    const historyGeneration = '00000000-0000-4000-8000-000000000836'
    const raw = createSession({ organizationId: 'org-1', selfId: 'me', onEnded: vi.fn(), ...net.options('me') })
    net.socket.onReady()
    net.lists[0]!.resolve(ok({ history_generation: historyGeneration, channels: [channel('c1', 'general')] }))
    net.pages.c1 = ok({ history_generation: historyGeneration, as_of_seq: 0, messages: [], has_more: false })
    net.timelines.c1 = ok({ history_generation: historyGeneration, as_of_seq: 0, items: [], has_more: false })
    net.topicLists.c1 = ok({ history_generation: historyGeneration, as_of_seq: 0, topics: [], has_more: false })

    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(s: unknown, _: string, url?: string | URL | null) { historyState = s; href = String(url) },
        replaceState(s: unknown, _: string, url?: string | URL | null) { historyState = s; href = String(url) },
      } as History,
      matchMedia: (q: string) => dom.win.matchMedia(q) as unknown as MediaQueryList,
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

    try {
      await settle()
      flushSync()

      const workspace = host.querySelector('.workspace')!
      const railChannelBtn = queryAll(host, '.rail button').find((b) => b.getAttribute('aria-label') === 'チャンネル一覧')!
      const findPanelBackBtn = () =>
        queryAll(host, '#panel-content button').find((b) => b.getAttribute('aria-label') === '前の表示に戻る')

      // 1. Tablet (768px): open drawer while panel is open
      railChannelBtn.click()
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('true')
      expect(railChannelBtn.getAttribute('aria-expanded')).toBe('true')
      expect(boundSkipTargetId).toBe('main-content')
      expect(findPanelBackBtn()).toBeUndefined()

      // 2. Cross to phone (599px): drawer closes, panel stays open with phone back button and panel skip target
      dom.win.innerWidth = 599
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('false')
      expect(railChannelBtn.getAttribute('aria-expanded')).toBe('false')
      expect(workspace.getAttribute('data-panel-open')).toBe('true')
      expect(workspace.getAttribute('data-mobile-level')).toBe('panel')
      expect(boundSkipTargetId).toBe('panel-content')
      expect(findPanelBackBtn()).toBeDefined()

      // 3. Cross back to tablet (600px): skip target returns to main-content, back button hides, drawer stays closed
      dom.win.innerWidth = 600
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('false')
      expect(boundSkipTargetId).toBe('main-content')
      expect(findPanelBackBtn()).toBeUndefined()

      // 4. Open drawer on tablet, then cross to desktop (960px): drawer closes and Escape immediately closes the panel
      railChannelBtn.click()
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('true')

      dom.win.innerWidth = 960
      flushSync()
      expect(workspace.getAttribute('data-drawer-open')).toBe('false')
      expect(railChannelBtn.getAttribute('aria-expanded')).toBe('false')

      const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      esc.key = 'Escape'
      dom.win.dispatchEvent(esc)
      flushSync()
      expect(workspace.getAttribute('data-panel-open')).toBe('false')
      expect(host.querySelector('#panel-content')).toBeNull()
    } finally {
      navigation.destroy()
      await unmount(instance)
      raw.close()
    }
  })
})
