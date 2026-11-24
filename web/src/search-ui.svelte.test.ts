import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import type { SearchHit } from './api'
import SearchBar from './SearchBar.svelte'
import SearchResults from './SearchResults.svelte'
import { createSearchController, type SearchState, type SearchTarget } from './search'
import { searchAdapter } from './search.svelte'
import { createMockSearchSource, makeSearchHit } from './search-test-helpers'
import { withMiniDom, type MiniDocument, type MiniDomOptions, type MiniWindow } from './svelte-dom-test-helpers'

const SEARCH_UI_DOM_OPTIONS: MiniDomOptions = {
  stopBubbleAtDocument: true,
  invokeDelegatedProp: true,
  focusOnClick: false,
  clickSubmit: 'always',
}

const withDom = <T>(fn: (doc: MiniDocument, win: MiniWindow) => Promise<T>): Promise<T> =>
  withMiniDom(fn, SEARCH_UI_DOM_OPTIONS)

function baseState(overrides: Partial<SearchState> = {}): SearchState {
  return {
    open: true,
    input: 'リリース',
    submittedQuery: 'リリース',
    status: 'results',
    items: [],
    nextCursor: null,
    minLength: null,
    retryable: false,
    loadMoreError: null,
    openNotice: null,
    ...overrides,
  }
}

describe('SearchBar a11y and keyboard behaviour', () => {
  it('renders a labelled search landmark, submits input, respects IME composition, and closes on Escape', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const onsubmit = vi.fn()
      const onclose = vi.fn()
      const props = $state({ value: '議事録', open: true })

      const inst = mount(SearchBar, {
        target: host as unknown as Element,
        props: {
          get value() { return props.value },
          get open() { return props.open },
          oninput: (v) => { props.value = v },
          onsubmit,
          onclose,
        },
      })
      flushSync()

      const form = host.querySelector('[role="search"]')
      expect(form?.getAttribute('aria-label')).toBe('メッセージを検索')
      const input = host.querySelector('input')!
      expect(input.getAttribute('type')).toBe('search')
      expect(input.getAttribute('aria-label')).toBe('メッセージを検索')

      // IME composing Enter must not submit; IME Escape must not close.
      const composingEnter = input.keydown('Enter', { isComposing: true, keyCode: 229 })
      expect(composingEnter.defaultPrevented).toBe(true)
      input.keydown('Escape', { isComposing: true, keyCode: 229 })
      expect(onclose).not.toHaveBeenCalled()

      // Plain Escape closes when open.
      input.keydown('Escape')
      expect(onclose).toHaveBeenCalledTimes(1)

      // Submit button fires onsubmit with current value.
      host.querySelector('button')!.click()
      expect(onsubmit).toHaveBeenCalledWith('議事録')

      await unmount(inst)
    })
  })

  it('keeps the submit button usable while a search is pending so a stalled request can be replaced', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const onsubmit = vi.fn()
      const props = $state({ value: '新しい検索', busy: true })

      const inst = mount(SearchBar, {
        target: host as unknown as Element,
        props: {
          get value() { return props.value },
          get busy() { return props.busy },
          open: true,
          oninput: (v) => { props.value = v },
          onsubmit,
        },
      })
      flushSync()

      const submitBtn = host.querySelector('button')!
      expect(submitBtn.disabled).toBe(false)
      submitBtn.click()
      expect(onsubmit).toHaveBeenCalledWith('新しい検索')

      await unmount(inst)
    })
  })
})

describe('SearchResults a11y, states, and result opening', () => {
  it('renders distinct loading, empty, too-short, timeout, unavailable, and error states without any 180-day range claim', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const onretry = vi.fn()
      const props = $state<{ state: SearchState }>({ state: baseState({ status: 'loading' }) })

      const inst = mount(SearchResults, {
        target: host as unknown as Element,
        props: {
          get state() { return props.state },
          resolveContext: () => '# general',
          resolveSender: () => 'メンバー',
          onopenresult: vi.fn(),
          onloadmore: vi.fn(),
          onretry,
        },
      })
      flushSync()

      // Loading: aria-busy skeleton, no 180-day range note
      expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()
      expect(host.textContent).not.toContain('180')

      // Too-short: alert, no retry button
      props.state = baseState({ status: 'too-short', minLength: 2, retryable: false })
      flushSync()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('短すぎます')
      expect(host.textContent).toContain('2文字以上')
      expect(host.querySelectorAll('button')).toHaveLength(0)

      // Timeout: distinct alert + retry
      props.state = baseState({ status: 'timeout', retryable: true })
      flushSync()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('タイムアウト')
      host.querySelector('button')!.click()
      expect(onretry).toHaveBeenCalledTimes(1)

      // Error: distinct alert + retry
      props.state = baseState({ status: 'error', retryable: true })
      flushSync()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('検索に失敗しました')
      expect(host.querySelector('button')?.textContent.trim()).toBe('再試行')

      props.state = baseState({ status: 'empty' })
      flushSync()
      expect(host.textContent).toContain('一致するメッセージが見つかりませんでした')
      expect(host.textContent).not.toContain('180')

      // Unavailable: polite copy, no retry, no live region
      props.state = baseState({ status: 'unavailable', retryable: false })
      flushSync()
      expect(host.textContent).toContain('メッセージ検索は現在準備中です。')
      expect(host.querySelectorAll('button')).toHaveLength(0)
      expect(host.querySelector('[role="status"]')).toBeNull()

      // Inline openNotice when a hit's Channel cannot be opened: visual notice, no live region
      props.state = baseState({ status: 'results', openNotice: 'この検索結果のチャンネルは現在開けません。' })
      flushSync()
      expect(host.querySelector('[data-testid="search-open-notice"]')?.textContent).toContain('開けません')
      expect(host.querySelector('[role="status"]')).toBeNull()

      // invalid_cursor load-more error: clears load-more button and retries from page one via onretry
      onretry.mockClear()
      props.state = baseState({
        status: 'results',
        items: [makeSearchHit(1, { body: '既存ヒット' })],
        nextCursor: null,
        loadMoreError: 'invalid_cursor',
        retryable: true,
      })
      flushSync()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('検索結果の続きを読み込めませんでした')
      expect(host.textContent).toContain('最初から検索し直してください')
      expect(host.querySelectorAll('button').some((b) => b.textContent.trim() === 'さらに読み込む')).toBe(false)
      const retryBtn = host.querySelectorAll('button').find((b) => b.textContent.trim() === '再試行')!
      retryBtn.click()
      expect(onretry).toHaveBeenCalledTimes(1)

      await unmount(inst)
    })
  })

  it('renders Channel/Topic/DM context, deactivated authors, time, excerpt, load-more, and calls openSearchResult(target)', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const items: SearchHit[] = [
        makeSearchHit(1, {
          id: 'm-1',
          created_seq: 37,
          channel_id: 'ch-general',
          topic_id: 'top-1',
          reply_root_id: 'root-1',
          sender: 'author-1',
          created_at: '2026-11-19T09:30:00.000Z',
          body: '手順書を更新しました。',
        }),
        makeSearchHit(
          2,
          {
            id: 'm-2',
            created_seq: 12,
            channel_id: 'dm-1',
            topic_id: null,
            reply_root_id: null,
            sender: 'author-2',
            created_at: '2026-11-18T11:00:00.000Z',
            body: '定例ミーティングの件です。',
          },
          'dm',
        ),
      ]
      const onopenresult = vi.fn<(target: SearchTarget) => void>()
      const onloadmore = vi.fn()

      const inst = mount(SearchResults, {
        target: host as unknown as Element,
        props: {
          state: baseState({ status: 'results', items, nextCursor: 'mock:20' }),
          resolveContext: (hit) =>
            hit.channel_kind === 'dm' ? 'ダイレクトメッセージ: 鈴木 花子' : '# general › リリース',
          resolveSender: (id) => (id === 'author-1' ? '田中 美咲（無効）' : '鈴木 花子'),
          onopenresult,
          onloadmore,
          onretry: vi.fn(),
        },
      })
      flushSync()

      const list = host.querySelector('ol')
      expect(list?.getAttribute('aria-label')).toBe('検索結果一覧')
      expect(host.querySelectorAll('article')).toHaveLength(2)
      expect(host.querySelectorAll('time')).toHaveLength(2)
      expect(host.textContent).toContain('# general › リリース')
      expect(host.textContent).toContain('返信のつながり')
      expect(host.textContent).toContain('田中 美咲（無効）')
      expect(host.textContent).toContain('ダイレクトメッセージ: 鈴木 花子')
      expect(host.textContent).toContain('手順書を更新しました。')

      // Click first result -> openSearchResult(target)
      host.querySelectorAll('button')[0].click()
      expect(onopenresult).toHaveBeenCalledWith({
        channelId: 'ch-general',
        channelKind: 'channel',
        topicId: 'top-1',
        replyRootId: 'root-1',
        messageId: 'm-1',
        createdSeq: 37,
      })

      // Click load more
      const loadMoreBtn = host.querySelectorAll('button').find(b => b.textContent.trim() === 'さらに読み込む')!
      loadMoreBtn.click()
      expect(onloadmore).toHaveBeenCalledTimes(1)

      await unmount(inst)
    })
  })

  it('forwards state and openSearchResult through searchAdapter', async () => {
    const onOpenResult = vi.fn()
    const ctrl = createSearchController({ source: createMockSearchSource(), onOpenResult })
    const adapter = searchAdapter(ctrl)
    const statuses: string[] = []
    const stop = $effect.root(() => {
      $effect(() => { statuses.push(adapter.state.status) })
    })
    flushSync()
    await adapter.submit('リリース')
    flushSync()
    expect(statuses).toContain('results')
    expect(adapter.state.items.length).toBeGreaterThan(0)
    const first = adapter.state.items[0]
    adapter.openSearchResult({
      channelId: first.message.channel_id,
      topicId: first.message.topic_id,
      replyRootId: first.message.reply_root_id,
      messageId: first.message.id,
      createdSeq: first.message.created_seq,
    })
    expect(onOpenResult).toHaveBeenCalledTimes(1)
    expect(adapter.state.open).toBe(false)
    stop()
    ctrl.destroy()
  })
})
