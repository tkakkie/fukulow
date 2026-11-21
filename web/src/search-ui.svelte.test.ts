import { flushSync, mount, unmount } from 'svelte'
import { parse, type AST } from 'svelte/compiler'
import { describe, expect, it, vi } from 'vitest'
import type { SearchHit } from './api'
import SearchBar from './SearchBar.svelte'
import SearchResults from './SearchResults.svelte'
import { createSearchController, type SearchState, type SearchTarget } from './search'
import { searchAdapter } from './search.svelte'
import { createMockSearchSource, makeSearchHit } from './search-test-helpers'

type Listener = (ev: MiniEvent) => void

class MiniEvent {
  defaultPrevented = false
  propagationStopped = false
  currentTarget: MiniNode | null = null
  target: MiniNode | null = null
  readonly type: string
  readonly key: string
  readonly isComposing: boolean
  readonly keyCode: number
  readonly altKey = false
  readonly ctrlKey = false
  readonly metaKey = false
  readonly shiftKey = false
  constructor(type: string, init: { key?: string; isComposing?: boolean; keyCode?: number } = {}) {
    this.type = type
    this.key = init.key ?? ''
    this.isComposing = init.isComposing ?? false
    this.keyCode = init.keyCode ?? 0
  }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this.propagationStopped = true }
}

class MiniNode {
  childNodes: MiniNode[] = []
  parentNode: MiniNode | null = null
  readonly listeners = new Map<string, Set<Listener>>()
  readonly nodeType: number
  readonly nodeName: string
  ownerDocument: MiniDoc | null
  data: string
  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDoc | null, data = '') {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = ownerDocument
    this.data = data
  }
  get firstChild(): MiniNode | null { return this.childNodes[0] ?? null }
  get nextSibling(): MiniNode | null {
    const p = this.parentNode
    if (!p) return null
    const i = p.childNodes.indexOf(this)
    return i >= 0 ? (p.childNodes[i + 1] ?? null) : null
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map(c => c.textContent).join('')
  }
  set textContent(v: string) {
    this.childNodes = []
    if (v && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(String(v)))
  }
  set nodeValue(v: string | null) { this.data = v ?? '' }
  get nodeValue(): string { return this.data }
  appendChild<T extends MiniNode>(c: T): T { return this.insertBefore(c, null) }
  insertBefore<T extends MiniNode>(c: T, ref: MiniNode | null): T {
    if (c.nodeType === 11) {
      for (const n of [...c.childNodes]) this.insertBefore(n, ref)
      return c
    }
    if (c.parentNode) c.remove()
    const i = ref ? this.childNodes.indexOf(ref) : -1
    if (i >= 0) this.childNodes.splice(i, 0, c)
    else this.childNodes.push(c)
    c.parentNode = this
    return c
  }
  removeChild<T extends MiniNode>(c: T): T {
    if (c.parentNode === this) c.remove()
    return c
  }
  remove(): void {
    const p = this.parentNode
    if (!p) return
    const i = p.childNodes.indexOf(this)
    if (i >= 0) p.childNodes.splice(i, 1)
    this.parentNode = null
  }
  append(...nodes: (MiniNode | string)[]): void {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument!.createTextNode(n) : n)
  }
  before(...nodes: (MiniNode | string)[]): void {
    if (!this.parentNode) return
    for (const n of nodes) this.parentNode.insertBefore(typeof n === 'string' ? this.ownerDocument!.createTextNode(n) : n, this)
  }
  after(...nodes: (MiniNode | string)[]): void {
    if (!this.parentNode) return
    const ref = this.nextSibling
    for (const n of nodes) this.parentNode.insertBefore(typeof n === 'string' ? this.ownerDocument!.createTextNode(n) : n, ref)
  }
  cloneNode(deep = false): MiniNode {
    const copy = new MiniNode(this.nodeType, this.nodeName, this.ownerDocument, this.data)
    if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true))
    return copy
  }
  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(fn)
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.get(type)?.delete(fn) }
  dispatchEvent(ev: MiniEvent): boolean {
    ev.target = this
    let cur: MiniNode | null = this
    while (cur) {
      ev.currentTarget = cur
      for (const fn of [...(cur.listeners.get(ev.type) ?? [])]) fn.call(cur, ev)
      const prop = (cur as unknown as Record<string, unknown>)[`__${ev.type}`]
      if (typeof prop === 'function') (prop as Listener).call(cur, ev)
      if (ev.propagationStopped) break
      cur = cur.parentNode
    }
    return !ev.defaultPrevented
  }
}

class MiniText extends MiniNode {
  constructor(doc: MiniDoc | null, d = '') { super(3, '#text', doc, d) }
  override cloneNode(): MiniText { return new MiniText(this.ownerDocument, this.data) }
}

class MiniComment extends MiniNode {
  constructor(doc: MiniDoc | null, d = '') { super(8, '#comment', doc, d) }
  override cloneNode(): MiniComment { return new MiniComment(this.ownerDocument, this.data) }
}

class MiniEl extends MiniNode {
  readonly tagName: string
  readonly localName: string
  readonly attrs = new Map<string, string>()
  readonly content: MiniNode
  private _value = ''
  constructor(tag: string, doc: MiniDoc | null) {
    super(1, tag.toUpperCase(), doc)
    this.tagName = tag.toUpperCase()
    this.localName = tag.toLowerCase()
    this.content = new MiniNode(11, '#document-fragment', doc)
  }
  get value(): string { return this._value }
  set value(v: string) { this._value = String(v ?? '') }
  get disabled(): boolean { return this.attrs.has('disabled') }
  set disabled(v: boolean) { if (v) this.attrs.set('disabled', ''); else this.attrs.delete('disabled') }
  setAttribute(k: string, v: string | null): void {
    if (v === null) this.attrs.delete(k.toLowerCase())
    else this.attrs.set(k.toLowerCase(), String(v))
  }
  getAttribute(k: string): string | null { return this.attrs.get(k.toLowerCase()) ?? null }
  hasAttribute(k: string): boolean { return this.attrs.has(k.toLowerCase()) }
  removeAttribute(k: string): void { this.attrs.delete(k.toLowerCase()) }
  set innerHTML(html: string) {
    const target = this.tagName === 'TEMPLATE' ? this.content : this
    target.childNodes = []
    if (!html || !this.ownerDocument) return
    appendAst(parse(html, { modern: true }).fragment.nodes, target, this.ownerDocument)
  }
  closest(sel: string): MiniEl | null {
    let cur: MiniNode | null = this
    while (cur) {
      if (cur instanceof MiniEl && matches(cur, sel)) return cur
      cur = cur.parentNode
    }
    return null
  }
  click(): void {
    if (this.disabled) return
    this.dispatchEvent(new MiniEvent('click'))
    if (this.localName === 'button' && (this.getAttribute('type') === 'submit' || !this.hasAttribute('type'))) {
      this.closest('form')?.dispatchEvent(new MiniEvent('submit'))
    }
  }
  input(val: string): void {
    if (this.disabled) return
    this._value = val
    this.dispatchEvent(new MiniEvent('input'))
  }
  keydown(key: string, opts: { isComposing?: boolean; keyCode?: number } = {}): MiniEvent {
    const ev = new MiniEvent('keydown', { key, ...opts })
    this.dispatchEvent(ev)
    return ev
  }
  querySelectorAll(sel: string): MiniEl[] { return findAll(this, sel) }
  querySelector(sel: string): MiniEl | null { return findAll(this, sel)[0] ?? null }
  override cloneNode(deep = false): MiniEl {
    const copy = new MiniEl(this.localName, this.ownerDocument)
    for (const [k, v] of this.attrs) copy.attrs.set(k, v)
    copy._value = this._value
    if (deep) {
      for (const c of this.childNodes) copy.appendChild(c.cloneNode(true))
      for (const c of this.content.childNodes) copy.content.appendChild(c.cloneNode(true))
    }
    return copy
  }
}

class MiniDoc extends MiniNode {
  readonly body: MiniEl
  constructor() {
    super(9, '#document', null)
    this.ownerDocument = this
    this.body = new MiniEl('body', this)
    this.appendChild(this.body)
  }
  createElement(tag: string): MiniEl { return new MiniEl(tag, this) }
  createTextNode(d = ''): MiniText { return new MiniText(this, d) }
  createComment(d = ''): MiniComment { return new MiniComment(this, d) }
  createDocumentFragment(): MiniNode { return new MiniNode(11, '#document-fragment', this) }
  importNode<T extends MiniNode>(n: T, deep = false): T { return n.cloneNode(deep) as T }
}

function appendAst(nodes: AST.TemplateNode[], parent: MiniNode, doc: MiniDoc): void {
  for (const n of nodes) {
    if (n.type === 'Text') parent.appendChild(doc.createTextNode(n.data))
    else if (n.type === 'Comment') parent.appendChild(doc.createComment(n.data))
    else if (n.type === 'RegularElement') {
      const el = doc.createElement(n.name)
      for (const a of n.attributes) {
        if (a.type === 'Attribute') {
          el.setAttribute(a.name, a.value === true ? '' : Array.isArray(a.value) ? a.value.map(c => (c.type === 'Text' ? c.data : '')).join('') : '')
        }
      }
      appendAst(n.fragment.nodes, el.tagName === 'TEMPLATE' ? el.content : el, doc)
      parent.appendChild(el)
    }
  }
}

function matches(el: MiniEl, sel: string): boolean {
  if (sel === '[role="search"]') return el.getAttribute('role') === 'search'
  if (sel === '[role="alert"]') return el.getAttribute('role') === 'alert'
  if (sel === '[role="status"]') return el.getAttribute('role') === 'status'
  if (sel === '[aria-busy="true"]') return el.getAttribute('aria-busy') === 'true'
  if (sel === '[data-testid="search-open-notice"]') return el.getAttribute('data-testid') === 'search-open-notice'
  return el.localName === sel
}

function findAll(root: MiniNode, sel: string): MiniEl[] {
  const out: MiniEl[] = []
  const visit = (n: MiniNode) => {
    for (const c of n.childNodes) {
      if (c instanceof MiniEl && matches(c, sel)) out.push(c)
      visit(c)
    }
  }
  visit(root)
  return out
}

async function withDom<T>(fn: (doc: MiniDoc) => Promise<T>): Promise<T> {
  const keys = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLMediaElement', 'Text', 'Comment', 'DocumentFragment'] as const
  const saved = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const doc = new MiniDoc()
  const patches: Record<string, unknown> = {
    window: new MiniNode(9, '#window', doc),
    document: doc,
    Node: MiniNode,
    Element: MiniEl,
    HTMLElement: MiniEl,
    HTMLButtonElement: MiniEl,
    HTMLInputElement: MiniEl,
    HTMLTextAreaElement: MiniEl,
    HTMLMediaElement: MiniEl,
    Text: MiniText,
    Comment: MiniComment,
    DocumentFragment: MiniNode,
  }
  for (const [k, v] of Object.entries(patches)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  try {
    return await fn(doc)
  } finally {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc)
      else Reflect.deleteProperty(globalThis, k)
    }
  }
}

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
