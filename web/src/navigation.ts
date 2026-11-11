import { parseNavigation, serializeNavigation, type NavigationTarget, type PanelTab } from './navigation-url'

export type NavigationIntent =
  | { type: 'channel'; organizationId: string; channelId: string }
  | { type: 'topic'; topicId: string; phone?: boolean }
  | { type: 'topic-back' }
  | { type: 'tab'; tab: PanelTab }
  | { type: 'reply'; messageId: string }
  | { type: 'reply-back' }
  | { type: 'close' }
  | { type: 'list' }
export type NavigationFocus = 'composer' | 'topic-summary' | 'heading' | 'tab' | 'reply-composer' | 'opener' | 'list'
export type NavigationSnapshot = { target: NavigationTarget | null; previousTab: PanelTab | null; focus: NavigationFocus; revision: number }
export type NavigationBrowser = Pick<Window, 'location' | 'history' | 'innerWidth' | 'addEventListener' | 'removeEventListener'>

/** Owns History effects. Components/adapters only read snapshots and forward intents. */
export function createNavigation(browser: NavigationBrowser = window) {
  let snapshot: NavigationSnapshot = { target: parseNavigation(browser.location.href), previousTab: null, focus: 'composer', revision: 0 }
  let opener: HTMLElement | null = null
  let returningTopicId: string | null = null
  const listeners = new Set<() => void>()
  const publish = (target: NavigationTarget | null, focus: NavigationFocus, previousTab: PanelTab | null = null) => {
    snapshot = { target, focus, previousTab, revision: snapshot.revision + 1 }
    listeners.forEach(listener => listener())
  }
  const pop = () => {
    const next = parseNavigation(browser.location.href)
    const old = snapshot.target
    if (old?.topicId && !next?.topicId) returningTopicId = old.topicId
    const focus: NavigationFocus = !next?.channelId ? 'list'
      : next.channelId === old?.channelId && old?.topicId && !next?.topicId ? 'topic-summary'
      : next?.channelId !== old?.channelId || next?.topicId !== old?.topicId ? 'composer'
      : !next.panel ? 'opener' : next.panel.startsWith('reply:') ? 'reply-composer'
      : old?.panel ? 'tab' : 'heading'
    const state = browser.history.state as { navigationPreviousTab?: PanelTab } | null
    const tab = state?.navigationPreviousTab
    publish(next, focus, tab === 'topics' || tab === 'overview' || tab === 'members' ? tab : null)
  }
  browser.addEventListener('popstate', pop)
  return {
    get: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    initialize(target: NavigationTarget) {
      if (snapshot.target?.organizationId === target.organizationId) return
      browser.history.replaceState(null, '', serializeNavigation(target))
      publish(target, 'composer')
    },
    getOpener: () => opener,
    getReturningTopicId: () => returningTopicId,
    navigate(intent: NavigationIntent, invoker?: HTMLElement | null) {
      const old = snapshot.target
      if ((intent.type === 'tab' && !old?.panel) || (intent.type === 'reply' && !old?.panel?.startsWith('reply:'))) opener = invoker ?? null
      if (intent.type === 'topic-back') returningTopicId = old?.topicId ?? null
      if (!old && intent.type !== 'channel') return
      let target: NavigationTarget = old ? { ...old } : { organizationId: '', channelId: null, topicId: null, panel: null }
      if (!target.channelId && intent.type !== 'channel' && intent.type !== 'list') return
      let method: 'pushState' | 'replaceState' = 'replaceState'
      let focus: NavigationFocus = 'composer'
      let previousTab = snapshot.previousTab
      switch (intent.type) {
        case 'channel': target = { organizationId: intent.organizationId, channelId: intent.channelId, topicId: null, panel: old?.panel?.startsWith('reply:') ? null : old?.panel ?? null }; method = 'pushState'; previousTab = null; break
        case 'topic': target.topicId = intent.topicId; if (intent.phone ?? browser.innerWidth < 600) { target.panel = null; previousTab = null }; method = 'pushState'; break
        case 'topic-back': target.topicId = null; focus = 'topic-summary'; break
        case 'tab': method = target.panel ? 'replaceState' : 'pushState'; focus = target.panel ? 'tab' : 'heading'; target.panel = intent.tab; previousTab = null; break
        case 'reply': method = target.panel?.startsWith('reply:') ? 'replaceState' : 'pushState'; if (target.panel && !target.panel.startsWith('reply:')) previousTab = target.panel as PanelTab; target.panel = `reply:${intent.messageId}`; focus = 'reply-composer'; break
        case 'reply-back': target.panel = previousTab; previousTab = null; focus = target.panel ? 'tab' : 'opener'; break
        case 'close': target.panel = null; previousTab = null; focus = 'opener'; break
        case 'list': target.channelId = null; target.topicId = null; target.panel = null; previousTab = null; focus = 'list'; break
      }
      if (intent.type === 'channel' && old?.organizationId === target.organizationId &&
        old.channelId === target.channelId && old.topicId === target.topicId && old.panel === target.panel) {
        publish(target, focus, previousTab)
        return false
      }
      browser.history[method]({ navigationPreviousTab: previousTab }, '', serializeNavigation(target))
      publish(target, focus, previousTab)
      return true
    },
    destroy() { browser.removeEventListener('popstate', pop); listeners.clear() },
  }
}
export type Navigation = ReturnType<typeof createNavigation>
