import { flushSync, mount, unmount } from 'svelte'
import { parse, type AST } from 'svelte/compiler'
import { describe, expect, it, vi } from 'vitest'
import { fakeNetwork, flush, ok, record } from './adapter-test-helpers.svelte'
import type { Channel, ChannelList, DmDiscovery, Result } from './api'
import ArchivedChannelList from './ArchivedChannelList.svelte'
import ChannelOverview from './ChannelOverview.svelte'
import type { ChannelsApi } from './channels'
import { channelsAdapter } from './channels.svelte'
import Composer from './Composer.svelte'
import { dm } from './dm-test-helpers'
import ReplyPanel from './ReplyPanel.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { repliesAdapter } from './replies.svelte'
import { deferred, http, row } from './unread-test-helpers'

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
  readonly shiftKey: boolean
  constructor(type: string, init: { key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) {
    this.type = type
    this.key = init.key ?? ''
    this.shiftKey = init.shiftKey ?? false
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
  get isConnected(): boolean {
    let cur: MiniNode | null = this
    while (cur) {
      if (cur.nodeType === 9) return true
      cur = cur.parentNode
    }
    return false
  }
  contains(other: MiniNode | null): boolean {
    let cur: MiniNode | null = other
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
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
  cloneNode(_deep = false): MiniNode {
    const copy = new MiniNode(this.nodeType, this.nodeName, this.ownerDocument, this.data)
    if (_deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true))
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
  readonly style: Record<string, unknown> = { setProperty: () => {}, removeProperty: () => {} }
  readonly dataset: Record<string, string> = {}
  scrollTop = 0
  scrollHeight = 600
  clientHeight = 600
  selectionStart = 0
  readonly classList = {
    toggle: (cls: string, force?: boolean): boolean => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean))
      const shouldHave = force ?? !set.has(cls)
      if (shouldHave) set.add(cls)
      else set.delete(cls)
      this.className = [...set].join(' ')
      return shouldHave
    },
    contains: (cls: string): boolean => this.className.split(/\s+/).includes(cls),
  }
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
  get inert(): boolean { return this.attrs.has('inert') }
  set inert(v: boolean) { if (v) this.attrs.set('inert', ''); else this.attrs.delete('inert') }
  get open(): boolean { return this.attrs.has('open') }
  set open(v: boolean) {
    const next = Boolean(v)
    const prev = this.attrs.has('open')
    if (next) this.attrs.set('open', '')
    else this.attrs.delete('open')
    if (this.localName === 'details' && next !== prev) this.dispatchEvent(new MiniEvent('toggle'))
  }
  private isInert(): boolean {
    let cur: MiniNode | null = this
    while (cur) {
      if (cur instanceof MiniEl && cur.inert) return true
      cur = cur.parentNode
    }
    return false
  }
  get className(): string { return this.attrs.get('class') ?? '' }
  set className(v: string) { this.setAttribute('class', v) }
  get id(): string { return this.attrs.get('id') ?? '' }
  set id(v: string) { this.setAttribute('id', v) }
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
  focus(): void { if (!this.disabled && !this.isInert() && this.ownerDocument) this.ownerDocument.activeElement = this }
  scrollIntoView(): void {}
  setSelectionRange(start: number): void { this.selectionStart = start }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } }
  closest(sel: string): MiniEl | null {
    let cur: MiniNode | null = this
    while (cur) {
      if (cur instanceof MiniEl && matchesSelector(cur, sel)) return cur
      cur = cur.parentNode
    }
    return null
  }
  click(): void {
    if (this.disabled || this.isInert()) return
    this.focus()
    const ev = new MiniEvent('click')
    this.dispatchEvent(ev)
    if (!ev.defaultPrevented && this.localName === 'summary' && this.parentNode instanceof MiniEl && this.parentNode.localName === 'details') {
      this.parentNode.open = !this.parentNode.open
    }
    if (this.localName === 'button' && (this.getAttribute('type') === 'submit' || !this.hasAttribute('type'))) {
      const form = this.closest('form')
      if (form) form.dispatchEvent(new MiniEvent('submit'))
    }
  }
  input(val: string): void {
    if (this.disabled || this.isInert()) return
    this._value = val
    this.dispatchEvent(new MiniEvent('input'))
  }
  keydown(key: string, opts: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}): void {
    if (this.disabled || this.isInert()) return
    const ev = new MiniEvent('keydown', { key, ...opts })
    this.dispatchEvent(ev)
    if (!ev.defaultPrevented && this.localName === 'summary' && (key === 'Enter' || key === ' ') && this.parentNode instanceof MiniEl && this.parentNode.localName === 'details') {
      this.parentNode.open = !this.parentNode.open
    }
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
  readonly documentElement: MiniEl
  activeElement: MiniEl | null = null
  visibilityState = 'visible'
  constructor() {
    super(9, '#document', null)
    this.ownerDocument = this
    this.documentElement = new MiniEl('html', this)
    this.body = new MiniEl('body', this)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
    this.activeElement = this.body
  }
  createElement(tag: string): MiniEl { return new MiniEl(tag, this) }
  createTextNode(d = ''): MiniText { return new MiniText(this, d) }
  createComment(d = ''): MiniComment { return new MiniComment(this, d) }
  createDocumentFragment(): MiniNode { return new MiniNode(11, '#document-fragment', this) }
  importNode<T extends MiniNode>(n: T, deep = false): T { return n.cloneNode(deep) as T }
  querySelectorAll(sel: string): MiniEl[] { return findAll(this, sel) }
  querySelector(sel: string): MiniEl | null { return findAll(this, sel)[0] ?? null }
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

function matchesSelector(c: MiniEl, sel: string): boolean {
  if (sel.includes(',')) return sel.split(',').some(part => matchesSelector(c, part.trim()))
  if (sel === 'button') return c.localName === 'button'
  if (sel === 'form') return c.localName === 'form'
  if (sel === 'input') return c.localName === 'input'
  if (sel === 'textarea') return c.localName === 'textarea'
  if (sel === 'li') return c.localName === 'li'
  if (sel === 'details') return c.localName === 'details'
  if (sel === 'summary') return c.localName === 'summary'
  if (sel === '.archived-list__body') return c.classList.contains('archived-list__body')
  if (sel === '[role="dialog"]') return c.getAttribute('role') === 'dialog'
  if (sel === '[role="alert"]') return c.getAttribute('role') === 'alert'
  if (sel === '.ui-chip') return c.classList.contains('ui-chip')
  if (sel === '.ui-badge') return c.classList.contains('ui-badge')
  if (sel === '.ui-status-banner') return c.classList.contains('ui-status-banner')
  if (sel === 'button:not(:disabled)') return c.localName === 'button' && !c.disabled
  if (sel === 'input:not(:disabled)') return c.localName === 'input' && !c.disabled
  if (sel === 'textarea:not(:disabled)') return c.localName === 'textarea' && !c.disabled
  return false
}

function findAll(root: MiniNode, sel: string): MiniEl[] {
  const out: MiniEl[] = []
  const visit = (n: MiniNode) => {
    for (const c of n.childNodes) {
      if (c instanceof MiniEl && matchesSelector(c, sel)) out.push(c)
      visit(c)
    }
  }
  visit(root)
  return out
}

async function withDom<T>(fn: (doc: MiniDoc) => Promise<T>): Promise<T> {
  const keys = [
    'window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement',
    'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLMediaElement', 'Text', 'Comment', 'DocumentFragment',
    'ResizeObserver', 'IntersectionObserver',
  ] as const
  const saved = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const doc = new MiniDoc()
  const win = new MiniNode(9, '#window', doc)
  class StubObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const patches: Record<string, unknown> = {
    window: win, document: doc, Node: MiniNode, Element: MiniEl, HTMLElement: MiniEl,
    HTMLButtonElement: MiniEl, HTMLInputElement: MiniEl, HTMLTextAreaElement: MiniEl, HTMLMediaElement: MiniEl,
    Text: MiniText, Comment: MiniComment, DocumentFragment: MiniNode,
    ResizeObserver: StubObserver, IntersectionObserver: StubObserver,
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

const makeChannel = (overrides: Partial<Channel> = {}): Channel => ({
  id: 'ch-1',
  kind: 'channel',
  archived: false,
  name: 'general',
  visibility: 'public',
  capabilities: {
    can_add_members: { allowed: false },
    can_remove_members: { allowed: false },
    can_manage_managers: { allowed: false },
    can_leave: { allowed: true },
    can_rename: { allowed: false },
    can_archive: { allowed: false },
  },
  ...overrides,
})

const history_generation = record(1).history_generation
const list = (channels: ChannelList['channels']) => ok({ history_generation, channels })

describe('ChannelOverview UI', () => {
  it('gates rename, archive, and restore controls by Capabilities and archive state, and hides all controls for DMs', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)

      // 1. Ordinary channel without rename/archive capabilities
      const noCapInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({ name: 'secret', visibility: 'private' }),
          onrename: async () => null,
          onarchive: async () => null,
          onrestore: async () => null,
        },
      })
      flushSync()
      expect(host.textContent).toContain('secret')
      expect(host.textContent).toContain('非公開')
      expect(host.querySelector('form')).toBeNull()
      expect(host.querySelectorAll('button')).toHaveLength(0)
      await unmount(noCapInst)

      // 2. Active ordinary channel with can_rename + can_archive
      const activeInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({
            name: 'general',
            visibility: 'public',
            capabilities: {
              ...makeChannel().capabilities,
              can_rename: { allowed: true },
              can_archive: { allowed: true },
            },
          }),
          onrename: async () => null,
          onarchive: async () => null,
          onrestore: async () => null,
        },
      })
      flushSync()
      expect(host.textContent).toContain('公開')
      expect(host.querySelector('form')).not.toBeNull()
      expect(host.querySelectorAll('button').map(b => b.textContent.trim())).toEqual(['名前を変更', 'アーカイブ'])
      await unmount(activeInst)

      // 3. Archived ordinary channel with can_archive (can_rename denied): shows 復元, hides 名前を変更 and アーカイブ
      const archivedInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({
            name: 'old-room',
            archived: true,
            capabilities: {
              ...makeChannel().capabilities,
              can_rename: { allowed: false, reason: 'channel_archived' },
              can_archive: { allowed: true },
            },
          }),
          onrename: async () => null,
          onarchive: async () => null,
          onrestore: async () => null,
        },
      })
      flushSync()
      expect(host.textContent).toContain('アーカイブ済み')
      expect(host.querySelector('form')).toBeNull()
      expect(host.querySelectorAll('button').map(b => b.textContent.trim())).toEqual(['復元'])
      await unmount(archivedInst)

      // 4. DM shows no rename/archive/restore controls
      const dmChannel: DmDiscovery = { id: 'dm-1', kind: 'dm', peer: { id: 'u2', name: '佐藤 花子', active: true } }
      const dmInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: dmChannel,
          onrename: async () => null,
          onarchive: async () => null,
          onrestore: async () => null,
        },
      })
      flushSync()
      expect(host.querySelector('form')).toBeNull()
      expect(host.querySelectorAll('button')).toHaveLength(0)
      await unmount(dmInst)
    })
  })

  it('disables rename, archive and restore while the archived state is pending, so stale Capabilities cannot act', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const onrename = vi.fn(async () => null)
      const onarchive = vi.fn(async () => null)
      const onrestore = vi.fn(async () => null)
      const props = $state({ pending: true, archived: false })
      const inst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          get channel() {
            return makeChannel({
              name: 'general',
              archived: props.archived,
              capabilities: { ...makeChannel().capabilities, can_rename: { allowed: true }, can_archive: { allowed: true } },
            })
          },
          get pending() { return props.pending },
          onrename,
          onarchive,
          onrestore,
        },
      })
      flushSync()
      const buttons = () => host.querySelectorAll('button')
      const btn = (label: string) => buttons().find(b => b.textContent.trim() === label)
      const input = host.querySelector('input')!
      expect(input.disabled).toBe(true)
      expect(btn('名前を変更')!.disabled).toBe(true)
      expect(btn('アーカイブ')!.disabled).toBe(true)
      btn('アーカイブ')!.click()
      flushSync()
      expect(host.textContent).not.toContain('チャンネルをアーカイブしますか？')
      host.querySelector('form')!.dispatchEvent(new MiniEvent("submit"))
      flushSync()
      expect(onrename).not.toHaveBeenCalled()

      // Once the by-id read settles the controls work again; pending again closes an open confirmation.
      props.pending = false
      flushSync()
      expect(btn('アーカイブ')!.disabled).toBe(false)
      btn('アーカイブ')!.click()
      flushSync()
      expect(host.textContent).toContain('チャンネルをアーカイブしますか？')
      props.pending = true
      flushSync()
      expect(host.textContent).not.toContain('チャンネルをアーカイブしますか？')
      expect(onarchive).not.toHaveBeenCalled()

      // Restore is gated the same way for an archived Channel.
      props.archived = true
      flushSync()
      expect(btn('復元')!.disabled).toBe(true)
      btn('復元')!.click()
      flushSync()
      expect(host.textContent).not.toContain('チャンネルを復元しますか？')
      expect(onrestore).not.toHaveBeenCalled()
      await unmount(inst)
    })
  })

  it('confirms archive and restore via Dialog, cancels via button or Escape, prevents double submit, and announces results', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const archiveDeferred = deferred<string | null>()
      const onarchive = vi.fn(() => archiveDeferred.promise)
      const onrestore = vi.fn(async () => null)
      const onannounce = vi.fn()

      const inst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({
            name: 'general',
            capabilities: {
              ...makeChannel().capabilities,
              can_rename: { allowed: true },
              can_archive: { allowed: true },
            },
          }),
          onrename: async () => null,
          onarchive,
          onrestore,
          onannounce,
        },
      })
      flushSync()

      const btn = (label: string) => host.querySelectorAll('button').find(b => b.textContent.trim() === label)

      // Open archive confirmation, then cancel via button
      btn('アーカイブ')!.click()
      flushSync()
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain('チャンネルをアーカイブしますか？')
      btn('キャンセル')!.click()
      flushSync()
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(onarchive).not.toHaveBeenCalled()

      // Open archive confirmation again, then cancel via Escape
      btn('アーカイブ')!.click()
      flushSync()
      const dialog = host.querySelector('[role="dialog"]')!
      dialog.keydown('Escape')
      flushSync()
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(onarchive).not.toHaveBeenCalled()

      // Open archive confirmation and confirm: pending disables double submit & Escape
      btn('アーカイブ')!.click()
      flushSync()
      const confirmBtn = host.querySelector('[role="dialog"]')!.querySelectorAll('button').find(b => b.textContent.trim() === 'アーカイブ')!
      confirmBtn.click()
      flushSync()
      expect(onarchive).toHaveBeenCalledTimes(1)
      expect(confirmBtn.disabled).toBe(true)
      confirmBtn.click()
      host.querySelector('[role="dialog"]')!.keydown('Escape')
      flushSync()
      expect(onarchive).toHaveBeenCalledTimes(1)
      expect(host.querySelector('[role="dialog"]')).not.toBeNull()

      archiveDeferred.resolve(null)
      await flush()
      flushSync()
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(onannounce).toHaveBeenCalledWith('チャンネルをアーカイブしました。')
      await unmount(inst)

      // Restore confirmation + confirm
      const restoreInst = mount(ChannelOverview, {
        target: host as unknown as Element,
        props: {
          channel: makeChannel({
            name: 'general',
            archived: true,
            capabilities: { ...makeChannel().capabilities, can_archive: { allowed: true } },
          }),
          onrename: async () => null,
          onarchive,
          onrestore,
          onannounce,
        },
      })
      flushSync()
      btn('復元')!.click()
      flushSync()
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain('チャンネルを復元しますか？')
      const confirmRestore = host.querySelector('[role="dialog"]')!.querySelectorAll('button').find(b => b.textContent.trim() === '復元')!
      confirmRestore.click()
      await flush()
      flushSync()
      expect(onrestore).toHaveBeenCalledTimes(1)
      expect(onannounce).toHaveBeenCalledWith('チャンネルを復元しました。')
      await unmount(restoreInst)
    })
  })

  it('validates rename via the channels controller, shows Japanese refusal text in role="alert", and disables while pending', async () => {
    await withDom(async (doc) => {
      const net = fakeNetwork()
      const pendingPatch = deferred<Result<undefined>>()
      const updateChannel = vi.fn<NonNullable<ChannelsApi['updateChannel']>>()
        .mockResolvedValueOnce(http(409, 'channel name already exists'))
        .mockReturnValueOnce(pendingPatch.promise)
      const session = createSession({
        selfId: 'me',
        organizationId: 'org',
        onEnded: vi.fn(),
        ...net.options(),
        channelsApi: {
          listChannels: async () => list([row({ id: 'ch-1', name: 'general' })]),
          createChannel: vi.fn(),
          updateChannel,
        },
      })
      const adapter = channelsAdapter(session.channels)
      const onannounce = vi.fn()
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      try {
        const inst = mount(ChannelOverview, {
          target: host as unknown as Element,
          props: {
            channel: makeChannel({
              id: 'ch-1',
              name: 'general',
              capabilities: { ...makeChannel().capabilities, can_rename: { allowed: true } },
            }),
            onrename: (name) => adapter.rename('ch-1', name),
            onarchive: () => adapter.archive('ch-1'),
            onrestore: () => adapter.restore('ch-1'),
            onannounce,
          },
        })
        flushSync()

        const input = host.querySelector('input')!
        const submitBtn = host.querySelectorAll('button').find(b => b.textContent.trim() === '名前を変更')!

        // 1. Over-length client check
        input.input('あ'.repeat(129))
        flushSync()
        submitBtn.click()
        flushSync()
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('チャンネル名は128文字以内にしてください。')
        expect(updateChannel).not.toHaveBeenCalled()

        // 2. Server 409 refusal via controller
        input.input('existing')
        flushSync()
        submitBtn.click()
        await flush()
        flushSync()
        expect(updateChannel).toHaveBeenCalledWith('ch-1', { name: 'existing' })
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('同じ名前のチャンネルがすでにあります。')

        // 3. Pending state disables double submit; resolves with announcement
        input.input('renamed')
        flushSync()
        submitBtn.click()
        flushSync()
        expect(updateChannel).toHaveBeenCalledTimes(2)
        expect(submitBtn.disabled).toBe(true)
        expect(input.disabled).toBe(true)
        submitBtn.click()
        expect(updateChannel).toHaveBeenCalledTimes(2)

        pendingPatch.resolve(ok(undefined))
        await flush()
        flushSync()
        expect(host.querySelector('[role="alert"]')).toBeNull()
        expect(onannounce).toHaveBeenCalledWith('チャンネル名を変更しました。')
        await unmount(inst)
      } finally {
        session.close()
      }
    })
  })
})

describe('ArchivedChannelList UI', () => {
  it('shows no Unread/Mention badges or DMs and releases on collapse when no archived Channel is selected', async () => {
    vi.useFakeTimers()
    try {
      await withDom(async (doc) => {
        const net = fakeNetwork()
        const archivedRow = {
          ...row({ id: 'arch-1', name: 'archived-room', unread_count: 5, main_unread_count: 5, mention_unread_count: 2, main_mention_unread_count: 2 }),
          archived: true,
        }
        const activeRow = row({ id: 'act-1', name: 'general' })
        const listArchivedChannels = vi.fn<NonNullable<ChannelsApi['listArchivedChannels']>>(async () => list([archivedRow]))
        const session = createSession({
          selfId: 'me',
          organizationId: 'org',
          onEnded: vi.fn(),
          ...net.options(),
          channelsApi: {
            listChannels: async () => list([activeRow]),
            listArchivedChannels,
            createChannel: vi.fn(),
          },
          dmsApi: {
            changes: async () => ok({ dms: [dm('dm-1')], next_cursor: '', caught_up: true }),
            list: async () => ok({ history_generation, dms: [dm('dm-1')], next_cursor: null }),
            open: vi.fn(),
          },
        })
        net.socket.onReady()
        const adapter = channelsAdapter(session.channels)
        const onselect = vi.fn()
        const host = doc.createElement('div')
        doc.body.appendChild(host)

        try {
          await flush()
          // Reactive wrapper reading adapter.state.archivedList
          const props = $state<{ list: ReturnType<typeof channelsAdapter>['state']['archivedList'] }>({ list: undefined })
          const stop = $effect.root(() => {
            $effect(() => { props.list = adapter.state.archivedList })
          })
          const inst = mount(ArchivedChannelList, {
            target: host as unknown as Element,
            props: {
              get list() { return props.list },
              selectedId: null,
              onhold: () => adapter.holdArchived(),
              onretry: () => adapter.retryArchived(),
              onselect,
            },
          })
          flushSync()

          // Initially collapsed: archived list is NOT held or fetched
          const details = host.querySelector('details')!
          const toggle = host.querySelector('summary')!
          expect(details.open).toBe(false)
          expect(listArchivedChannels).not.toHaveBeenCalled()

          // Expand: holds target and fetches archived channels
          toggle.click()
          flushSync()
          await vi.advanceTimersByTimeAsync(200)
          flushSync()
          expect(details.open).toBe(true)
          expect(listArchivedChannels).toHaveBeenCalledTimes(1)

          const items = host.querySelectorAll('li')
          expect(items).toHaveLength(1)
          expect(items[0].textContent).toContain('archived-room')
          // No Unread or Mention badge or total, and no DMs
          expect(host.querySelectorAll('.ui-badge')).toHaveLength(0)
          expect(host.textContent).not.toContain('未読')
          expect(host.textContent).not.toContain('5')
          expect(host.textContent).not.toContain('dm-1')

          // Clicking an archived channel selects it
          items[0].querySelector('button')!.click()
          expect(onselect).toHaveBeenCalledWith('arch-1')

          // Collapse: releases hold and clears archivedList
          toggle.click()
          flushSync()
          expect(details.open).toBe(false)
          expect(adapter.state.archivedList).toBeUndefined()
          listArchivedChannels.mockClear()
          net.event({ type: 'channel_list_changed' })
          await vi.advanceTimersByTimeAsync(300)
          expect(listArchivedChannels).not.toHaveBeenCalled()

          await unmount(inst)
          stop()
        } finally {
          session.close()
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens and closes via click and keyboard (Enter/Space) and mounts content only when open', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const release = vi.fn()
      const onhold = vi.fn(() => release)
      const archivedRow = { ...row({ id: 'arch-1', name: 'archived-room' }), archived: true }
      const inst = mount(ArchivedChannelList, {
        target: host as unknown as Element,
        props: {
          list: { status: 'ready', channels: [archivedRow] },
          selectedId: null,
          onhold,
          onretry: vi.fn(),
          onselect: vi.fn(),
        },
      })
      flushSync()

      const details = host.querySelector('details')!
      const summary = host.querySelector('summary')!
      expect(details.open).toBe(false)
      expect(details.inert).toBe(false)
      expect(host.querySelector('.archived-list__body')).toBeNull()
      expect(onhold).not.toHaveBeenCalled()

      // Click opens and mounts content
      summary.click()
      flushSync()
      expect(details.open).toBe(true)
      expect(host.querySelector('.archived-list__body')).not.toBeNull()
      expect(host.querySelectorAll('li')).toHaveLength(1)
      expect(onhold).toHaveBeenCalledTimes(1)

      // Click closes and unmounts content
      summary.click()
      flushSync()
      expect(details.open).toBe(false)
      expect(host.querySelector('.archived-list__body')).toBeNull()
      expect(release).toHaveBeenCalledTimes(1)

      // Enter opens, Space closes
      summary.keydown('Enter')
      flushSync()
      expect(details.open).toBe(true)
      expect(host.querySelector('.archived-list__body')).not.toBeNull()
      expect(onhold).toHaveBeenCalledTimes(2)

      summary.keydown(' ')
      flushSync()
      expect(details.open).toBe(false)
      expect(host.querySelector('.archived-list__body')).toBeNull()
      expect(release).toHaveBeenCalledTimes(2)

      // Space opens, Enter closes
      summary.keydown(' ')
      flushSync()
      expect(details.open).toBe(true)
      expect(host.querySelector('.archived-list__body')).not.toBeNull()
      expect(onhold).toHaveBeenCalledTimes(3)

      summary.keydown('Enter')
      flushSync()
      expect(details.open).toBe(false)
      expect(host.querySelector('.archived-list__body')).toBeNull()
      expect(release).toHaveBeenCalledTimes(3)

      await unmount(inst)
    })
  })

  it('prevents opening while disabled and collapses/unmounts if disabled while open', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)
      const release = vi.fn()
      const onhold = vi.fn(() => release)
      const archivedRow = { ...row({ id: 'arch-1', name: 'archived-room' }), archived: true }
      const state = $state({ disabled: true })
      const inst = mount(ArchivedChannelList, {
        target: host as unknown as Element,
        props: {
          list: { status: 'ready', channels: [archivedRow] },
          selectedId: null,
          get disabled() { return state.disabled },
          onhold,
          onretry: vi.fn(),
          onselect: vi.fn(),
        },
      })
      flushSync()

      const details = host.querySelector('details')!
      const summary = host.querySelector('summary')!
      expect(details.inert).toBe(true)
      expect(details.open).toBe(false)
      expect(host.querySelector('.archived-list__body')).toBeNull()

      // Click and keyboard cannot open while disabled
      summary.click()
      summary.keydown('Enter')
      summary.keydown(' ')
      flushSync()
      expect(details.open).toBe(false)
      expect(host.querySelector('.archived-list__body')).toBeNull()
      expect(onhold).not.toHaveBeenCalled()

      // Even a direct open mutation is rejected while disabled
      details.open = true
      flushSync()
      expect(details.open).toBe(false)
      expect(host.querySelector('.archived-list__body')).toBeNull()
      expect(onhold).not.toHaveBeenCalled()

      // Re-enabling allows opening; disabling again collapses, unmounts and releases hold
      state.disabled = false
      flushSync()
      expect(details.inert).toBe(false)
      summary.click()
      flushSync()
      expect(details.open).toBe(true)
      expect(host.querySelector('.archived-list__body')).not.toBeNull()
      expect(onhold).toHaveBeenCalledTimes(1)

      state.disabled = true
      flushSync()
      expect(details.inert).toBe(true)
      expect(details.open).toBe(false)
      expect(host.querySelector('.archived-list__body')).toBeNull()
      expect(release).toHaveBeenCalledTimes(1)

      await unmount(inst)
    })
  })
})

describe('ArchivedChannelList retry', () => {
  it('re-reads the archived list on 再試行 even while an open archived Channel keeps it held', async () => {
    vi.useFakeTimers()
    try {
      await withDom(async (doc) => {
        const net = fakeNetwork()
        const archivedRow = { ...row({ id: 'arch-1', name: 'archived-room' }), archived: true }
        const listArchivedChannels = vi.fn<NonNullable<ChannelsApi['listArchivedChannels']>>(async () => list([archivedRow]))
        listArchivedChannels.mockResolvedValueOnce(http(400, 'bad_request'))
        const session = createSession({
          selfId: 'me',
          organizationId: 'org',
          onEnded: vi.fn(),
          ...net.options(),
          channelsApi: {
            listChannels: async () => list([row({ id: 'act-1', name: 'general' })]),
            listArchivedChannels,
            getChannel: async () => ok(archivedRow),
            createChannel: vi.fn(),
          },
        })
        net.socket.onReady()
        const adapter = channelsAdapter(session.channels)
        const host = doc.createElement('div')
        doc.body.appendChild(host)
        try {
          // Opening the archived Channel by link holds the archived list, and its first read fails.
          adapter.selectHint('arch-1')
          await vi.advanceTimersByTimeAsync(200)
          expect(listArchivedChannels).toHaveBeenCalledTimes(1)
          expect(adapter.state.archivedList?.status).toBe('error')

          const props = $state<{ list: ReturnType<typeof channelsAdapter>['state']['archivedList'] }>({ list: undefined })
          const stop = $effect.root(() => {
            $effect(() => { props.list = adapter.state.archivedList })
          })
          const inst = mount(ArchivedChannelList, {
            target: host as unknown as Element,
            props: {
              get list() { return props.list },
              selectedId: 'arch-1',
              onhold: () => adapter.holdArchived(),
              onretry: () => adapter.retryArchived(),
              onselect: vi.fn(),
            },
          })
          flushSync()
          host.querySelector('summary')!.click()
          flushSync()
          await vi.advanceTimersByTimeAsync(300)
          flushSync()
          // Expanding re-uses the held list; a failed read is not retried on its own.
          expect(listArchivedChannels).toHaveBeenCalledTimes(1)
          const retry = host.querySelectorAll('button').find(b => b.textContent.trim() === '再試行')!
          expect(retry).toBeDefined()

          retry.click()
          await flush()
          flushSync()
          expect(listArchivedChannels).toHaveBeenCalledTimes(2)
          expect(adapter.state.archivedList?.status).toBe('ready')
          expect(host.querySelectorAll('li').map(li => li.textContent)).toEqual([expect.stringContaining('archived-room')])
          expect(host.textContent).not.toContain('再試行')

          await unmount(inst)
          stop()
        } finally {
          session.close()
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Archived Channel read-only notice and disabled composers', () => {
  it('disables main Composer and shows read-only notice with disabled Reply composer while keeping history readable', async () => {
    await withDom(async (doc) => {
      const host = doc.createElement('div')
      doc.body.appendChild(host)

      // 1. Composer disabled in an archived channel
      const onsubmit = vi.fn(async () => true)
      const composerInst = mount(Composer, {
        target: host as unknown as Element,
        props: {
          value: '下書き',
          disabled: true,
          oninput: () => {},
          onsubmit,
        },
      })
      flushSync()
      expect(host.querySelector('textarea')!.disabled).toBe(true)
      expect(host.querySelector('button')!.disabled).toBe(true)
      host.querySelector('button')!.click()
      expect(onsubmit).not.toHaveBeenCalled()
      await unmount(composerInst)

      // 2. ReplyPanel in an archived channel: shows read-only notice, disables Reply composer, keeps history readable
      const net = fakeNetwork()
      const msg = record(1, 'arch-1')
      net.pages['arch-1'] = ok({ history_generation, as_of_seq: 1, messages: [msg], has_more: false })
      const session = createSession({
        selfId: 'me',
        organizationId: 'org',
        onEnded: vi.fn(),
        ...net.options(),
        repliesApi: {
          listReplyChain: async () => ok({
            history_generation,
            as_of_seq: 1,
            root_id: msg.id,
            chain_version: 1,
            messages: [msg],
            has_more: false,
          }),
        },
      })
      net.socket.onReady()
      const sync = syncAdapter(session.sync)
      const replies = repliesAdapter(session.replies, 'arch-1')
      try {
        await session.sync.watch('arch-1')
        await replies.open(msg)
        const replyInst = mount(ReplyPanel, {
          target: host as unknown as Element,
          props: {
            channel: sync.channel('arch-1'),
            replies,
            channelId: 'arch-1',
            anchorMessageId: msg.id,
            resolvedAnchor: msg,
            selfId: 'me',
            sendDisabled: true,
            archived: true,
          },
        })
        flushSync()
        expect(host.textContent).toContain('このチャンネルはアーカイブされています。')
        expect(host.textContent).toContain(msg.body)
        expect(host.querySelector('textarea')!.disabled).toBe(true)
        const sendBtn = host.querySelectorAll('button').find(b => b.textContent.trim() === '送信')!
        expect(sendBtn.disabled).toBe(true)
        await unmount(replyInst)
      } finally {
        session.close()
      }
    })
  })
})
