import { parseNavigation, serializeNavigation, type NavigationTarget, type PanelTab } from './navigation-url'

export type SearchResultTarget = {
  channelId: string
  topicId?: string | null
  replyRootId?: string | null
  messageId: string
  /** The immutable per-Channel creation sequence. */
  createdSeq: number
}

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
export type NavigationSnapshot = { target: NavigationTarget | null; searchResult?: SearchResultTarget; previousTab: PanelTab | null; focus: NavigationFocus; revision: number }
export type NavigationBrowser = Pick<Window, 'location' | 'history' | 'innerWidth' | 'addEventListener' | 'removeEventListener'>

function historyEntry(browser: NavigationBrowser, target: NavigationTarget | null) {
  const state = browser.history.state as { navigationPreviousTab?: PanelTab; searchResult?: SearchResultTarget } | null
  const tab = state?.navigationPreviousTab
  const result = state?.searchResult
  const searchResult = result && target?.channelId === result.channelId && target.topicId === (result.topicId ?? null) &&
    (!result.replyRootId || target.panel === `reply:${result.messageId}`) ? result : undefined
  const previousTab = tab === 'topics' || tab === 'overview' || tab === 'members' ? tab : null
  return { previousTab, ...(searchResult ? { searchResult } : {}) }
}

/** Owns History effects. Components/adapters only read snapshots and forward intents. */
export function createNavigation(browser: NavigationBrowser = window) {
  const initialTarget = parseNavigation(browser.location.href)
  const initial = historyEntry(browser, initialTarget)
  let snapshot: NavigationSnapshot = {
    target: initialTarget, ...initial, previousTab: initial.searchResult ? initial.previousTab : null,
    focus: initial.searchResult?.replyRootId ? 'reply-composer' : 'composer', revision: 0,
  }
  let opener: HTMLElement | null = null
  let returningTopicId: string | null = null
  const listeners = new Set<() => void>()
  const publish = (target: NavigationTarget | null, focus: NavigationFocus, previousTab: PanelTab | null = null, searchResult?: SearchResultTarget) => {
    snapshot = { target, focus, previousTab, ...(searchResult ? { searchResult } : {}), revision: snapshot.revision + 1 }
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
    const { previousTab, searchResult: search } = historyEntry(browser, next)
    publish(next, search ? (search.replyRootId ? 'reply-composer' : 'composer') : focus,
      previousTab, search)
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
    openSearchResult(organizationId: string, result: SearchResultTarget) {
      const old = snapshot.target
      const previousTab = result.replyRootId && old?.organizationId === organizationId && old.channelId === result.channelId
        ? (old.panel?.startsWith('reply:') ? snapshot.previousTab : old.panel as PanelTab | null)
        : null
      const target: NavigationTarget = {
        organizationId, channelId: result.channelId, topicId: result.topicId ?? null,
        panel: result.replyRootId ? `reply:${result.messageId}` : null,
      }
      opener = null
      const { channelId, topicId, replyRootId, messageId, createdSeq } = result
      const searchResult: SearchResultTarget = { channelId, topicId, replyRootId, messageId, createdSeq }
      browser.history.pushState({ navigationPreviousTab: previousTab, searchResult }, '', serializeNavigation(target))
      publish(target, result.replyRootId ? 'reply-composer' : 'composer', previousTab, searchResult)
      return true
    },
    leaveSearchResult() {
      if (!snapshot.searchResult || !snapshot.target) return
      browser.history.replaceState({ navigationPreviousTab: snapshot.previousTab }, '', serializeNavigation(snapshot.target))
      publish(snapshot.target, snapshot.focus, snapshot.previousTab)
    },
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
      const priorResult = snapshot.searchResult
      const searchResult = priorResult && intent.type !== 'channel' && intent.type !== 'topic' &&
        old?.channelId === target.channelId && old?.topicId === target.topicId &&
        (!priorResult.replyRootId || target.panel === `reply:${priorResult.messageId}`) ? priorResult : undefined
      if ((intent.type === 'channel' || intent.type === 'topic') && old?.organizationId === target.organizationId &&
        old.channelId === target.channelId && old.topicId === target.topicId && old.panel === target.panel) {
        if (priorResult) browser.history.replaceState({ navigationPreviousTab: previousTab }, '', serializeNavigation(target))
        publish(target, focus, previousTab)
        return false
      }
      browser.history[method]({ navigationPreviousTab: previousTab, ...(searchResult ? { searchResult } : {}) }, '', serializeNavigation(target))
      publish(target, focus, previousTab, searchResult)
      return true
    },
    destroy() { browser.removeEventListener('popstate', pop); listeners.clear() },
  }
}
export type Navigation = ReturnType<typeof createNavigation>
