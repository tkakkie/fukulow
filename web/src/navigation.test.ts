import { describe, expect, it } from 'vitest'
import { createNavigation, type NavigationBrowser, type NavigationIntent } from './navigation'
import { parseNavigation, serializeNavigation, type NavigationTarget } from './navigation-url'

const base: NavigationTarget = { organizationId: 'org', channelId: 'channel', topicId: null, panel: null }
function harness(target: NavigationTarget = base) {
  let href = serializeNavigation(target)
  const calls: string[] = []
  let state: unknown = null
  let pop = () => {}
  const browser = {
    location: { get href() { return href } },
    history: {
      get state() { return state },
      pushState(value: unknown, _: string, url: string) { calls.push('push'); href = url; state = value },
      replaceState(value: unknown, _: string, url: string) { calls.push('replace'); href = url; state = value },
    },
    addEventListener(_: string, listener: () => void) { pop = listener },
    removeEventListener() { pop = () => {} },
  } as unknown as NavigationBrowser
  const nav = createNavigation(browser)
  return { nav, calls, pop(url: string) { href = url; state = null; pop() } }
}

describe('navigation URLs', () => {
  it('round trips all views, panel layers and encoded identifiers', () => {
    for (const channelId of [null, 'channel']) for (const topicId of [null, '日本語 #?']) {
      if (!channelId && topicId) continue
      for (const panel of [null, 'topics', 'overview', 'members', 'reply:message'] as const) {
        if (!channelId && panel) continue
        const target = { ...base, channelId, topicId, panel }
        expect(parseNavigation(serializeNavigation(target))).toEqual(target)
      }
    }
  })
  it('rejects malformed paths and ignores unknown panels without trusting access', () => {
    for (const path of ['/', '/o/a/c/b/extra', '/o/%/c/b', '/o/a/c/%2F']) expect(parseNavigation(path)).toBeNull()
    expect(parseNavigation('/o/foreign/c/private?panel=unknown')).toEqual({ organizationId: 'foreign', channelId: 'private', topicId: null, panel: null })
  })
})

describe('History navigation table', () => {
  it('reselecting the same Channel target never writes History, including an open tab', () => {
    for (const panel of [null, 'topics', 'overview', 'members'] as const) {
      const { nav, calls } = harness({ ...base, panel })
      expect(nav.navigate({ type: 'channel', organizationId: 'org', channelId: 'channel' })).toBe(false)
      expect(nav.get().target).toEqual({ ...base, panel })
      expect(calls).toEqual([])
      nav.destroy()
    }
  })
  const rows: { name: string; panel?: NavigationTarget['panel']; topicId?: string; intent: NavigationIntent; history: string; focus: string; nextPanel: NavigationTarget['panel'] }[] = [
    { name: 'same Channel leaves Topic with push', topicId: 'topic', panel: 'members', intent: { type: 'channel', organizationId: 'org', channelId: 'channel' }, history: 'push', focus: 'composer', nextPanel: 'members' },
    { name: 'same Channel closes Reply with push', panel: 'reply:a', intent: { type: 'channel', organizationId: 'org', channelId: 'channel' }, history: 'push', focus: 'composer', nextPanel: null },
    { name: 'same Channel id in another Organization pushes', intent: { type: 'channel', organizationId: 'other', channelId: 'channel' }, history: 'push', focus: 'composer', nextPanel: null },
    { name: 'Channel keeps tab', panel: 'members', intent: { type: 'channel', organizationId: 'org', channelId: 'next' }, history: 'push', focus: 'composer', nextPanel: 'members' },
    { name: 'Channel closes Reply', panel: 'reply:a', intent: { type: 'channel', organizationId: 'org', channelId: 'next' }, history: 'push', focus: 'composer', nextPanel: null },
    { name: 'Topic keeps panel', panel: 'overview', intent: { type: 'topic', topicId: 'topic' }, history: 'push', focus: 'composer', nextPanel: 'overview' },
    { name: 'phone Topic drops panel', panel: 'topics', intent: { type: 'topic', topicId: 'topic', phone: true }, history: 'push', focus: 'composer', nextPanel: null },
    { name: 'Topic back keeps panel', topicId: 'topic', panel: 'members', intent: { type: 'topic-back' }, history: 'replace', focus: 'topic-summary', nextPanel: 'members' },
    { name: 'open tab', intent: { type: 'tab', tab: 'topics' }, history: 'push', focus: 'heading', nextPanel: 'topics' },
    { name: 'switch tab', panel: 'topics', intent: { type: 'tab', tab: 'overview' }, history: 'replace', focus: 'tab', nextPanel: 'overview' },
    { name: 'open Reply', panel: 'topics', intent: { type: 'reply', messageId: 'a' }, history: 'push', focus: 'reply-composer', nextPanel: 'reply:a' },
    { name: 'replace Reply', panel: 'reply:b', intent: { type: 'reply', messageId: 'a' }, history: 'replace', focus: 'reply-composer', nextPanel: 'reply:a' },
    { name: 'close', panel: 'topics', intent: { type: 'close' }, history: 'replace', focus: 'opener', nextPanel: null },
    { name: 'phone list parent', intent: { type: 'list' }, history: 'replace', focus: 'list', nextPanel: null },
  ]
  it.each(rows)('$name', ({ panel = null, topicId = null, intent, history, focus, nextPanel }) => {
    const { nav, calls } = harness({ ...base, panel, topicId })
    nav.navigate(intent)
    expect(calls).toEqual([history])
    expect(nav.get().focus).toBe(focus)
    expect(nav.get().target?.panel).toBe(nextPanel)
    if (intent.type === 'channel') expect(nav.get().target).toEqual({ organizationId: intent.organizationId, channelId: intent.channelId, topicId: null, panel: nextPanel })
    if (intent.type === 'topic-back') expect(nav.get().target?.topicId).toBeNull()
  })
  it('Reply back restores only the preceding tab and never pops', () => {
    const { nav, calls } = harness({ ...base, panel: 'overview' })
    nav.navigate({ type: 'reply', messageId: 'a' })
    nav.navigate({ type: 'reply', messageId: 'b' })
    nav.navigate({ type: 'reply-back' })
    expect(nav.get().target).toEqual({ ...base, panel: 'overview' })
    expect(calls).toEqual(['push', 'replace', 'replace'])
  })
  it('direct links have no synthetic parents; Back/Forward reads URLs without writes', () => {
    const { nav, calls, pop } = harness({ ...base, panel: 'reply:a', topicId: 't' })
    expect(calls).toEqual([])
    nav.navigate({ type: 'close' })
    expect(nav.get().target).toEqual({ ...base, topicId: 't' })
    pop('/o/org/c/other?panel=members')
    expect(nav.get().target?.channelId).toBe('other')
    pop('/o/org/c/channel/t/t?panel=reply:a')
    expect(nav.get().target?.panel).toBe('reply:a')
    expect(calls).toEqual(['replace'])
    nav.destroy()
  })

  it('popstate follows the navigation focus table, including Reply back and tab switches', () => {
    const transitions: { from: NavigationTarget; to: NavigationTarget; focus: string }[] = []
    for (const panel of ['topics', 'overview', 'members'] as const) {
      transitions.push(
        { from: { ...base, panel: 'reply:a' }, to: { ...base, panel }, focus: 'tab' },
        { from: base, to: { ...base, panel }, focus: 'heading' },
        { from: { ...base, panel }, to: base, focus: 'opener' },
        { from: { ...base, panel }, to: { ...base, panel: 'reply:a' }, focus: 'reply-composer' },
        { from: { ...base, panel }, to: { ...base, channelId: 'other', panel }, focus: 'composer' },
        { from: { ...base, panel }, to: { ...base, topicId: 'topic', panel }, focus: 'composer' },
        { from: { ...base, topicId: 'topic', panel }, to: { ...base, panel }, focus: 'topic-summary' },
      )
      for (const previous of ['topics', 'overview', 'members'] as const) {
        if (previous !== panel) transitions.push({ from: { ...base, panel: previous }, to: { ...base, panel }, focus: 'tab' })
      }
    }
    transitions.push(
      { from: { ...base, panel: 'reply:a' }, to: base, focus: 'opener' },
      { from: { ...base, panel: 'reply:a' }, to: { ...base, panel: 'reply:b' }, focus: 'reply-composer' },
      { from: base, to: { ...base, channelId: null }, focus: 'list' },
      { from: { ...base, channelId: null }, to: base, focus: 'composer' },
    )
    for (const { from, to, focus } of transitions) {
      const { nav, calls, pop } = harness(from)
      pop(serializeNavigation(to))
      expect(nav.get().target).toEqual(to)
      expect(nav.get().focus, `${serializeNavigation(from)} -> ${serializeNavigation(to)}`).toBe(focus)
      expect(calls).toEqual([])
      nav.destroy()
    }
  })
})

it('Back from a Topic targets its summary and preserves panel state without writing history', () => {
  const { nav, calls, pop } = harness({ ...base, topicId: 'topic', panel: 'overview' })
  pop('/o/org/c/channel?panel=overview')
  expect(nav.get().focus).toBe('topic-summary')
  expect(nav.getReturningTopicId()).toBe('topic')
  expect(nav.get().target?.panel).toBe('overview')
  expect(calls).toEqual([])
})

it('keeps the Channel list URL free of view/panel layers and focuses the list on Browser Back', () => {
  const { nav, calls, pop } = harness({ ...base, channelId: null })
  nav.navigate({ type: 'tab', tab: 'topics' })
  nav.navigate({ type: 'topic', topicId: 'topic' })
  expect(nav.get().target).toEqual({ ...base, channelId: null })
  expect(calls).toEqual([])
  nav.navigate({ type: 'channel', organizationId: 'org', channelId: 'channel' })
  pop('/o/org')
  expect(nav.get().focus).toBe('list')
})
