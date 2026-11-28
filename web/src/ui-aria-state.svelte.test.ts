import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { installMiniDom, queryAll } from './svelte-dom-test-helpers'
import TopicList from './TopicList.svelte'
import type { TopicsAdapter } from './topics.svelte'
import Chip from './ui/Chip.svelte'
import ListRow from './ui/ListRow.svelte'
import Panel, { type PanelTabId } from './ui/Panel.svelte'

const dom = installMiniDom()
const srcDir = resolve(import.meta.dirname)

function readStyle(relPath: string): string {
  const source = readFileSync(join(srcDir, relPath), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
}

describe('ARIA attribute state styling (#839)', () => {
  it('ListRow marks selected state with aria-current="true" only and styles via [aria-current]', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const state = $state({ selected: true, expanded: true })

    const instance = mount(ListRow, {
      target: host as unknown as Element,
      props: {
        name: 'general',
        get selected() { return state.selected },
        get expanded() { return state.expanded },
      },
    })
    try {
      flushSync()
      const btn = host.querySelector('button.ui-list-row')!
      expect(btn.getAttribute('aria-current')).toBe('true')
      expect(btn.getAttribute('aria-expanded')).toBe('true')
      expect(btn.classList.contains('ui-list-row--selected')).toBe(false)

      state.selected = false
      state.expanded = false
      flushSync()
      expect(btn.getAttribute('aria-current')).toBeNull()
      expect(btn.getAttribute('aria-expanded')).toBe('false')
      expect(btn.classList.contains('ui-list-row--selected')).toBe(false)

      const css = readStyle('ui/ListRow.svelte')
      expect(css).toMatch(/\.ui-list-row\[aria-current='true'\]/)
      expect(css).not.toContain('ui-list-row--selected')
    } finally {
      await unmount(instance)
    }
  })

  it('Panel marks active tab with aria-selected="true" only and styles via [aria-selected]', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const state = $state<{ activeTab: PanelTabId }>({ activeTab: 'overview' })

    const instance = mount(Panel, {
      target: host as unknown as Element,
      props: {
        title: '# general',
        get activeTab() { return state.activeTab },
      },
    })
    try {
      flushSync()
      const tabs = queryAll(host, 'button.ui-panel__tab')
      expect(tabs).toHaveLength(3)
      for (const tab of tabs) {
        expect(tab.classList.contains('ui-panel__tab--active')).toBe(false)
      }
      expect(host.querySelector('#panel-tab-overview')!.getAttribute('aria-selected')).toBe('true')
      expect(host.querySelector('#panel-tab-topics')!.getAttribute('aria-selected')).toBe('false')
      expect(host.querySelector('#panel-tab-members')!.getAttribute('aria-selected')).toBe('false')

      state.activeTab = 'members'
      flushSync()
      expect(host.querySelector('#panel-tab-members')!.getAttribute('aria-selected')).toBe('true')
      expect(host.querySelector('#panel-tab-overview')!.getAttribute('aria-selected')).toBe('false')

      const css = readStyle('ui/Panel.svelte')
      expect(css).toMatch(/\.ui-panel__tab\[aria-selected='true'\]/)
      expect(css).not.toContain('ui-panel__tab--active')
    } finally {
      await unmount(instance)
    }
  })

  it('Chip marks selected state with aria-pressed (button) or aria-current (span) only', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const state = $state({ selected: true })

    const interactive = mount(Chip, {
      target: host as unknown as Element,
      props: {
        get selected() { return state.selected },
        onclick: vi.fn(),
      },
    })
    const staticChip = mount(Chip, {
      target: host as unknown as Element,
      props: {
        get selected() { return state.selected },
      },
    })
    try {
      flushSync()
      const btn = host.querySelector('button.ui-chip')!
      const span = host.querySelector('span.ui-chip')!
      expect(btn.getAttribute('aria-pressed')).toBe('true')
      expect(btn.classList.contains('ui-chip--selected')).toBe(false)
      expect(span.getAttribute('aria-current')).toBe('true')
      expect(span.classList.contains('ui-chip--selected')).toBe(false)

      state.selected = false
      flushSync()
      expect(btn.getAttribute('aria-pressed')).toBe('false')
      expect(span.getAttribute('aria-current')).toBeNull()

      const css = readStyle('ui/Chip.svelte')
      expect(css).toMatch(/\.ui-chip\[aria-pressed='true'\]/)
      expect(css).toMatch(/\.ui-chip\[aria-current='true'\]/)
      expect(css).not.toContain('ui-chip--selected')
    } finally {
      await unmount(interactive)
      await unmount(staticChip)
    }
  })

  it('TopicList marks active topic via aria-current="true" only and styles item via :has([aria-current])', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const state = $state<{ activeTopicId: string | null }>({ activeTopicId: 't1' })

    const msg1 = {
      id: 'm1',
      client_message_id: 'cm1',
      channel_id: 'c1',
      history_generation: 'g1',
      created_seq: 1,
      created_at: '2026-01-01T00:00:00Z',
      deleted: false,
      body: '本文1',
      reply_root_id: null,
      reply_to: null,
      sender: 'u1',
      topic_id: 't1',
      version: 1,
    }
    const msg2 = {
      id: 'm2',
      client_message_id: 'cm2',
      channel_id: 'c1',
      history_generation: 'g1',
      created_seq: 2,
      created_at: '2026-01-01T00:01:00Z',
      deleted: false,
      body: '本文2',
      reply_root_id: null,
      reply_to: null,
      sender: 'u1',
      topic_id: 't2',
      version: 1,
    }

    const topicsAdapterFake = {
      state: {
        list: { asOfSeq: 2, hasMore: false, loading: false, error: false },
        topics: [
          {
            topicId: 't1',
            latestSeq: 1,
            latestMessage: msg1,
            baseline: {
              historyGeneration: 'g1',
              summary: { id: 't1', name: 'トピック1', first_seq: 1, last_seq: 1, latest_message: msg1, message_count: 1, unread_count: 0 },
            },
            messageCount: 1,
            summaryError: null,
          },
          {
            topicId: 't2',
            latestSeq: 2,
            latestMessage: msg2,
            baseline: {
              historyGeneration: 'g1',
              summary: { id: 't2', name: 'トピック2', first_seq: 2, last_seq: 2, latest_message: msg2, message_count: 1, unread_count: 0 },
            },
            messageCount: 1,
            summaryError: null,
          },
        ],
        unavailable: false,
        views: {},
      },
      loadList: vi.fn(async () => {}),
      ensureSummary: vi.fn(async () => {}),
      retrySummary: vi.fn(async () => {}),
      loadView: vi.fn(async () => {}),
      loadOlderView: vi.fn(async () => {}),
      resetView: vi.fn(),
    } as unknown as TopicsAdapter

    const instance = mount(TopicList, {
      target: host as unknown as Element,
      props: {
        topics: topicsAdapterFake,
        get activeTopicId() { return state.activeTopicId },
        onselecttopic: vi.fn(),
      },
    })
    try {
      flushSync()
      const items = queryAll(host, 'li.topic-list-panel__item')
      expect(items).toHaveLength(2)
      for (const item of items) {
        expect(item.classList.contains('topic-list-panel__item--active')).toBe(false)
      }
      expect(host.querySelector('button[data-topic-id="t1"]')!.getAttribute('aria-current')).toBe('true')
      expect(host.querySelector('button[data-topic-id="t2"]')!.getAttribute('aria-current')).toBeNull()

      state.activeTopicId = 't2'
      flushSync()
      expect(host.querySelector('button[data-topic-id="t1"]')!.getAttribute('aria-current')).toBeNull()
      expect(host.querySelector('button[data-topic-id="t2"]')!.getAttribute('aria-current')).toBe('true')

      const css = readStyle('TopicList.svelte')
      expect(css).toMatch(/\.topic-list-panel__item:has\(:global\(\[aria-current='true'\]\)\)/)
      expect(css).not.toContain('topic-list-panel__item--active')
    } finally {
      await unmount(instance)
    }
  })
})
