import { flushSync, mount, tick, unmount } from 'svelte'
import { parse, type AST } from 'svelte/compiler'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { lookupAuthors, Member, ReadPosition, Result } from './api'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { createSession } from './session'
import { repliesAdapter } from './replies.svelte'
import { syncAdapter } from './sync.svelte'
import Timeline from './Timeline.svelte'
import TopicView from './TopicView.svelte'
import { topicsAdapter, type TopicsAdapter } from './topics.svelte'
import { unreadAdapter } from './unread.svelte'
import MessageRow from './ui/MessageRow.svelte'
import { senderName } from './authors'
import { createMembers } from './members'
import { membersAdapter } from './members.svelte'
import Workspace from './Workspace.svelte'
import CreateChannelForm from './CreateChannelForm.svelte'

type ListenerEntry = {
  fn: (event: MiniDomEvent) => void
  capture: boolean
}

class MiniDomEvent {
  readonly type: string
  readonly bubbles: boolean
  readonly cancelable: boolean
  defaultPrevented = false
  cancelBubble = false
  target: unknown = null
  currentTarget: unknown = null
  key = ''
  shiftKey = false
  altKey = false
  ctrlKey = false
  metaKey = false
  isComposing = false
  keyCode = 0
  private path: MiniEventTarget[] = []

  constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean }) {
    this.type = type
    this.bubbles = init?.bubbles ?? false
    this.cancelable = init?.cancelable ?? false
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.cancelBubble = true
  }

  composedPath(): MiniEventTarget[] {
    return this.path
  }

  setPath(path: MiniEventTarget[]): void {
    this.path = path
  }
}

class MiniEventTarget {
  private readonly listeners = new Map<string, ListenerEntry[]>()

  addEventListener(
    type: string,
    fn: ((event: MiniDomEvent) => void) | null,
    options?: boolean | { capture?: boolean },
  ): void {
    if (!fn) return
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
    const list = this.listeners.get(type) ?? []
    if (!list.some((e) => e.fn === fn && e.capture === capture)) {
      list.push({ fn, capture })
      this.listeners.set(type, list)
    }
  }

  removeEventListener(
    type: string,
    fn: ((event: MiniDomEvent) => void) | null,
    options?: boolean | { capture?: boolean },
  ): void {
    if (!fn) return
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
    const list = this.listeners.get(type)
    if (!list) return
    const idx = list.findIndex((e) => e.fn === fn && e.capture === capture)
    if (idx !== -1) list.splice(idx, 1)
  }

  dispatchEvent(event: MiniDomEvent): boolean {
    const path = this.buildEventPath()
    event.target = this
    event.setPath(path)

    for (let i = path.length - 1; i >= 0; i--) {
      if (event.cancelBubble) break
      path[i].invokeListeners(event, true)
    }
    const maxBubble = event.bubbles ? path.length : 1
    for (let i = 0; i < maxBubble; i++) {
      if (event.cancelBubble) break
      path[i].invokeListeners(event, false)
    }
    return !event.defaultPrevented
  }

  protected buildEventPath(): MiniEventTarget[] {
    return [this]
  }

  private invokeListeners(event: MiniDomEvent, capture: boolean): void {
    const list = this.listeners.get(event.type)
    if (!list || list.length === 0) return
    for (const entry of [...list]) {
      if (entry.capture !== capture) continue
      Object.defineProperty(event, 'currentTarget', {
        configurable: true,
        get: () => this,
      })
      entry.fn.call(this, event)
    }
  }
}

class MiniNode extends MiniEventTarget {
  readonly nodeType: number
  readonly nodeName: string
  parentNode: MiniNode | null = null
  childNodes: MiniNode[] = []
  ownerDocument: MiniDocument | null = null

  constructor(nodeType: number, nodeName: string, ownerDocument: MiniDocument | null) {
    super()
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = ownerDocument
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get nextSibling(): MiniNode | null {
    if (!this.parentNode) return null
    const idx = this.parentNode.childNodes.indexOf(this)
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null
  }

  get previousSibling(): MiniNode | null {
    if (!this.parentNode) return null
    const idx = this.parentNode.childNodes.indexOf(this)
    return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null
  }

  get parentElement(): MiniElement | null {
    return this.parentNode instanceof MiniElement ? this.parentNode : null
  }

  get children(): MiniElement[] {
    return this.childNodes.filter((c): c is MiniElement => c instanceof MiniElement)
  }

  get isConnected(): boolean {
    let cur: MiniNode | null = this
    while (cur) {
      if (cur.nodeType === 9) return true
      cur = cur.parentNode
    }
    return false
  }

  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) {
      return (this as unknown as MiniCharacterData).data
    }
    return this.childNodes.map((c) => c.textContent).join('')
  }

  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    if (value !== '' && this.ownerDocument) {
      this.appendChild(this.ownerDocument.createTextNode(value))
    }
  }

  getRootNode(): MiniNode {
    let cur: MiniNode = this
    while (cur.parentNode) cur = cur.parentNode
    return cur
  }

  contains(other: MiniNode | null): boolean {
    let cur = other
    while (cur) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }

  appendChild<T extends MiniNode>(child: T): T {
    return this.insertBefore(child, null)
  }

  insertBefore<T extends MiniNode>(child: T, ref: MiniNode | null): T {
    if (child.nodeType === 11) {
      for (const grand of [...child.childNodes]) {
        this.insertBefore(grand, ref)
      }
      return child
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child)
    }
    child.parentNode = this
    if (ref === null) {
      this.childNodes.push(child)
    } else {
      const idx = this.childNodes.indexOf(ref)
      if (idx === -1) this.childNodes.push(child)
      else this.childNodes.splice(idx, 0, child)
    }
    return child
  }

  removeChild<T extends MiniNode>(child: T): T {
    const idx = this.childNodes.indexOf(child)
    if (idx !== -1) {
      this.childNodes.splice(idx, 1)
      child.parentNode = null
    }
    return child
  }

  append(...nodes: (MiniNode | string)[]): void {
    for (const n of nodes) {
      const node = typeof n === 'string' ? (this.ownerDocument ?? (this as unknown as MiniDocument)).createTextNode(n) : n
      this.appendChild(node)
    }
  }

  prepend(...nodes: (MiniNode | string)[]): void {
    const ref = this.firstChild
    for (const n of nodes) {
      const node = typeof n === 'string' ? (this.ownerDocument ?? (this as unknown as MiniDocument)).createTextNode(n) : n
      this.insertBefore(node, ref)
    }
  }

  replaceWith(...nodes: MiniNode[]): void {
    if (!this.parentNode) return
    for (const n of nodes) this.parentNode.insertBefore(n, this)
    this.remove()
  }

  before(...nodes: MiniNode[]): void {
    if (!this.parentNode) return
    for (const n of nodes) this.parentNode.insertBefore(n, this)
  }

  after(...nodes: MiniNode[]): void {
    if (!this.parentNode) return
    const ref = this.nextSibling
    for (const n of nodes) this.parentNode.insertBefore(n, ref)
  }

  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  cloneNode(deep = false): MiniNode {
    throw new Error(`cloneNode(${deep}) must be implemented by subclass`)
  }

  protected override buildEventPath(): MiniEventTarget[] {
    const path: MiniEventTarget[] = []
    let cur: MiniNode | null = this
    while (cur) {
      path.push(cur)
      cur = cur.parentNode
    }
    if (this.ownerDocument && path[path.length - 1] === this.ownerDocument && this.ownerDocument.defaultView) {
      path.push(this.ownerDocument.defaultView)
    }
    return path
  }
}

class MiniCharacterData extends MiniNode {
  data: string

  constructor(nodeType: 3 | 8, nodeName: string, data: string, ownerDocument: MiniDocument | null) {
    super(nodeType, nodeName, ownerDocument)
    this.data = data
  }

  get nodeValue(): string {
    return this.data
  }

  set nodeValue(v: string) {
    this.data = v
  }

  override cloneNode(): MiniCharacterData {
    return new MiniCharacterData(this.nodeType as 3 | 8, this.nodeName, this.data, this.ownerDocument)
  }
}

class MiniText extends MiniCharacterData {
  constructor(data: string, ownerDocument: MiniDocument | null) {
    super(3, '#text', data, ownerDocument)
  }

  override cloneNode(): MiniText {
    return new MiniText(this.data, this.ownerDocument)
  }
}

class MiniComment extends MiniCharacterData {
  constructor(data: string, ownerDocument: MiniDocument | null) {
    super(8, '#comment', data, ownerDocument)
  }

  override cloneNode(): MiniComment {
    return new MiniComment(this.data, this.ownerDocument)
  }
}

class MiniDocumentFragment extends MiniNode {
  constructor(ownerDocument: MiniDocument | null) {
    super(11, '#document-fragment', ownerDocument)
  }

  override cloneNode(deep = false): MiniDocumentFragment {
    const copy = new MiniDocumentFragment(this.ownerDocument)
    if (deep) {
      for (const c of this.childNodes) copy.appendChild(c.cloneNode(true))
    }
    return copy
  }

  querySelector(selector: string): MiniElement | null {
    return queryFirst(this, selector)
  }

  querySelectorAll(selector: string): MiniElement[] {
    return queryAll(this, selector)
  }
}

class MiniElement extends MiniNode {
  readonly tagName: string
  readonly localName: string
  private readonly attrs = new Map<string, string>()
  private _value = ''
  defaultValue = ''
  checked = false
  selectionStart: number | null = 0
  selectionEnd: number | null = 0
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0
  layoutRowHeight = 0
  readonly content: MiniDocumentFragment
  readonly style = {
    setProperty() {},
    removeProperty() {},
    getPropertyValue() {
      return ''
    },
  }
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

  constructor(tagName: string, ownerDocument: MiniDocument | null) {
    const upper = tagName.toUpperCase()
    super(1, upper, ownerDocument)
    this.tagName = upper
    this.localName = tagName.toLowerCase()
    this.content = new MiniDocumentFragment(ownerDocument)
  }

  get id(): string {
    return this.attrs.get('id') ?? ''
  }

  set id(v: string) {
    this.setAttribute('id', v)
  }

  get className(): string {
    return this.attrs.get('class') ?? ''
  }

  set className(v: string) {
    this.setAttribute('class', v)
  }

  get disabled(): boolean {
    return this.attrs.has('disabled')
  }

  set disabled(v: boolean) {
    if (v) this.attrs.set('disabled', '')
    else this.attrs.delete('disabled')
  }

  get type(): string {
    return this.attrs.get('type') ?? (this.tagName === 'BUTTON' ? 'submit' : '')
  }

  set type(v: string) {
    this.setAttribute('type', v)
  }

  get name(): string {
    return this.attrs.get('name') ?? ''
  }

  set name(v: string) {
    this.setAttribute('name', v)
  }

  get placeholder(): string {
    return this.attrs.get('placeholder') ?? ''
  }

  set placeholder(v: string) {
    this.setAttribute('placeholder', v)
  }

  get required(): boolean {
    return this.attrs.has('required')
  }

  set required(v: boolean) {
    if (v) this.attrs.set('required', '')
    else this.attrs.delete('required')
  }

  get rows(): number {
    return Number(this.attrs.get('rows') ?? 2)
  }

  set rows(v: number) {
    this.setAttribute('rows', String(v))
  }

  get tabIndex(): number {
    if (this.attrs.has('tabindex')) return Number(this.attrs.get('tabindex'))
    return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) ? 0 : -1
  }

  set tabIndex(v: number) {
    this.setAttribute('tabindex', String(v))
  }

  get value(): string {
    return this._value
  }

  set value(v: string) {
    this._value = String(v ?? '')
  }

  get options(): MiniElement[] {
    return this.querySelectorAll('option')
  }

  set innerHTML(html: string) {
    const target = this.tagName === 'TEMPLATE' ? this.content : this
    for (const c of target.childNodes) c.parentNode = null
    target.childNodes = []
    if (!html || !this.ownerDocument) return
    const ast = parse(html, { modern: true })
    appendAstNodes(ast.fragment.nodes, target, this.ownerDocument)
  }

  get innerHTML(): string {
    return this.textContent
  }

  setAttribute(name: string, value: string | null): void {
    const key = name.toLowerCase()
    if (value === null) {
      this.attrs.delete(key)
      return
    }
    this.attrs.set(key, String(value))
    if (key === 'value') {
      this.defaultValue = String(value)
      this._value = String(value)
    }
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null
  }

  getAttributeNames(): string[] {
    return [...this.attrs.keys()]
  }

  get attributes(): Array<{ name: string; value: string }> {
    return [...this.attrs].map(([name, value]) => ({ name, value }))
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name.toLowerCase())
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name.toLowerCase())
  }

  focus(): void {
    if (this.disabled || !this.isConnected || !this.ownerDocument) return
    this.ownerDocument.activeElement = this
  }

  click(): void {
    if (this.disabled) return
    this.focus()
    const evt = new MiniDomEvent('click', { bubbles: true, cancelable: true })
    this.dispatchEvent(evt)
    if (!evt.defaultPrevented && this.tagName === 'BUTTON' && (this.getAttribute('type') ?? 'submit') === 'submit') {
      const form = this.closest('form')
      form?.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
    }
  }

  get hidden(): boolean {
    return this.attrs.has('hidden')
  }

  set hidden(v: boolean) {
    if (v) this.setAttribute('hidden', '')
    else this.removeAttribute('hidden')
  }

  isRenderedVisible(): boolean {
    if (!this.isConnected || !this.ownerDocument) return false
    if (this.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    const width = this.ownerDocument.defaultView?.innerWidth ?? 1280
    const channelColumn = this.closest('.channel-column')
    if (channelColumn) {
      const workspace = channelColumn.closest('.workspace')
      if (workspace) {
        if (width >= 600 && width < 960 && workspace.getAttribute('data-drawer-open') !== 'true') {
          return false
        }
        if (width < 600 && workspace.getAttribute('data-mobile-level') !== 'channels') {
          return false
        }
      }
    }
    const mainCard = this.closest('.main-card')
    if (mainCard) {
      const workspace = mainCard.closest('.workspace')
      if (workspace && width < 600 && workspace.getAttribute('data-mobile-level') !== 'view') {
        return false
      }
    }
    const rightPanelSlot = this.closest('.right-panel-slot')
    if (rightPanelSlot) {
      const workspace = rightPanelSlot.closest('.workspace')
      if (workspace && width < 600 && workspace.getAttribute('data-mobile-level') !== 'panel') {
        return false
      }
    }
    return true
  }

  getBoundingClientRect() {
    if (!this.isRenderedVisible()) {
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
    }
    if (this.layoutRowHeight > 0) {
      const h = this.clientHeight || 100
      return { top: 0, bottom: h, left: 0, right: 260, width: 260, height: h, x: 0, y: 0, toJSON: () => ({}) }
    }
    const item = this.hasAttribute('data-message-id') ? this : this.closest('[data-message-id]')
    if (item) {
      const scroller = item.closest('.timeline-scroll, .topic-view__scroll')
      if (scroller && scroller.layoutRowHeight > 0) {
        const items = scroller.querySelectorAll('[data-message-id]')
        const idx = items.indexOf(item)
        if (idx >= 0) {
          const rowH = scroller.layoutRowHeight
          const top = idx * rowH - scroller.scrollTop
          const bottom = top + rowH
          return { top, bottom, left: 0, right: 260, width: 260, height: rowH, x: 0, y: top, toJSON: () => ({}) }
        }
      }
    }
    return { top: 0, bottom: 24, left: 0, right: 260, width: 260, height: 24, x: 0, y: 0, toJSON: () => ({}) }
  }

  getClientRects() {
    if (!this.isRenderedVisible()) return []
    return [this.getBoundingClientRect()]
  }

  closest(selector: string): MiniElement | null {
    let cur: MiniElement | null = this
    while (cur) {
      if (matchesSelectorList(cur, selector)) return cur
      cur = cur.parentElement
    }
    return null
  }

  matches(selector: string): boolean {
    return matchesSelectorList(this, selector)
  }

  querySelector(selector: string): MiniElement | null {
    return queryFirst(this, selector)
  }

  querySelectorAll(selector: string): MiniElement[] {
    return queryAll(this, selector)
  }

  override cloneNode(deep = false): MiniElement {
    const copy = new MiniElement(this.localName, this.ownerDocument)
    for (const [k, v] of this.attrs) copy.attrs.set(k, v)
    copy._value = this._value
    copy.defaultValue = this.defaultValue
    copy.checked = this.checked
    if (deep) {
      for (const c of this.childNodes) copy.appendChild(c.cloneNode(true))
      for (const c of this.content.childNodes) copy.content.appendChild(c.cloneNode(true))
    }
    return copy
  }
}

class MiniDocument extends MiniNode {
  readonly head: MiniElement
  readonly body: MiniElement
  activeElement: MiniElement | null = null
  defaultView: MiniWindow | null = null
  visibilityState: 'visible' | 'hidden' = 'visible'

  constructor() {
    super(9, '#document', null)
    this.ownerDocument = this
    const html = new MiniElement('html', this)
    this.head = new MiniElement('head', this)
    this.body = new MiniElement('body', this)
    html.appendChild(this.head)
    html.appendChild(this.body)
    this.appendChild(html)
    this.activeElement = this.body
  }

  createElement(tag: string): MiniElement {
    return new MiniElement(tag, this)
  }

  createElementNS(_ns: string, tag: string): MiniElement {
    return new MiniElement(tag, this)
  }

  createTextNode(data = ''): MiniText {
    return new MiniText(data, this)
  }

  createComment(data = ''): MiniComment {
    return new MiniComment(data, this)
  }

  createDocumentFragment(): MiniDocumentFragment {
    return new MiniDocumentFragment(this)
  }

  importNode<T extends MiniNode>(node: T, deep = false): T {
    return node.cloneNode(deep) as T
  }

  querySelector(selector: string): MiniElement | null {
    return queryFirst(this, selector)
  }

  querySelectorAll(selector: string): MiniElement[] {
    return queryAll(this, selector)
  }

  reset(): void {
    this.head.textContent = ''
    this.body.textContent = ''
    this.activeElement = this.body
    this.visibilityState = 'visible'
  }
}

class MiniWindow extends MiniEventTarget {
  readonly document: MiniDocument
  innerWidth = 1280
  innerHeight = 800
  scrollX = 0
  scrollY = 0

  constructor(doc: MiniDocument) {
    super()
    this.document = doc
    doc.defaultView = this
  }

  getComputedStyle(el: MiniElement): { display: string; visibility: string } {
    return {
      display: el.isRenderedVisible() ? 'block' : 'none',
      visibility: 'visible',
    }
  }
}

function appendAstNodes(nodes: AST.TemplateNode[], parent: MiniNode, doc: MiniDocument): void {
  for (const node of nodes) {
    if (node.type === 'Text') {
      parent.appendChild(doc.createTextNode(node.data))
    } else if (node.type === 'Comment') {
      parent.appendChild(doc.createComment(node.data))
    } else if (node.type === 'RegularElement') {
      const el = doc.createElement(node.name)
      for (const attr of node.attributes) {
        if (attr.type === 'Attribute') {
          if (attr.value === true) {
            el.setAttribute(attr.name, '')
          } else if (Array.isArray(attr.value)) {
            const text = attr.value.map((chunk) => (chunk.type === 'Text' ? chunk.data : '')).join('')
            el.setAttribute(attr.name, text)
          }
        }
      }
      const childTarget = el.tagName === 'TEMPLATE' ? el.content : el
      appendAstNodes(node.fragment.nodes, childTarget, doc)
      parent.appendChild(el)
    }
  }
}

function splitTopLevelCommas(selector: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (quote) {
      if (ch === quote && selector[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(selector.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(selector.slice(start).trim())
  return parts.filter(Boolean)
}

function splitDescendantCombinators(selector: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (quote) {
      cur += ch
      if (ch === quote && selector[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '(' || ch === '[') {
      depth++
      cur += ch
    } else if (ch === ')' || ch === ']') {
      depth--
      cur += ch
    } else if (/\s/.test(ch) && depth === 0) {
      if (cur) {
        parts.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur) parts.push(cur)
  return parts
}

function matchesCompound(el: MiniElement, compound: string): boolean {
  let rest = compound.trim()
  while (rest.length > 0) {
    if (rest.startsWith(':not(')) {
      let depth = 1
      let i = 5
      while (i < rest.length && depth > 0) {
        if (rest[i] === '(') depth++
        else if (rest[i] === ')') depth--
        i++
      }
      const inner = rest.slice(5, i - 1)
      if (matchesCompound(el, inner)) return false
      rest = rest.slice(i)
    } else if (rest.startsWith(':disabled')) {
      if (!el.disabled) return false
      rest = rest.slice(':disabled'.length)
    } else if (rest.startsWith('#')) {
      const m = /^#([a-zA-Z0-9_-]+)/.exec(rest)
      if (!m || el.id !== m[1]) return false
      rest = rest.slice(m[0].length)
    } else if (rest.startsWith('.')) {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest)
      if (!m || !el.classList.contains(m[1])) return false
      rest = rest.slice(m[0].length)
    } else if (rest.startsWith('[')) {
      const end = rest.indexOf(']')
      if (end === -1) return false
      const raw = rest.slice(1, end).trim()
      const eq = raw.indexOf('=')
      if (eq === -1) {
        if (!el.hasAttribute(raw)) return false
      } else {
        const attrName = raw.slice(0, eq).trim()
        const attrVal = raw
          .slice(eq + 1)
          .trim()
          .replace(/^['"]|['"]$/g, '')
          .replace(/\\(.)/g, '$1')
        if (el.getAttribute(attrName) !== attrVal) return false
      }
      rest = rest.slice(end + 1)
    } else {
      const m = /^[a-zA-Z0-9_-]+/.exec(rest)
      if (!m || el.localName !== m[0].toLowerCase()) return false
      rest = rest.slice(m[0].length)
    }
  }
  return true
}

function matchesChain(el: MiniElement, chain: string[]): boolean {
  if (!matchesCompound(el, chain[chain.length - 1])) return false
  let cur = el.parentElement
  for (let i = chain.length - 2; i >= 0; i--) {
    while (cur && !matchesCompound(cur, chain[i])) {
      cur = cur.parentElement
    }
    if (!cur) return false
    cur = cur.parentElement
  }
  return true
}

function matchesSelectorList(el: MiniElement, selector: string): boolean {
  return splitTopLevelCommas(selector).some((part) => matchesChain(el, splitDescendantCombinators(part)))
}

function queryAll(root: MiniNode, selector: string): MiniElement[] {
  const out: MiniElement[] = []
  const visit = (node: MiniNode) => {
    for (const child of node.childNodes) {
      if (child instanceof MiniElement) {
        if (matchesSelectorList(child, selector)) out.push(child)
      }
      visit(child)
    }
  }
  visit(root)
  return out
}

function queryFirst(root: MiniNode, selector: string): MiniElement | null {
  return queryAll(root, selector)[0] ?? null
}

function buttonsByText(root: MiniNode, text: string): MiniElement[] {
  return queryAll(root, 'button').filter((b) => b.textContent.trim() === text)
}

const GLOBAL_KEYS = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLMediaElement',
  'Text',
  'Comment',
  'DocumentFragment',
  'MutationObserver',
  'CSS',
] as const

const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
let testDoc!: MiniDocument
let testWin!: MiniWindow

beforeAll(() => {
  for (const key of GLOBAL_KEYS) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  testDoc = new MiniDocument()
  testWin = new MiniWindow(testDoc)
  const patches: Record<string, unknown> = {
    window: testWin,
    document: testDoc,
    navigator: { userAgent: 'node' },
    Node: MiniNode,
    Element: MiniElement,
    HTMLElement: MiniElement,
    HTMLButtonElement: MiniElement,
    HTMLInputElement: MiniElement,
    HTMLTextAreaElement: MiniElement,
    HTMLSelectElement: MiniElement,
    HTMLMediaElement: class extends MiniElement {},
    Text: MiniText,
    Comment: MiniComment,
    DocumentFragment: MiniDocumentFragment,
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    },
    CSS: { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
  }
  for (const [k, v] of Object.entries(patches)) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  }
})

beforeEach(() => {
  testDoc.reset()
  testWin.innerWidth = 1280
  testWin.innerHeight = 800
})

afterAll(() => {
  for (const [key, desc] of savedGlobals) {
    if (desc) Object.defineProperty(globalThis, key, desc)
    else Reflect.deleteProperty(globalThis, key)
  }
})

afterEach(() => vi.useRealTimers())

describe('Channel creation visibility', () => {
  for (const visibility of ['public', 'private'] as const) {
    it(`submits ${visibility} from the form and resets to public after success`, async () => {
      const oncreate = vi.fn(async () => null)
      const host = testDoc.createElement('div')
      testDoc.body.appendChild(host)
      const instance = mount(CreateChannelForm, { target: host as unknown as Element, props: { oncreate } })
      await settle()
      expect(host.querySelector('legend')?.textContent).toBe('公開範囲')
      const publicRadio = host.querySelector('input[value="public"]')!
      const privateRadio = host.querySelector('input[value="private"]')!
      expect(publicRadio.checked).toBe(true)
      expect(privateRadio.checked).toBe(false)
      expect(publicRadio.closest('label')?.textContent).toContain('公開')
      expect(privateRadio.closest('label')?.textContent).toContain('非公開')
      const name = host.querySelector('input[name="channel_name"]')!
      name.value = '新しいチャンネル'
      name.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      if (visibility === 'private') {
        privateRadio.checked = true
        privateRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
      }
      await settle()
      buttonsByText(host, 'チャンネルを作成')[0]!.click()
      await settle()
      expect(oncreate).toHaveBeenCalledExactlyOnceWith('新しいチャンネル', visibility)
      expect(name.value).toBe('')
      expect(publicRadio.checked).toBe(true)
      expect(privateRadio.checked).toBe(false)
      await unmount(instance)
    })
  }

  for (const result of [null, '同じ名前のチャンネルがすでにあります。']) {
    it(`disables visibility choices while creation is pending and enables them after ${result === null ? 'success' : 'refusal'}`, async () => {
      let resolveCreate!: (result: string | null) => void
      const pending = new Promise<string | null>((resolve) => { resolveCreate = resolve })
      const oncreate = vi.fn(() => pending)
      const host = testDoc.createElement('div')
      testDoc.body.appendChild(host)
      const instance = mount(CreateChannelForm, { target: host as unknown as Element, props: { oncreate } })
      await settle()
      const fieldset = host.querySelector('fieldset')!
      const publicRadio = host.querySelector('input[value="public"]')!
      const privateRadio = host.querySelector('input[value="private"]')!
      expect(publicRadio.closest('fieldset')).toBe(fieldset)
      expect(privateRadio.closest('fieldset')).toBe(fieldset)
      // Mini DOM only models own disabled attributes; native radios also inherit from their fieldset.
      const isDisabled = (radio: MiniElement) => radio.disabled || Boolean(radio.closest('fieldset')?.disabled)
      expect(fieldset.disabled).toBe(false)
      expect(isDisabled(publicRadio)).toBe(false)
      expect(isDisabled(privateRadio)).toBe(false)
      const name = host.querySelector('input[name="channel_name"]')!
      name.value = '新しいチャンネル'
      name.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      await settle()
      buttonsByText(host, 'チャンネルを作成')[0]!.click()
      await settle()
      expect(oncreate).toHaveBeenCalledExactlyOnceWith('新しいチャンネル', 'public')
      expect(fieldset.disabled).toBe(true)
      expect(isDisabled(publicRadio)).toBe(true)
      expect(isDisabled(privateRadio)).toBe(true)
      resolveCreate(result)
      await settle()
      expect(fieldset.disabled).toBe(false)
      expect(isDisabled(publicRadio)).toBe(false)
      expect(isDisabled(privateRadio)).toBe(false)
      await unmount(instance)
    })
  }

  it('preserves the private selection and name after a refusal', async () => {
    const oncreate = vi.fn(async () => '同じ名前のチャンネルがすでにあります。')
    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(CreateChannelForm, { target: host as unknown as Element, props: { oncreate } })
    await settle()
    const name = host.querySelector('input[name="channel_name"]')!
    name.value = '既存のチャンネル'
    name.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    const privateRadio = host.querySelector('input[value="private"]')!
    privateRadio.checked = true
    privateRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    buttonsByText(host, 'チャンネルを作成')[0]!.click()
    await settle()
    expect(oncreate).toHaveBeenCalledExactlyOnceWith(name.value, 'private')
    expect(name.value).toBe('既存のチャンネル')
    expect(privateRadio.checked).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('同じ名前のチャンネルがすでにあります。')
    await unmount(instance)
  })

  for (const allowed of [true, false]) {
    it(`shows the creation form and visibility choices only when can_create_channels is ${allowed}`, async () => {
      const net = fakeNetwork()
      const raw = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
      net.lists[0]!.resolve(ok({ channels: [] }))
      const navigation = createNavigation({
        location: { href: 'http://localhost/' },
        history: { state: null, pushState() {}, replaceState() {} },
        innerWidth: 1280,
        addEventListener() {},
        removeEventListener() {},
      } as unknown as NavigationBrowser)
      const host = testDoc.createElement('div')
      testDoc.body.appendChild(host)
      const instance = mount(Workspace, {
        target: host as unknown as Element,
        props: {
          navigation,
          canCreateChannels: allowed,
          session: {
            channels: channelsAdapter(raw.channels),
            sync: syncAdapter(raw.sync),
            topics: (id: string) => topicsAdapter(raw.topics, id),
            close: raw.close,
          },
        },
      })
      await settle()
      expect(host.querySelectorAll('.create-channel-form')).toHaveLength(allowed ? 1 : 0)
      expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(allowed ? 2 : 0)
      await unmount(instance)
      navigation.destroy()
      raw.close()
    })
  }
})

describe('Timeline, MessageRow and Workspace component states (docs/ui.md §3, §5)', () => {
  it('renders the deactivated sender name and hint as accessible text in the shared Message row', async () => {
    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(MessageRow, { target: host as unknown as Element, props: {
      body: '本文', senderName: senderName({ id: 'author', name: '田中', deactivated: true }),
    } })
    flushSync()
    const label = host.querySelector('.ui-message-row__sender')!
    expect(label.textContent).toBe('田中（無効）')
    expect(label.getAttribute('aria-hidden')).not.toBe('true')
    expect(label.getAttribute('aria-label')).toBeNull()
    await unmount(instance)
  })

  it('shows accessible Japanese throttled status, automatic retry and discard without manual resend or edit', async () => {
    vi.useFakeTimers()
    const net = fakeNetwork()
    const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.socket.onReady()
    net.pages.A = ok({ messages: [record(100)], has_more: false })
    net.lists[0].resolve(ok({ channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 100)
    await settle()
    const ch = syncAdapter(session.sync).channel('A')
    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Timeline, {
      target: host as unknown as Element,
      props: { channel: ch, channelId: 'A', selfId: 'me', ongoToChannelList: () => {} },
    })
    await settle()
    ch.setDraft('待機中の本文')
    void ch.submit()
    await settle()
    const original = net.sends[0].body
    ch.setDraft('次の下書き')
    net.sends[0].resolve({ ok: false, kind: 'http', status: 429, retryAfterMs: 2000 })
    await settle()
    const copy = '送信が混み合っています。しばらくしてから自動で再送します。'
    expect(host.textContent).toContain('待機中の本文')
    expect(host.textContent).toContain(copy)
    const status = host.querySelector('.ui-message-row__sending')!
    expect(status.textContent).toBe(copy)
    expect(status.getAttribute('aria-hidden')).not.toBe('true')
    expect(status.getAttribute('role')).toBeNull() // own sends add no second live region (§6)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(buttonsByText(host, '再送する')).toHaveLength(0)
    expect(buttonsByText(host, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(host, '破棄')).toHaveLength(1)
    expect(ch.composer.draft).toBe('次の下書き')
    await vi.advanceTimersByTimeAsync(1999)
    expect(net.sends).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(net.sends[1].body).toEqual(original)
    expect(host.textContent).toContain('送信中…')
    expect(host.textContent).not.toContain(copy)
    net.sends[1].resolve({ ok: false, kind: 'http', status: 429, retryAfterMs: 4000 })
    await settle()
    expect(host.textContent).toContain(copy)
    buttonsByText(host, '破棄')[0].click()
    await settle()
    expect(host.textContent).not.toContain('待機中の本文')
    expect(testDoc.activeElement).toBe(host.querySelector('textarea'))
    expect(ch.composer.draft).toBe('次の下書き')
    await vi.advanceTimersByTimeAsync(5000)
    expect(net.sends).toHaveLength(2)
    await unmount(instance)
    host.remove()
    session.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders no 再送する or 編集して送り直す when target is unavailable and keeps 破棄 working', async () => {
    // 1. Direct MessageRow check across both retryable and refused failed states under targetUnavailable
    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    let discarded = 0
    const rowInstance = mount(MessageRow, {
      target: host as unknown as Element,
      props: {
        body: 'ターゲット利用不可の本文',
        pendingStatus: 'failed',
        retryable: true,
        targetUnavailable: true,
        onretry: () => {},
        onrestore: () => {},
        ondiscard: () => {
          discarded++
        },
      },
    })
    flushSync()

    expect(host.textContent).toContain('ターゲット利用不可の本文')
    expect(buttonsByText(host, '再送する')).toHaveLength(0)
    expect(buttonsByText(host, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(host, '破棄')).toHaveLength(1)
    expect(buttonsByText(host, '破棄')[0].disabled).toBe(false)
    buttonsByText(host, '破棄')[0].click()
    flushSync()
    expect(discarded).toBe(1)
    await unmount(rowInstance)
    host.remove()

    // 2. Mounted Timeline check: transition an active Channel with both unknown and refused failed sends into C9
    const net = fakeNetwork()
    const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.socket.onReady()
    net.pages.general = ok({ messages: [record(1, 'general')], has_more: false })
    net.lists[0].resolve(ok({ channels: [channel('general', 'general')] }))
    await settle()
    net.subscribed('general', 1)
    await settle()

    const sync = syncAdapter(session.sync)
    const ch = sync.channel('general')

    const pUnknown = ch.send('通信失敗の送信')
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await pUnknown

    const pRefused = ch.send('拒否された送信')
    await settle()
    net.sends[1].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    await pRefused
    await settle()

    const timelineHost = testDoc.createElement('div')
    testDoc.body.appendChild(timelineHost)
    const timelineInstance = mount(Timeline, {
      target: timelineHost as unknown as Element,
      props: {
        channel: ch,
        channelId: 'general',
        selfId: 'me',
        ongoToChannelList: () => {},
      },
    })
    flushSync()

    // While Channel is ready, unknown shows 再送する and refused shows 編集して送り直す
    expect(buttonsByText(timelineHost, '再送する')).toHaveLength(1)
    expect(buttonsByText(timelineHost, '編集して送り直す')).toHaveLength(1)
    expect(buttonsByText(timelineHost, '破棄')).toHaveLength(2)

    // Enter C9 Channel unavailable: C9 has チャンネル一覧へ, no 再試行, disabled Composer, and failed rows keep only 破棄
    net.event({ type: 'error', channel_id: 'general', code: 'channel_not_found' })
    await settle()
    flushSync()

    expect(timelineHost.textContent).toContain('このチャンネルは利用できません。')
    expect(buttonsByText(timelineHost, 'チャンネル一覧へ')).toHaveLength(1)
    expect(buttonsByText(timelineHost, '再試行')).toHaveLength(0)
    expect(buttonsByText(timelineHost, '再送する')).toHaveLength(0)
    expect(buttonsByText(timelineHost, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(timelineHost, '破棄')).toHaveLength(2)
    expect(timelineHost.textContent).toContain('通信失敗の送信')
    expect(timelineHost.textContent).toContain('拒否された送信')

    const composerTextarea = timelineHost.querySelector('textarea')!
    expect(composerTextarea.disabled).toBe(true)

    // Clicking 破棄 removes each failed Message
    buttonsByText(timelineHost, '破棄')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(buttonsByText(timelineHost, '破棄')).toHaveLength(1)
    expect(timelineHost.textContent).not.toContain('通信失敗の送信')
    expect(timelineHost.textContent).toContain('拒否された送信')

    await unmount(timelineInstance)

    // 3. C10 organizationUnavailable on Timeline also hides 再送する / 編集して送り直す and keeps 破棄
    const orgHost = testDoc.createElement('div')
    testDoc.body.appendChild(orgHost)
    const orgInstance = mount(Timeline, {
      target: orgHost as unknown as Element,
      props: {
        channel: ch,
        channelId: 'general',
        selfId: 'me',
        organizationUnavailable: true,
        ongoToChannelList: () => {},
        onrecheckmembership: () => {},
      },
    })
    flushSync()

    expect(orgHost.textContent).toContain('この組織は利用できません。')
    expect(buttonsByText(orgHost, 'チャンネル一覧へ')).toHaveLength(0)
    expect(buttonsByText(orgHost, '再試行')).toHaveLength(0)
    expect(buttonsByText(orgHost, '再送する')).toHaveLength(0)
    expect(buttonsByText(orgHost, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(orgHost, '破棄')).toHaveLength(1)

    await unmount(orgInstance)
    session.close()
  })

  it('confirms before replacing a non-empty Composer draft on send refused (置き換える / キャンセル)', async () => {
    const net = fakeNetwork()
    const session = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.socket.onReady()
    net.pages.general = ok({ messages: [], has_more: false })
    net.lists[0].resolve(ok({ channels: [channel('general', 'general')] }))
    await settle()
    net.subscribed('general', 0)
    await settle()

    const sync = syncAdapter(session.sync)
    const ch = sync.channel('general')

    const pRefused = ch.send('拒否されたメッセージ本文')
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    await pRefused

    ch.setDraft('入力途中の大事な下書き')
    await settle()

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Timeline, {
      target: host as unknown as Element,
      props: {
        channel: ch,
        channelId: 'general',
        selfId: 'me',
      },
    })
    flushSync()

    const textarea = host.querySelector('textarea')!
    expect(textarea.value).toBe('入力途中の大事な下書き')
    expect(host.querySelector('[role="dialog"]')).toBeNull()

    // 1. Clicking 編集して送り直す with a non-empty draft opens the confirmation dialog without mutating state
    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    await tick()

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('aria-label')).toBe('入力中の下書きを置き換えますか？')
    expect(buttonsByText(dialog!, '置き換える')).toHaveLength(1)
    expect(buttonsByText(dialog!, 'キャンセル')).toHaveLength(1)
    expect(ch.composer.draft).toBe('入力途中の大事な下書き')
    expect(ch.timeline.pending).toHaveLength(1)

    // 2. Clicking キャンセル closes the dialog and preserves both the draft and the failed Message
    buttonsByText(dialog!, 'キャンセル')[0].click()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(ch.composer.draft).toBe('入力途中の大事な下書き')
    expect(textarea.value).toBe('入力途中の大事な下書き')
    expect(ch.timeline.pending).toHaveLength(1)
    expect(buttonsByText(host, '編集して送り直す')).toHaveLength(1)

    // 3. Reopen and click 置き換える: replaces the draft, removes the failed Message, and focuses Composer
    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    const reopened = host.querySelector('[role="dialog"]')!
    buttonsByText(reopened, '置き換える')[0].click()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(ch.composer.draft).toBe('拒否されたメッセージ本文')
    expect(textarea.value).toBe('拒否されたメッセージ本文')
    expect(ch.timeline.pending).toHaveLength(0)
    expect(buttonsByText(host, '編集して送り直す')).toHaveLength(0)
    expect(testDoc.activeElement).toBe(textarea)

    // 4. Empty Composer draft restores immediately without confirmation, and 破棄 focuses Composer
    ch.setDraft('')
    await settle()
    const pSecond = ch.send('二度目の拒否メッセージ')
    await settle()
    net.sends[1].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    await pSecond
    await settle()
    flushSync()

    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(textarea.value).toBe('二度目の拒否メッセージ')
    expect(testDoc.activeElement).toBe(textarea)

    ch.setDraft('')
    await settle()
    const pThird = ch.send('破棄するメッセージ')
    await settle()
    net.sends[2].resolve({ ok: false, kind: 'network' })
    await pThird
    await settle()
    flushSync()

    buttonsByText(host, '破棄')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(ch.timeline.pending).toHaveLength(0)
    expect(testDoc.activeElement).toBe(textarea)

    await unmount(instance)
    session.close()
  })

  it('moves focus to the Channel list on チャンネル一覧へ across desktop, tablet drawer and phone widths', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      close: rawSession.close,
    }
    net.socket.onReady()
    net.pages.c1 = ok({ messages: [], has_more: false })
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 0)
    await settle()

    // Put single Channel c1 into C9 unavailable state
    net.event({ type: 'error', channel_id: 'c1', code: 'channel_not_found' })
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const historyCalls: string[] = []
    let onPopState = () => {}
    const navigation = createNavigation({
      location: {
        get href() {
          return href
        },
      },
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _title: string, url: string) {
          historyCalls.push(`push:${url}`)
          historyState = state
          href = url
        },
        replaceState(state: unknown, _title: string, url: string) {
          historyCalls.push(`replace:${url}`)
          historyState = state
          href = url
        },
      },
      get innerWidth() {
        return testWin.innerWidth
      },
      addEventListener(_type: string, fn: () => void) {
        onPopState = fn
      },
      removeEventListener() {
        onPopState = () => {}
      },
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        selectedOrganizationId: 'org-1',
      },
    })
    flushSync()
    await settle()
    flushSync()

    const workspaceEl = host.querySelector('.workspace')!
    const channelNav = host.querySelector('#channel-content')!
    const channelListHeading = channelNav.querySelector('#channel-list-heading')!
    const goToListBtn = () => buttonsByText(host, 'チャンネル一覧へ')[0]
    expect(channelNav.getAttribute('aria-labelledby')).toBe('channel-list-heading')
    expect(channelNav.hasAttribute('aria-label')).toBe(false)
    expect(channelListHeading.tagName).toBe('H2')
    expect(channelListHeading.textContent.trim()).toBe('チャンネル')
    expect(channelListHeading.getAttribute('tabindex')).toBe('-1')

    // 1. Desktop (1280px): drawer stays false, URL/History stay untouched, focus moves to visible Channel list heading
    testWin.innerWidth = 1280
    goToListBtn().click()
    flushSync()
    await tick()
    expect(workspaceEl.getAttribute('data-drawer-open')).toBe('false')
    expect(href).toBe('/o/org-1/c/c1')
    expect(historyCalls).toEqual([])
    expect(channelListHeading.isRenderedVisible()).toBe(true)
    expect(testDoc.activeElement).toBe(channelListHeading)

    // 2. Tablet (768px): Channel column starts hidden; popstate `list` never focuses hidden heading, while チャンネル一覧へ opens drawer and focuses it
    testWin.innerWidth = 768
    expect(channelListHeading.isRenderedVisible()).toBe(false)
    const railChannelBtn = queryAll(host, 'button').find((b) => b.getAttribute('aria-label') === 'チャンネル一覧')!
    railChannelBtn.focus()
    expect(testDoc.activeElement).toBe(railChannelBtn)
    href = '/o/org-1'
    onPopState()
    flushSync()
    await tick()
    expect(channelListHeading.isRenderedVisible()).toBe(false)
    expect(testDoc.activeElement).toBe(railChannelBtn)
    href = '/o/org-1/c/c1'
    onPopState()
    flushSync()
    await tick()

    goToListBtn().focus()
    expect(testDoc.activeElement).toBe(goToListBtn())
    goToListBtn().click()
    flushSync()
    await tick()
    expect(workspaceEl.getAttribute('data-drawer-open')).toBe('true')
    expect(href).toBe('/o/org-1/c/c1')
    expect(historyCalls).toEqual([])
    expect(channelListHeading.isRenderedVisible()).toBe(true)
    expect(testDoc.activeElement).toBe(channelListHeading)

    // 3. Phone (375px): チャンネル一覧へ replaces URL to /o/org-1, switches mobileLevel to 'channels', and focuses the visible Channel list heading
    testWin.innerWidth = 375
    goToListBtn().focus()
    expect(testDoc.activeElement).toBe(goToListBtn())
    goToListBtn().click()
    flushSync()
    await tick()
    expect(workspaceEl.getAttribute('data-drawer-open')).toBe('false')
    expect(workspaceEl.getAttribute('data-mobile-level')).toBe('channels')
    expect(href).toBe('/o/org-1')
    expect(historyCalls).toEqual(['replace:/o/org-1'])
    expect(channelListHeading.isRenderedVisible()).toBe(true)
    expect(testDoc.activeElement).toBe(channelListHeading)

    // Reselecting the single C9 Channel on phone pushes /o/org-1/c/c1 and retries once to recover
    const subscribesBefore = net.subscribeCount('c1')
    const singleChannelBtn = queryAll(channelNav, 'button').find((b) => b.textContent.includes('general'))!
    singleChannelBtn.click()
    flushSync()
    await settle()
    expect(href).toBe('/o/org-1/c/c1')
    expect(historyCalls).toEqual(['replace:/o/org-1', 'push:/o/org-1/c/c1'])
    expect(net.subscribeCount('c1')).toBe(subscribesBefore + 1)
    net.subscribed('c1', 0)
    await settle()
    flushSync()
    expect(workspaceEl.getAttribute('data-mobile-level')).toBe('view')
    expect(buttonsByText(host, 'チャンネル一覧へ')).toHaveLength(0)

    // Phone `list` intent (チャンネル一覧へ戻る) replaces URL and focuses the visible Channel list heading
    const mobileBackBtn = queryAll(host, 'button').find((b) => b.getAttribute('aria-label') === 'チャンネル一覧へ戻る')!
    mobileBackBtn.click()
    flushSync()
    await tick()
    expect(href).toBe('/o/org-1')
    expect(historyCalls).toEqual(['replace:/o/org-1', 'push:/o/org-1/c/c1', 'replace:/o/org-1'])
    expect(workspaceEl.getAttribute('data-mobile-level')).toBe('channels')
    expect(testDoc.activeElement).toBe(channelListHeading)

    // 4. Visibility guard: if the heading is hidden, neither C9 チャンネル一覧へ nor phone `list` moves focus to it
    singleChannelBtn.click()
    flushSync()
    await settle()
    net.event({ type: 'error', channel_id: 'c1', code: 'channel_not_found' })
    await settle()
    flushSync()

    channelListHeading.hidden = true
    testWin.innerWidth = 375
    goToListBtn().focus()
    expect(testDoc.activeElement).toBe(goToListBtn())
    goToListBtn().click()
    flushSync()
    await tick()
    expect(channelListHeading.isRenderedVisible()).toBe(false)
    expect(testDoc.activeElement).not.toBe(channelListHeading)

    href = '/o/org-1/c/c1'
    onPopState()
    flushSync()
    await tick()
    testWin.innerWidth = 1280
    goToListBtn().focus()
    expect(testDoc.activeElement).toBe(goToListBtn())
    goToListBtn().click()
    flushSync()
    await tick()
    expect(channelListHeading.isRenderedVisible()).toBe(false)
    expect(testDoc.activeElement).toBe(goToListBtn())
    channelListHeading.hidden = false

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('renders Topic summary lines at latest activity, creates Topics from Composer, expands sidebar/panel Topic lists, and operates Topic view with isolated drafts and return focus', async () => {
    vi.useFakeTimers()
    let directory: Member[] = []
    let deactivated = false
    const memberController = createMembers('org-1', vi.fn(), vi.fn(), {
      listMembers: async () => ok({ members: directory }),
      lookupAuthors: async () => ok({ identities: [{ id: 'other', name: '田中', deactivated }] }),
      changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    })
    await memberController.load()
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const chMsg1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'チャンネル本文1', topic_id: null }
    const topicMsg2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '仕様の初回相談', topic_id: 't-1' }
    const chMsg3 = { ...record(3, 'c1'), id: 'm-3', sender: 'other', body: 'チャンネル本文3', topic_id: null }
    net.timelines.c1 = ok({
      as_of_seq: 3,
      has_more: false,
      items: [
        { kind: 'message', message: chMsg1 },
        {
          kind: 'topic',
          topic: {
            id: 't-1',
            name: '仕様相談',
            first_seq: 2,
            last_seq: 2,
            message_count: 1,
            latest_message: topicMsg2,
            read_seq: 0,
            unread_count: 0,
          },
        },
        { kind: 'message', message: chMsg3 },
      ],
    })
    net.topicMessages['c1:t-1'] = ok({ messages: [topicMsg2], has_more: false })
    net.topicSummaries['c1:t-1'] = ok({
      as_of_seq: 3,
      topic: {
        id: 't-1',
        name: '仕様相談',
        first_seq: 2,
        last_seq: 2,
        message_count: 1,
        latest_message: topicMsg2,
        read_seq: 0,
        unread_count: 0,
      },
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general'), channel('c2', 'empty')] }))

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const announcements: string[] = []
    const navigation = createNavigation({
      location: {
        get href() {
          return href
        },
      },
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _title: string, url: string) {
          historyState = state
          href = url
        },
        replaceState(state: unknown, _title: string, url: string) {
          historyState = state
          href = url
        },
      },
      get innerWidth() {
        return testWin.innerWidth
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
        members: membersAdapter(memberController),
        onannounce: (msg: string) => announcements.push(msg),
      },
    })
    flushSync()
    await settle()
    net.subscribed('c1', 3)
    await settle()
    flushSync()

    // 1. Main timeline shows MessageRows + TopicSummaryLine in position order [1, 2, 3]; no inline Topic MessageRow
    const mainItems = queryAll(host, '#main-content .timeline-list__item')
    expect(mainItems).toHaveLength(3)
    expect(mainItems[0].textContent).toContain('チャンネル本文1')
    expect(mainItems[1].textContent).toContain('トピック: 仕様相談')
    expect(mainItems[1].textContent).toContain('1件›')
    expect(mainItems[1].textContent).toContain('仕様の初回相談')
    expect(mainItems[2].textContent).toContain('チャンネル本文3')
    expect(queryAll(host, '#main-content .ui-message-row').map((el) => el.textContent)).toHaveLength(2)

    // Sidebar accordion expands for selected c1 showing recent Topic + すべてのトピック(1)›, while c2 has no child Topic rows
    const sidebarButtons = queryAll(host, '#channel-content .channel-list button')
    expect(sidebarButtons.map((b) => b.textContent.trim())).toEqual([
      '# general',
      '💬 仕様相談',
      'すべてのトピック(1)›',
      '# empty',
    ])

    // 2. Create a new Topic from the main Channel Composer (トピック名 + メッセージ + Enter)
    const topicInput = queryAll(host, '#main-content input').find((el) => el.getAttribute('aria-label') === 'トピック名')!
    const bodyTextarea = queryAll(host, '#main-content textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
    topicInput.value = 'リリース計画'
    topicInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    bodyTextarea.value = '初回のトピック投稿'
    bodyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    const createdTopicMsg = {
      ...record(4, 'c1'),
      id: 'm-4',
      sender: 'me',
      client_message_id: 'me-c1',
      body: '初回のトピック投稿',
      topic_id: 't-2',
    }
    net.topicSummaries['c1:t-2'] = ok({
      as_of_seq: 4,
      topic: {
        id: 't-2',
        name: 'リリース計画',
        first_seq: 4,
        last_seq: 4,
        message_count: 1,
        latest_message: createdTopicMsg,
        read_seq: 0,
        unread_count: 0,
      },
    })

    const enterEvt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    enterEvt.key = 'Enter'
    bodyTextarea.dispatchEvent(enterEvt)
    await settle()
    expect(net.sends).toHaveLength(1)
    expect(net.sends[0].body).toEqual({
      client_message_id: 'me-c1',
      body: '初回のトピック投稿',
      topic_name: 'リリース計画',
    })
    net.sends[0].resolve(ok(createdTopicMsg))
    net.event({ type: 'message', message: createdTopicMsg })
    await settle()
    await settle()
    flushSync()

    expect(topicInput.value).toBe('')
    expect(bodyTextarea.value).toBe('')
    expect(queryAll(host, '#main-content .timeline-list__item').at(-1)!.textContent).toContain('トピック: リリース計画')

    // 3. Live message in t-1 moves its summary line to the tail (after t-2) WITHOUT triggering a live status announcement
    announcements.length = 0
    const liveTopicMsg = { ...record(5, 'c1'), id: 'm-5', sender: 'other', body: '仕様の追記です', topic_id: 't-1' }
    net.event({ type: 'message', message: liveTopicMsg })
    await settle()
    flushSync()
    const afterMoveItems = queryAll(host, '#main-content .timeline-list__item')
    expect(afterMoveItems.at(-1)!.textContent).toContain('トピック: 仕様相談')
    expect(afterMoveItems.at(-1)!.textContent).toContain('2件›')
    expect(afterMoveItems.at(-1)!.textContent).toContain('仕様の追記です')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(announcements).toEqual([])

    // 4. Open すべてのトピック(2)› -> right panel TopicList shows both Topics and ＋ 新しいトピック focuses トピック名
    bodyTextarea.value = 'チャンネルに残す下書き'
    bodyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    net.topicLists.c1 = ok({
      as_of_seq: 5,
      has_more: false,
      topics: [
        {
          id: 't-2',
          name: 'リリース計画',
          first_seq: 4,
          last_seq: 4,
          message_count: 1,
          latest_message: createdTopicMsg,
          read_seq: 0,
          unread_count: 0,
        },
        {
          id: 't-1',
          name: '仕様相談',
          first_seq: 2,
          last_seq: 5,
          message_count: 2,
          latest_message: liveTopicMsg,
          read_seq: 0,
          unread_count: 0,
        },
      ],
    })

    buttonsByText(host, 'すべてのトピック(2)›')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(href).toBe('/o/org-1/c/c1?panel=topics')
    const panelTopicItems = queryAll(host, '#panel-content .topic-list-panel__item')
    expect(panelTopicItems).toHaveLength(2)
    expect(panelTopicItems[0].textContent).toContain('トピック: 仕様相談')
    expect(panelTopicItems[1].textContent).toContain('トピック: リリース計画')

    buttonsByText(host, '＋ 新しいトピック')[0].click()
    flushSync()
    await tick()
    expect(testDoc.activeElement).toBe(topicInput)

    // 5. Open Topic t-1 -> isolated Composer draft, filtered Topic messages, send in Topic, live announcement in Topic view, and return focus on チャンネルへ戻る
    const summaryBtn = host.querySelector('#main-content [data-topic-id="t-1"]')!
    summaryBtn.click()
    flushSync()
    await settle()
    flushSync()

    expect(href).toBe('/o/org-1/c/c1/t/t-1?panel=topics')
    expect(host.querySelector('#main-content h1')?.textContent.trim()).toBe('仕様相談')
    expect(announcements.at(-1)).toBe('仕様相談')

    const topicComposer = queryAll(host, '#main-content textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
    expect(topicComposer.value).toBe('')
    expect(queryAll(host, '#main-content .topic-view__item').map((el) => el.textContent)).toHaveLength(2)

    topicComposer.value = 'トピックからの返信'
    topicComposer.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    const topicForm = host.querySelector('#main-content form')!
    topicForm.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(net.sends.at(-1)?.body).toEqual({
      client_message_id: 'me-c2',
      body: 'トピックからの返信',
      topic_name: '仕様相談',
    })
    const sentInTopic = {
      ...record(6, 'c1'),
      id: 'm-6',
      sender: 'me',
      client_message_id: 'me-c2',
      body: 'トピックからの返信',
      topic_id: 't-1',
    }
    net.sends.at(-1)!.resolve(ok(sentInTopic))
    net.event({ type: 'message', message: sentInTopic })
    await settle()
    flushSync()
    expect(queryAll(host, '#main-content .topic-view__item')).toHaveLength(3)

    // Live arrival in open Topic view IS announced
    announcements.length = 0
    net.event({
      type: 'message',
      message: { ...record(7, 'c1'), id: 'm-7', sender: 'other', body: 'トピックへの新着通知', topic_id: 't-1' },
    })
    await settle()
    flushSync()
    expect(announcements).toEqual([])
    await vi.advanceTimersByTimeAsync(1_999)
    expect(announcements).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    flushSync()
    expect(announcements).toEqual(['田中: トピックへの新着通知'])

    // Active Topic in panel TopicList carries aria-current="true", inactive Topics do not
    const panelButtons = queryAll(host, '#panel-content button[data-topic-id]')
    const activePanelBtn = panelButtons.find((b) => b.getAttribute('data-topic-id') === 't-1')!
    const inactivePanelBtn = panelButtons.find((b) => b.getAttribute('data-topic-id') === 't-2')!
    expect(activePanelBtn.getAttribute('aria-current')).toBe('true')
    expect(inactivePanelBtn.getAttribute('aria-current')).toBeNull()

    // Header shows # general › and a back button whose accessible name contains its visible text (WCAG 2.5.3)
    expect(host.querySelector('#main-content .main-card__crumb')?.textContent.trim()).toBe('# general ›')
    const backToChannelBtn = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    expect(backToChannelBtn).toBeDefined()
    expect(backToChannelBtn.getAttribute('aria-label')).toBeNull()
    const accessibleBtnText = queryAll(backToChannelBtn, 'span:not([aria-hidden="true"])')
      .map((el) => el.textContent.trim())
      .join('')
    expect(accessibleBtnText).toBe('チャンネルへ戻る')
    backToChannelBtn.click()
    flushSync()
    await tick()
    flushSync()

    expect(href).toBe('/o/org-1/c/c1?panel=topics')
    const returnedSummary = host.querySelector('#main-content [data-topic-id="t-1"]')!
    expect(testDoc.activeElement).toBe(returnedSummary)
    const restoredMainComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(restoredMainComposer.value).toBe('チャンネルに残す下書き')

    // Main-timeline names absent from the directory refresh both cached states on list fetch.
    deactivated = true
    await memberController.load()
    await settle()
    flushSync()
    expect(queryAll(host, '#main-content .ui-message-row__sender').some(el => el.textContent === '田中（無効）')).toBe(true)
    directory = [{ id: 'other', name: '田中', role: 'member' }]
    deactivated = false
    await memberController.load()
    await settle()
    flushSync()
    expect(queryAll(host, '#main-content .ui-message-row__sender').some(el => el.textContent === '田中')).toBe(true)
    expect(host.textContent).not.toContain('田中（無効）')

    // 6. Unknown Topic (404 topic_not_found) shows unavailable EmptyState and disables Topic Composer while Channel stays usable
    navigation.navigate({ type: 'topic', topicId: 'missing-topic', phone: false })
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('#main-content')?.textContent).toContain('このトピックは利用できません。')
    const disabledComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(disabledComposer.disabled).toBe(true)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
    memberController.close()
  })

  it.each(['active', 'deactivated', 'omitted', 'failed', 'view changed'] as const)(
    'handles live sender lookup settlement (%s) without early or duplicate announcements', async outcome => {
      vi.useFakeTimers()
      const net = fakeNetwork()
      net.timelines.c1 = ok({ as_of_seq: 1, has_more: false, items: [
        { kind: 'message', message: { ...record(1, 'c1'), sender: 'known' } },
      ] })
      net.timelines.c2 = ok({ as_of_seq: 0, has_more: false, items: [] })
      const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: vi.fn(), ...net.options('me') })
      const sessionModel = {
        channels: channelsAdapter(rawSession.channels), sync: syncAdapter(rawSession.sync),
        topics: (id: string) => topicsAdapter(rawSession.topics, id),
        navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets), close: rawSession.close,
      }
      let finish!: (result: Awaited<ReturnType<typeof lookupAuthors>>) => void
      const lookup = vi.fn<typeof lookupAuthors>(() => new Promise(resolve => { finish = resolve }))
      const memberController = createMembers('org-1', vi.fn(), vi.fn(), {
        listMembers: async () => ok({ members: [{ id: 'known', name: '既知の著者', role: 'member' }] }),
        lookupAuthors: lookup, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
      })
      await memberController.load()
      net.socket.onReady()
      net.lists[0].resolve(ok({ channels: [channel('c1', 'general'), channel('c2', 'other')] }))
      let href = '/o/org-1/c/c1'
      const navigation = createNavigation({
        location: { get href() { return href } },
        history: { state: null,
          pushState(_s: unknown, _t: string, url: string) { href = url },
          replaceState(_s: unknown, _t: string, url: string) { href = url },
        }, innerWidth: 1280, addEventListener() {}, removeEventListener() {},
      } as unknown as NavigationBrowser)
      const announcements: string[] = []
      const host = testDoc.createElement('div')
      testDoc.body.appendChild(host)
      const instance = mount(Workspace, { target: host as unknown as Element, props: {
        navigation, session: sessionModel, selectedOrganizationId: 'org-1', members: membersAdapter(memberController),
        organization: { member: { id: 'me', name: '自分', role: 'owner' }, organization: {
          organization_id: 'org-1', name: 'Acme', capabilities: {
            can_create_channels: { allowed: true }, can_invite: { allowed: true },
            can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
          },
        } },
        onannounce: text => announcements.push(text),
      } })
      await settle()
      net.subscribed('c1', 1)
      await settle()
      announcements.length = 0
      // Known authors keep the normal 2 s window; own sends remain silent even
      // when the Member list does not include self.
      net.event({ type: 'message', message: { ...record(2, 'c1'), sender: 'known', body: '既知の新着' } })
      net.event({ type: 'message', message: { ...record(3, 'c1'), sender: 'me', body: '自分の送信' } })
      await settle()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(announcements).toEqual(['既知の著者: 既知の新着'])
      announcements.length = 0
      net.event({ type: 'message', message: { ...record(4, 'c1'), sender: 'unknown', body: '新着本文' } })
      await settle()
      expect(lookup).toHaveBeenCalledWith('org-1', { ids: ['unknown'] })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(announcements).toEqual([])
      if (outcome === 'view changed') {
        navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c2' })
        await settle()
        expect(announcements).toEqual(['# other'])
        announcements.length = 0
      }
      finish(outcome === 'failed' ? { ok: false, kind: 'network' } : ok({ identities:
        outcome === 'omitted' ? [] : [{ id: 'unknown', name: '田中', deactivated: outcome === 'deactivated' }],
      }))
      await settle()
      await vi.advanceTimersByTimeAsync(2_000)
      const name = outcome === 'active' ? '田中' : outcome === 'deactivated' ? '田中（無効）' : 'メンバー'
      const expected = outcome === 'view changed' ? [] : [name + ': 新着本文']
      expect(announcements).toEqual(expected)
      // A further cache notification and timer tick cannot announce the seq again.
      memberController.authors.watch(['unknown'])
      await settle()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(announcements).toEqual(expected)
      navigation.destroy()
      await unmount(instance)
      memberController.close()
      sessionModel.close()
    },
  )

  it('resolves isolated older Topic and Reply-chain page authors with accessible names and deactivation refresh in both views', async () => {
    const net = fakeNetwork()
    const root = { ...record(1, 'c1'), sender: 'known', body: '過去の返信ルート' }
    const reply = { ...record(2, 'c1'), sender: 'reply-only', body: '返信ページだけの本文', reply_to: root.id, reply_root_id: root.id }
    const older = { ...record(3, 'c1'), sender: 'topic-only', body: '古いトピックだけの本文', topic_id: 't-1' }
    const latest = { ...record(9, 'c1'), sender: 'known', body: '最新トピック本文', topic_id: 't-1' }
    const recent = { ...record(10, 'c1'), sender: 'known', body: '最新チャンネル本文' }
    const summary = { id: 't-1', name: '相談', first_seq: 3, last_seq: 9, message_count: 2, latest_message: latest, read_seq: 9, unread_count: 0 }
    net.timelines.c1 = ok({ as_of_seq: 10, has_more: true, items: [
      { kind: 'topic', topic: summary }, { kind: 'message', message: recent },
    ] })
    net.topicSummaries['c1:t-1'] = ok({ as_of_seq: 10, topic: summary })
    net.replyChains[`c1:${root.id}`] = ok({ root_id: root.id, messages: [root], has_more: true })
    net.replyChains[`c1:${root.id}:1`] = ok({ root_id: root.id, messages: [reply], has_more: false })
    const base = net.options('me')
    const topicReads = vi.fn(async (_channel: string, _topic: string, query?: { before_seq?: number }) =>
      query?.before_seq ? ok({ messages: [older], has_more: false }) : ok({ messages: [latest], has_more: true }))
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: vi.fn(), ...base,
      topicsApi: { ...base.topicsApi!, listTopicMessages: topicReads },
    })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels), sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets), close: rawSession.close,
    }
    let deactivated = false
    const lookup = vi.fn(async (_org: string, { ids }: { ids: string[] }) => ok({ identities: ids.map(id => ({
      id, name: id === 'topic-only' ? 'トピック著者' : '返信著者', deactivated,
    })) }))
    const memberController = createMembers('org-1', vi.fn(), vi.fn(), {
      listMembers: async () => ok({ members: [{ id: 'known', name: '既知の著者', role: 'member' }] }),
      lookupAuthors: lookup, changeRole: vi.fn(), deactivateMember: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    })
    await memberController.load()
    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    let href = '/o/org-1/c/c1/t/t-1'
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: { state: null,
        pushState(_s: unknown, _t: string, url: string) { href = url },
        replaceState(_s: unknown, _t: string, url: string) { href = url },
      }, innerWidth: 1280, addEventListener() {}, removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, { target: host as unknown as Element, props: {
      navigation, session: sessionModel, selectedOrganizationId: 'org-1', members: membersAdapter(memberController),
      organization: { member: { id: 'me', name: '自分', role: 'owner' }, organization: {
        organization_id: 'org-1', name: 'Acme', capabilities: {
          can_create_channels: { allowed: true }, can_invite: { allowed: true },
          can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
        },
      } },
    } })
    await settle()
    net.subscribed('c1', 10)
    await settle()
    expect(lookup).not.toHaveBeenCalled()
    buttonsByText(host, '以前のメッセージを読み込む')[0].click()
    await settle()
    expect(topicReads).toHaveBeenLastCalledWith('c1', 't-1', { before_seq: 9 })
    navigation.navigate({ type: 'reply', messageId: root.id })
    await settle()
    await settle()
    expect(host.querySelector('#panel-content')?.textContent).not.toContain(reply.body)
    buttonsByText(host, 'さらに返信を読み込む')[0].click()
    await settle()
    expect(net.replyHistory.at(-1)?.query?.after_seq).toBe(1)
    expect(lookup.mock.calls.flatMap(call => call[1].ids)).toEqual(['topic-only', 'reply-only'])
    expect(rawSession.sync.getTimeline('c1').get().messages.map(m => m.sender)).not.toContain('topic-only')
    expect(rawSession.sync.getTimeline('c1').get().messages.map(m => m.sender)).not.toContain('reply-only')
    expect(memberController.get().members.map(m => m.id)).toEqual(['known'])

    const expectAccessibleSender = (scope: string, id: string, text: string) => {
      const label = host.querySelector(`${scope} [data-message-id="${id}"] .ui-message-row__sender`)!
      expect(label.textContent).toBe(text)
      expect(label.closest('[aria-hidden="true"], [hidden], [inert]')).toBeNull()
      expect(label.getAttribute('aria-label')).toBeNull()
    }
    expectAccessibleSender('#main-content', older.id, 'トピック著者')
    expectAccessibleSender('#panel-content', reply.id, '返信著者')
    deactivated = true
    await memberController.load()
    await settle()
    expectAccessibleSender('#main-content', older.id, 'トピック著者（無効）')
    expectAccessibleSender('#panel-content', reply.id, '返信著者（無効）')
    expect(lookup.mock.calls.flatMap(call => call[1].ids).sort()).toEqual(['reply-only', 'reply-only', 'topic-only', 'topic-only'])
    deactivated = false
    await memberController.load()
    await settle()
    expectAccessibleSender('#main-content', older.id, 'トピック著者')
    expectAccessibleSender('#panel-content', reply.id, '返信著者')
    navigation.destroy()
    await unmount(instance)
    rawSession.close()
    memberController.close()
  })

  it('keeps TopicView, Topic draft, loaded Topic history and failed Topic send 破棄 visible across C9 and C10', async () => {
    for (const loss of ['c9', 'c10'] as const) {
      const net = fakeNetwork()
      const rawSession = createSession({
        selfId: 'me',
        organizationId: 'org-1',
        onEnded: () => {},
        ...net.options('me'),
      })
      const topicAdapters = new Map<string, TopicsAdapter>()
      const sessionModel = {
        channels: channelsAdapter(rawSession.channels),
        sync: syncAdapter(rawSession.sync),
        topics(channelId: string) {
          let a = topicAdapters.get(channelId)
          if (!a) {
            a = topicsAdapter(rawSession.topics, channelId)
            topicAdapters.set(channelId, a)
          }
          return a
        },
        navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
        close: () => rawSession.close(),
      }

      const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'トピック履歴1', topic_id: 't-1' }
      const m2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: 'チャンネル本文2', topic_id: null }
      net.timelines.c1 = ok({
        as_of_seq: 2,
        has_more: false,
        items: [
          {
            kind: 'topic',
            topic: {
              id: 't-1',
              name: '継続トピック',
              first_seq: 1,
              last_seq: 1,
              message_count: 1,
              latest_message: m1,
              read_seq: 0,
              unread_count: 0,
            },
          },
          { kind: 'message', message: m2 },
        ],
      })
      net.topicMessages['c1:t-1'] = ok({ messages: [m1], has_more: false })
      net.topicSummaries['c1:t-1'] = ok({
        as_of_seq: 2,
        topic: {
          id: 't-1',
          name: '継続トピック',
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: m1,
          read_seq: 0,
          unread_count: 0,
        },
      })

      net.socket.onReady()
      net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))

      let href = '/o/org-1/c/c1/t/t-1'
      let historyState: unknown = null
      const navigation = createNavigation({
        location: { get href() { return href } },
        history: {
          get state() { return historyState },
          pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
          replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        },
        innerWidth: 1280,
        addEventListener() {},
        removeEventListener() {},
      } as unknown as NavigationBrowser)

      const host = testDoc.createElement('div')
      testDoc.body.appendChild(host)
      const instance = mount(Workspace, {
        target: host as unknown as Element,
        props: {
          navigation,
          session: sessionModel,
          organization: {
            member: { id: 'me', name: '自分', role: 'owner' },
            organization: {
              organization_id: 'org-1',
              name: 'Acme',
              capabilities: {
                can_create_channels: { allowed: true },
                can_invite: { allowed: true },
                can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
              },
            },
          },
          selectedOrganizationId: 'org-1',
          onselectorganization: () => {},
        },
      })

      await settle()
      net.subscribed('c1', 2)
      await settle()
      flushSync()

      // Send from Topic t-1 (stays in flight) and type a new Topic draft
      const topicTextarea = queryAll(host, '#main-content textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
      topicTextarea.value = 'トピックから送信中だった本文'
      topicTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()
      host.querySelector('#main-content form')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      flushSync()

      topicTextarea.value = '消えてはいけないトピック下書き'
      topicTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      flushSync()

      if (loss === 'c9') {
        net.event({ type: 'channel_access_lost', channel_id: 'c1' })
      } else {
        await rawSession.sync.unavailable()
      }
      await settle()
      flushSync()

      expect(host.querySelector('#main-content .topic-view')).not.toBeNull()
      expect(host.querySelector('#main-content')?.textContent).toContain(
        loss === 'c9' ? 'このチャンネルは利用できません。' : 'この組織は利用できません。',
      )
      expect(host.querySelector('#main-content')?.textContent).toContain('トピック履歴1')
      expect(host.querySelector('#main-content')?.textContent).toContain('トピックから送信中だった本文')

      const afterTextarea = queryAll(host, '#main-content textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
      expect(afterTextarea.value).toBe('消えてはいけないトピック下書き')
      expect(afterTextarea.disabled).toBe(true)

      const discardBtns = buttonsByText(host, '破棄')
      expect(discardBtns).toHaveLength(1)
      discardBtns[0].click()
      flushSync()
      await settle()
      flushSync()
      expect(host.querySelector('#main-content')?.textContent).not.toContain('トピックから送信中だった本文')

      navigation.destroy()
      await unmount(instance)
      sessionModel.close()
    }
  })

  it('confirms before replacing a Topic-name-only draft and restores body with its original Topic intent', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 0)
    await settle()

    const ch = syncAdapter(rawSession.sync).channel('c1')
    const tp = topicsAdapter(rawSession.topics, 'c1')
    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Timeline, {
      target: host as unknown as Element,
      props: { channel: ch, topics: tp, channelId: 'c1', selfId: 'me' },
    })
    flushSync()

    // Submit a send to "Original topic" and have the server refuse it (400)
    const topicInput = queryAll(host, 'input').find((el) => el.getAttribute('aria-label') === 'トピック名')!
    const textarea = queryAll(host, 'textarea').find((el) => el.getAttribute('aria-label') === 'メッセージ')!
    topicInput.value = 'Original topic'
    topicInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    textarea.value = '拒否されたトピック本文'
    textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    host.querySelector('form')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'http', status: 400 })
    await settle()
    flushSync()

    // Type ONLY "Different topic" into the Topic-name field (body draft stays empty)
    topicInput.value = 'Different topic'
    topicInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    expect(textarea.value).toBe('')

    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('入力中の下書きを置き換えますか？')

    // Cancel keeps both "Different topic" and the failed "Original topic" send
    buttonsByText(host, 'キャンセル')[0].click()
    flushSync()
    expect(topicInput.value).toBe('Different topic')
    expect(ch.timeline.pending).toHaveLength(1)

    // Confirm replaces with both the refused body AND "Original topic"
    buttonsByText(host, '編集して送り直す')[0].click()
    flushSync()
    buttonsByText(host, '置き換える')[0].click()
    flushSync()
    await settle()
    flushSync()

    expect(textarea.value).toBe('拒否されたトピック本文')
    expect(topicInput.value).toBe('Original topic')
    expect(ch.timeline.pending).toHaveLength(0)

    await unmount(instance)
    rawSession.close()
  })

  it('recovers an open Topic history after a C8 cursor clamp without remounting TopicView', async () => {
    vi.useFakeTimers()
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m5 = { ...record(5, 'c1'), id: 'm-5', sender: 'other', body: 'クランプ前メッセージ', topic_id: 't-1' }
    const m10 = { ...record(10, 'c1'), id: 'm-10', sender: 'other', body: 'ブートストラップ末尾', topic_id: null }
    net.timelines.c1 = ok({
      as_of_seq: 10,
      has_more: false,
      items: [
        {
          kind: 'topic',
          topic: {
            id: 't-1',
            name: 'クランプ検証',
            first_seq: 5,
            last_seq: 5,
            message_count: 1,
            latest_message: m5,
            read_seq: 0,
            unread_count: 0,
          },
        },
        { kind: 'message', message: m10 },
      ],
    })
    net.topicMessages['c1:t-1'] = ok({ messages: [m5], has_more: false })
    net.topicSummaries['c1:t-1'] = ok({
      as_of_seq: 10,
      topic: {
        id: 't-1',
        name: 'クランプ検証',
        first_seq: 5,
        last_seq: 5,
        message_count: 1,
        latest_message: m5,
        read_seq: 0,
        unread_count: 0,
      },
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1/t/t-1'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 10)
    await settle()
    flushSync()
    const sectionBefore = host.querySelector('#main-content .topic-view')
    expect(sectionBefore).not.toBeNull()
    expect(host.querySelector('#main-content')?.textContent).toContain('クランプ前メッセージ')

    // Reconnect with C8 clamp (caught_up_seq=2 < after_seq=10)
    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'クランプ後のTopic履歴', topic_id: 't-1' }
    const m2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: 'クランプ後の末尾', topic_id: null }
    net.timelines.c1 = ok({
      as_of_seq: 2,
      has_more: false,
      items: [
        {
          kind: 'topic',
          topic: {
            id: 't-1',
            name: 'クランプ検証',
            first_seq: 1,
            last_seq: 1,
            message_count: 1,
            latest_message: m1,
            read_seq: 0,
            unread_count: 0,
          },
        },
        { kind: 'message', message: m2 },
      ],
    })
    net.topicMessages['c1:t-1'] = ok({ messages: [m1], has_more: false })

    net.socket.onClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    net.socket.onReady()
    await settle()
    net.subscribed('c1', 2)
    await settle()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('#main-content .topic-view')).toBe(sectionBefore)
    expect(host.querySelector('#main-content')?.textContent).toContain('クランプ後のTopic履歴')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('shows initial Topic-list error and retry even when the timeline already supplied Topics', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'タイムライン既知トピック', topic_id: 't-known' }
    const m2 = { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '一覧で取得される古いトピック', topic_id: 't-older' }
    net.timelines.c1 = ok({
      as_of_seq: 2,
      has_more: true,
      items: [
        {
          kind: 'topic',
          topic: {
            id: 't-known',
            name: '既知トピック',
            first_seq: 1,
            last_seq: 1,
            message_count: 1,
            latest_message: m1,
            read_seq: 0,
            unread_count: 0,
          },
        },
        { kind: 'message', message: { ...record(2, 'c1'), id: 'm-root', sender: 'other', body: 'root', topic_id: null } },
      ],
    })
    net.topicLists.c1 = { ok: false, kind: 'http', status: 503 }

    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 2)
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel.textContent).toContain('トピック: 既知トピック')
    expect(panel.textContent).toContain('トピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
    const retryBtn = queryAll(panel, 'button').find((b) => b.textContent.trim() === '再試行')
    expect(retryBtn).toBeDefined()

    net.topicLists.c1 = ok({
      as_of_seq: 2,
      has_more: false,
      topics: [
        {
          id: 't-older',
          name: '古いトピック',
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: m2,
          read_seq: 0,
          unread_count: 0,
        },
        {
          id: 't-known',
          name: '既知トピック',
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: m1,
          read_seq: 0,
          unread_count: 0,
        },
      ],
    })
    retryBtn!.click()
    flushSync()
    await settle()
    flushSync()

    expect(panel.textContent).toContain('トピック: 古いトピック')
    expect(panel.textContent).not.toContain('トピックを読み込めませんでした。')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('announces the first live Message after opening a Topic whose name was still loading', async () => {
    vi.useFakeTimers()
    let resolveNavSummary!: (res: ReturnType<typeof ok<{ as_of_seq: number; topic: { id: string; name: string; first_seq: number; last_seq: number; message_count: number; latest_message: ReturnType<typeof record>; read_seq: number; unread_count: number } }>>) => void
    const navSummaryPromise = new Promise<ReturnType<typeof ok<{ as_of_seq: number; topic: { id: string; name: string; first_seq: number; last_seq: number; message_count: number; latest_message: ReturnType<typeof record>; read_seq: number; unread_count: number } }>>>((r) => {
      resolveNavSummary = r
    })
    const net = fakeNetwork()
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      topicsApi: {
        ...baseOptions.topicsApi!,
        getTopicSummary(channelId, topicId) {
          if (topicId === 't-slow') return navSummaryPromise
          return baseOptions.topicsApi!.getTopicSummary(channelId, topicId)
        },
      },
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: '既存本文', topic_id: null }
    net.timelines.c1 = ok({ as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m1 }] })
    net.topicMessages['c1:t-slow'] = ok({ messages: [], has_more: false })

    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const announcements: string[] = []
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
        resolveSenderName: (id) => (id === 'other' ? '佐藤' : '自分'),
        onannounce: (msg) => announcements.push(msg),
      },
    })

    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()
    expect(announcements.at(-1)).toBe('# general')

    // Open Topic t-slow while its summary/name is still loading
    navigation.navigate({ type: 'topic', topicId: 't-slow', phone: false })
    flushSync()
    await settle()
    flushSync()

    // Now resolve the Topic name (without changing currentTimeline)
    const mSlow = { ...record(1, 'c1'), id: 'm-slow', sender: 'other', body: '初回', topic_id: 't-slow' }
    resolveNavSummary(
      ok({
        as_of_seq: 1,
        topic: {
          id: 't-slow',
          name: '遅延読込トピック',
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: mSlow,
          read_seq: 0,
          unread_count: 0,
        },
      }),
    )
    await settle()
    flushSync()
    expect(announcements.at(-1)).toBe('遅延読込トピック')

    // First live arrival in t-slow must be announced, NOT eaten as the initial baseline!
    announcements.length = 0
    net.event({
      type: 'message',
      message: { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '遅延後の最初の新着', topic_id: 't-slow' },
    })
    await settle()
    flushSync()
    await vi.advanceTimersByTimeAsync(2_000)
    flushSync()
    expect(announcements).toEqual(['佐藤: 遅延後の最初の新着'])

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('retries a failed Topic summary read via controller policy and updates both Timeline and TopicList', async () => {
    vi.useFakeTimers()
    let summaryCalls = 0
    const net = fakeNetwork()
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      topicsApi: {
        ...baseOptions.topicsApi!,
        async getTopicSummary(channelId, topicId) {
          if (topicId === 't-retry') {
            summaryCalls++
            if (summaryCalls === 1) return { ok: false, kind: 'http', status: 503 }
            return ok({
              as_of_seq: 2,
              topic: {
                id: 't-retry',
                name: '再取得成功トピック',
                first_seq: 2,
                last_seq: 2,
                message_count: 1,
                latest_message: { ...record(2, channelId), id: 'm-2', sender: 'other', body: '本文', topic_id: 't-retry' },
                read_seq: 0,
                unread_count: 0,
              },
            })
          }
          return baseOptions.topicsApi!.getTopicSummary(channelId, topicId)
        },
      },
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'root', topic_id: null }
    net.timelines.c1 = ok({ as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m1 }] })
    net.topicLists.c1 = ok({ as_of_seq: 1, has_more: false, topics: [] })

    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()

    // Live arrival for unknown Topic t-retry triggers summary read from both Timeline and TopicList (deduped to 1 call)
    net.event({
      type: 'message',
      message: { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '本文', topic_id: 't-retry' },
    })
    await settle()
    flushSync()
    expect(summaryCalls).toBe(1)
    expect(host.querySelector('#main-content')?.textContent).toContain('トピック: トピック')

    // After backoff elapses, controller retries and both Timeline and TopicList display the resolved Topic name
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    flushSync()
    expect(summaryCalls).toBe(2)
    expect(host.querySelector('#main-content')?.textContent).toContain('トピック: 再取得成功トピック')
    expect(host.querySelector('#panel-content')?.textContent).toContain('トピック: 再取得成功トピック')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('stops automatic summary retries at terminal error, offers 再試行 only for retryable failures, and restarts on click', async () => {
    vi.useFakeTimers()
    let retryableCalls = 0
    let nonRetryableCalls = 0
    let allowSuccess = false
    const net = fakeNetwork()
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      topicsApi: {
        ...baseOptions.topicsApi!,
        async getTopicSummary(channelId, topicId) {
          if (topicId === 't-503') {
            retryableCalls++
            if (!allowSuccess) return { ok: false, kind: 'http', status: 503 }
            return ok({
              as_of_seq: 2,
              topic: {
                id: 't-503',
                name: '手動再試行トピック',
                first_seq: 2,
                last_seq: 2,
                message_count: 1,
                latest_message: { ...record(2, channelId), id: 'm-2', sender: 'other', body: '一時障害本文', topic_id: 't-503' },
                read_seq: 0,
                unread_count: 0,
              },
            })
          }
          if (topicId === 't-429') {
            nonRetryableCalls++
            return { ok: false, kind: 'http', status: 429 }
          }
          return baseOptions.topicsApi!.getTopicSummary(channelId, topicId)
        },
      },
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'root', topic_id: null }
    net.timelines.c1 = ok({ as_of_seq: 1, has_more: false, items: [{ kind: 'message', message: m1 }] })
    net.topicLists.c1 = ok({ as_of_seq: 1, has_more: false, topics: [] })

    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()

    // 1. Live messages arrive for retryable-failing Topic t-503 and non-retryable 429 Topic t-429
    net.event({
      type: 'message',
      message: { ...record(2, 'c1'), id: 'm-2', sender: 'other', body: '一時障害本文', topic_id: 't-503' },
    })
    net.event({
      type: 'message',
      message: { ...record(3, 'c1'), id: 'm-3', sender: 'other', body: '非再試行本文', topic_id: 't-429' },
    })
    await settle()
    flushSync()

    // Non-retryable 429 stops immediately at 1 request with no retry button
    expect(nonRetryableCalls).toBe(1)

    // Advance past bounded backoff budget; persistent 503 stops at 5 requests and shows 再試行 on t-503 only
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    flushSync()
    expect(retryableCalls).toBe(5)
    expect(nonRetryableCalls).toBe(1)

    const mainRetryButtons = queryAll(host, '#main-content button').filter((b) => b.textContent?.trim() === '再試行')
    const panelRetryButtons = queryAll(host, '#panel-content button').filter((b) => b.textContent?.trim() === '再試行')
    expect(mainRetryButtons).toHaveLength(1)
    expect(panelRetryButtons).toHaveLength(1)

    // Subsequent live traffic re-renders both Timeline and TopicList without triggering any more summary calls
    net.event({
      type: 'message',
      message: { ...record(4, 'c1'), id: 'm-4', sender: 'other', body: '後続メッセージ', topic_id: null },
    })
    await settle()
    flushSync()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(retryableCalls).toBe(5)
    expect(nonRetryableCalls).toBe(1)

    // 2. Clicking 再試行 on the summary line restarts and displays the resolved Topic name and count
    allowSuccess = true
    mainRetryButtons[0]!.click()
    await settle()
    flushSync()
    expect(retryableCalls).toBe(6)
    expect(host.querySelector('#main-content')?.textContent).toContain('トピック: 手動再試行トピック')
    expect(host.querySelector('#main-content')?.textContent).toContain('1件›')
    expect(host.querySelector('#panel-content')?.textContent).toContain('トピック: 手動再試行トピック')
    expect(queryAll(host, '#main-content button').filter((b) => b.textContent?.trim() === '再試行')).toHaveLength(0)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('focuses the returning Topic summary line after a delayed timeline load, and falls back to Composer only when ready and absent or on timeline error', async () => {
    type TimelineRes =
      | ReturnType<
          typeof ok<{
            as_of_seq: number
            has_more: boolean
            items: Array<
              | { kind: 'message'; message: ReturnType<typeof record> }
              | {
                  kind: 'topic'
                  topic: {
                    id: string
                    name: string
                    first_seq: number
                    last_seq: number
                    message_count: number
                    latest_message: ReturnType<typeof record>
                    read_seq: number
                    unread_count: number
                  }
                }
            >
          }>
        >
      | { ok: false; kind: 'http'; status: number }
    let resolveC1Timeline!: (res: TimelineRes) => void
    const c1TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC1Timeline = r
    })
    let resolveC2Timeline!: (res: TimelineRes) => void
    const c2TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC2Timeline = r
    })
    let resolveC3Timeline!: (res: TimelineRes) => void
    const c3TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC3Timeline = r
    })

    const net = fakeNetwork()
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      topicsApi: {
        ...baseOptions.topicsApi!,
        listTimeline(channelId, query) {
          if (channelId === 'c1' && query?.before_position === undefined) return c1TimelinePromise
          if (channelId === 'c2' && query?.before_position === undefined) return c2TimelinePromise
          if (channelId === 'c3' && query?.before_position === undefined) return c3TimelinePromise
          return baseOptions.topicsApi!.listTimeline(channelId, query)
        },
      },
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const topicMsg1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: '遅延表示の初回本文', topic_id: 't-delayed' }
    net.topicMessages['c1:t-delayed'] = ok({ messages: [topicMsg1], has_more: false })
    net.topicSummaries['c1:t-delayed'] = ok({
      as_of_seq: 1,
      topic: {
        id: 't-delayed',
        name: '遅延表示トピック',
        first_seq: 1,
        last_seq: 1,
        message_count: 1,
        latest_message: topicMsg1,
        read_seq: 0,
        unread_count: 0,
      },
    })
    const c2TopicMsg = { ...record(1, 'c2'), id: 'm-c2-1', sender: 'other', body: '旧トピック本文', topic_id: 't-absent' }
    net.topicMessages['c2:t-absent'] = ok({ messages: [c2TopicMsg], has_more: false })
    net.topicSummaries['c2:t-absent'] = ok({
      as_of_seq: 1,
      topic: {
        id: 't-absent',
        name: '不在トピック',
        first_seq: 1,
        last_seq: 1,
        message_count: 1,
        latest_message: c2TopicMsg,
        read_seq: 0,
        unread_count: 0,
      },
    })
    const c3TopicMsg = { ...record(1, 'c3'), id: 'm-c3-1', sender: 'other', body: 'エラーチャンネル本文', topic_id: 't-err' }
    net.topicMessages['c3:t-err'] = ok({ messages: [c3TopicMsg], has_more: false })
    net.topicSummaries['c3:t-err'] = ok({
      as_of_seq: 1,
      topic: {
        id: 't-err',
        name: 'エラートピック',
        first_seq: 1,
        last_seq: 1,
        message_count: 1,
        latest_message: c3TopicMsg,
        read_seq: 0,
        unread_count: 0,
      },
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general'), channel('c2', 'other'), channel('c3', 'broken')] }))

    let href = '/o/org-1/c/c1/t/t-delayed'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    flushSync()
    expect(host.querySelector('#main-content h1')?.textContent.trim()).toBe('遅延表示トピック')

    // 1. Press チャンネルへ戻る while c1's main timeline load is still in flight
    const backBtn1 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn1.click()
    flushSync()
    await settle()
    flushSync()

    expect(href).toBe('/o/org-1/c/c1')
    expect(host.querySelector('#main-content [data-topic-id="t-delayed"]')).toBeNull()
    const c1MainComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!

    // Resolve the delayed main timeline load -> summary line renders and receives focus (not Composer)
    resolveC1Timeline(
      ok({
        as_of_seq: 1,
        has_more: false,
        items: [
          {
            kind: 'topic',
            topic: {
              id: 't-delayed',
              name: '遅延表示トピック',
              first_seq: 1,
              last_seq: 1,
              message_count: 1,
              latest_message: topicMsg1,
              read_seq: 0,
              unread_count: 0,
            },
          },
        ],
      }),
    )
    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()

    const returnedSummary = host.querySelector('#main-content [data-topic-id="t-delayed"]')!
    expect(returnedSummary).not.toBeNull()
    expect(testDoc.activeElement).not.toBe(c1MainComposer)
    expect(testDoc.activeElement).toBe(returnedSummary)

    // 2. When main timeline finishes loading and the returning Topic is definitively absent, fall back to Composer
    navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c2' })
    navigation.navigate({ type: 'topic', topicId: 't-absent', phone: false })
    flushSync()
    await settle()
    flushSync()
    expect(href).toBe('/o/org-1/c/c2/t/t-absent')

    const backBtn2 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn2.click()
    flushSync()
    await settle()
    flushSync()

    const c2Composer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(testDoc.activeElement).not.toBe(c2Composer)

    const c2RootMsg = { ...record(2, 'c2'), id: 'm-c2-2', sender: 'other', body: '最新通常投稿', topic_id: null }
    resolveC2Timeline(
      ok({
        as_of_seq: 2,
        has_more: true,
        items: [{ kind: 'message', message: c2RootMsg }],
      }),
    )
    await settle()
    net.subscribed('c2', 2)
    await settle()
    flushSync()

    expect(host.querySelector('#main-content [data-topic-id="t-absent"]')).toBeNull()
    expect(testDoc.activeElement).toBe(c2Composer)

    // 3. When main timeline fails with an error, fall back to Composer
    navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c3' })
    navigation.navigate({ type: 'topic', topicId: 't-err', phone: false })
    flushSync()
    await settle()
    flushSync()

    const backBtn3 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn3.click()
    flushSync()
    await settle()
    flushSync()

    const c3Composer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(testDoc.activeElement).not.toBe(c3Composer)

    resolveC3Timeline({ ok: false, kind: 'http', status: 503 })
    await settle()
    flushSync()
    expect(testDoc.activeElement).toBe(c3Composer)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('keeps focus on the Topic summary line when an in-flight Topic send settles after returning to the Channel', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...net.options('me'),
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const topicMsg1 = { ...record(1, 'c1'), id: 'm-1', sender: 'me', body: 'キーボード初回投稿', topic_id: 't-kbd' }
    net.timelines.c1 = ok({
      as_of_seq: 1,
      has_more: false,
      items: [
        {
          kind: 'topic',
          topic: {
            id: 't-kbd',
            name: 'キーボード議題',
            first_seq: 1,
            last_seq: 1,
            message_count: 1,
            latest_message: topicMsg1,
            read_seq: 0,
            unread_count: 0,
          },
        },
      ],
    })
    net.topicMessages['c1:t-kbd'] = ok({ messages: [topicMsg1], has_more: false })
    net.topicSummaries['c1:t-kbd'] = ok({
      as_of_seq: 1,
      topic: {
        id: 't-kbd',
        name: 'キーボード議題',
        first_seq: 1,
        last_seq: 1,
        message_count: 1,
        latest_message: topicMsg1,
        read_seq: 0,
        unread_count: 0,
      },
    })

    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()

    // Open Topic view from summary line
    host.querySelector('#main-content [data-topic-id="t-kbd"]')!.click()
    flushSync()
    await settle()
    flushSync()

    // Send inside Topic view via Enter; optimistic item renders immediately while POST /messages stays in flight
    const topicComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    topicComposer.focus()
    topicComposer.value = 'キーボードからの追記'
    topicComposer.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    const enterEvt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    enterEvt.key = 'Enter'
    topicComposer.dispatchEvent(enterEvt)
    await settle()
    flushSync()
    expect(net.sends).toHaveLength(1)
    expect(queryAll(host, '#main-content .topic-view__item')).toHaveLength(2)

    // Navigate back via チャンネルへ戻る BEFORE POST /messages resolves
    const backBtn = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn.click()
    flushSync()
    await tick()
    flushSync()

    const returnedSummary = host.querySelector('#main-content [data-topic-id="t-kbd"]')!
    const channelComposer = queryAll(host, '#main-content textarea').find(
      (el) => el.getAttribute('aria-label') === 'メッセージ',
    )!
    expect(testDoc.activeElement).toBe(returnedSummary)

    // Resolve the in-flight Topic send after Timeline has remounted -> focus must stay on returnedSummary
    const sentInTopic = {
      ...record(2, 'c1'),
      id: 'm-2',
      sender: 'me',
      client_message_id: 'me-c1',
      body: 'キーボードからの追記',
      topic_id: 't-kbd',
    }
    net.sends[0].resolve(ok(sentInTopic))
    net.event({ type: 'message', message: sentInTopic })
    await settle()
    flushSync()

    expect(returnedSummary.textContent).toContain('2件›')
    expect(testDoc.activeElement).not.toBe(channelComposer)
    expect(testDoc.activeElement).toBe(returnedSummary)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('never steals focus when the user moves focus elsewhere before a delayed Topic summary line appears', async () => {
    type TimelineRes = ReturnType<
      typeof ok<{
        as_of_seq: number
        has_more: boolean
        items: Array<{
          kind: 'topic'
          topic: {
            id: string
            name: string
            first_seq: number
            last_seq: number
            message_count: number
            latest_message: ReturnType<typeof record>
            read_seq: number
            unread_count: number
          }
        }>
      }>
    >
    let resolveC1Timeline!: (res: TimelineRes) => void
    const c1TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC1Timeline = r
    })
    let resolveC2Timeline!: (res: TimelineRes) => void
    const c2TimelinePromise = new Promise<TimelineRes>((r) => {
      resolveC2Timeline = r
    })

    const net = fakeNetwork()
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      topicsApi: {
        ...baseOptions.topicsApi!,
        listTimeline(channelId, query) {
          if (channelId === 'c1' && query?.before_position === undefined) return c1TimelinePromise
          if (channelId === 'c2' && query?.before_position === undefined) return c2TimelinePromise
          return baseOptions.topicsApi!.listTimeline(channelId, query)
        },
      },
    })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics(channelId: string) {
        let a = topicAdapters.get(channelId)
        if (!a) {
          a = topicsAdapter(rawSession.topics, channelId)
          topicAdapters.set(channelId, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: () => rawSession.close(),
    }

    const m1 = { ...record(1, 'c1'), id: 'm-1', sender: 'other', body: 'c1本文', topic_id: 't-1' }
    const m2 = { ...record(1, 'c2'), id: 'm-2', sender: 'other', body: 'c2本文', topic_id: 't-2' }
    for (const [ch, tid, msg] of [
      ['c1', 't-1', m1],
      ['c2', 't-2', m2],
    ] as const) {
      net.topicMessages[`${ch}:${tid}`] = ok({ messages: [msg], has_more: false })
      net.topicSummaries[`${ch}:${tid}`] = ok({
        as_of_seq: 1,
        topic: {
          id: tid,
          name: `トピック-${tid}`,
          first_seq: 1,
          last_seq: 1,
          message_count: 1,
          latest_message: msg,
          read_seq: 0,
          unread_count: 0,
        },
      })
    }

    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general'), channel('c2', 'other')] }))

    let href = '/o/org-1/c/c1/t/t-1'
    let historyState: unknown = null
    const navigation = createNavigation({
      location: { get href() { return href } },
      history: {
        get state() { return historyState },
        pushState(s: unknown, _t: string, url: string) { historyState = s; href = url },
        replaceState(s: unknown, _t: string, url: string) { historyState = s; href = url },
      },
      innerWidth: 1280,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as NavigationBrowser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        navigation,
        session: sessionModel,
        organization: {
          member: { id: 'me', name: '自分', role: 'owner' },
          organization: {
            organization_id: 'org-1',
            name: 'Acme',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    await settle()
    flushSync()

    // Case 1: User moves focus immediately after topic-back (before first tick and before summary line renders)
    const railChannelBtn = queryAll(host, 'button').find((b) => b.getAttribute('aria-label') === 'チャンネル一覧')!
    const backBtn1 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn1.click()
    flushSync()
    railChannelBtn.focus()
    expect(testDoc.activeElement).toBe(railChannelBtn)

    await settle()
    flushSync()
    expect(testDoc.activeElement).toBe(railChannelBtn)

    resolveC1Timeline(
      ok({
        as_of_seq: 1,
        has_more: false,
        items: [
          {
            kind: 'topic',
            topic: {
              id: 't-1',
              name: 'トピック-t-1',
              first_seq: 1,
              last_seq: 1,
              message_count: 1,
              latest_message: m1,
              read_seq: 0,
              unread_count: 0,
            },
          },
        ],
      }),
    )
    await settle()
    flushSync()
    expect(host.querySelector('#main-content [data-topic-id="t-1"]')).not.toBeNull()
    expect(testDoc.activeElement).toBe(railChannelBtn)

    // Case 2: User moves focus while main timeline is loading (after initial tick, before summary line appears)
    navigation.navigate({ type: 'channel', organizationId: 'org-1', channelId: 'c2' })
    navigation.navigate({ type: 'topic', topicId: 't-2', phone: false })
    flushSync()
    await settle()
    flushSync()

    const backBtn2 = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.textContent.includes('チャンネルへ戻る'),
    )!
    backBtn2.click()
    flushSync()
    await settle()
    flushSync()

    const panelToggleBtn = queryAll(host, '#main-content .main-card__header button').find((b) =>
      b.getAttribute('aria-label')?.startsWith('パネルを開く'),
    )!
    panelToggleBtn.focus()
    expect(testDoc.activeElement).toBe(panelToggleBtn)

    resolveC2Timeline(
      ok({
        as_of_seq: 1,
        has_more: false,
        items: [
          {
            kind: 'topic',
            topic: {
              id: 't-2',
              name: 'トピック-t-2',
              first_seq: 1,
              last_seq: 1,
              message_count: 1,
              latest_message: m2,
              read_seq: 0,
              unread_count: 0,
            },
          },
        ],
      }),
    )
    await settle()
    flushSync()
    expect(host.querySelector('#main-content [data-topic-id="t-2"]')).not.toBeNull()
    expect(testDoc.activeElement).toBe(panelToggleBtn)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('opens the Reply chain panel from main timeline and Topic view, manages focus (Reply Composer, opener return, user focus preservation, keyboard ↑/R/Esc), and supports phone level', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: 'タイムライン親メッセージ' }
    const m2 = { ...record(2, 'c1'), body: 'タイムライン2件目' }
    const tm1 = { ...record(3, 'c1'), topic_id: 't-1', body: 'トピック内メッセージ' }
    const r1 = { ...record(4, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: '既存の返信1' }
    const tr1 = { ...record(5, 'c1'), topic_id: 't-1', reply_to: tm1.id, reply_root_id: tm1.id, body: 'トピック内への返信1' }

    net.timelines.c1 = ok({
      as_of_seq: 3,
      has_more: false,
      items: [
        { kind: 'message', message: m1 },
        { kind: 'message', message: m2 },
        {
          kind: 'topic',
          topic: {
            id: 't-1',
            name: '設計相談',
            first_seq: 3,
            last_seq: 3,
            message_count: 1,
            latest_message: tm1,
            read_seq: 0,
            unread_count: 0,
          },
        },
      ],
    })
    net.topicSummaries['c1:t-1'] = ok({
      as_of_seq: 3,
      topic: {
        id: 't-1',
        name: '設計相談',
        first_seq: 3,
        last_seq: 3,
        message_count: 1,
        latest_message: tm1,
        read_seq: 0,
        unread_count: 0,
      },
    })
    net.topicMessages['c1:t-1'] = ok({ messages: [tm1], has_more: false })
    net.replyChains[`c1:${m1.id}`] = ok({
      root_id: m1.id,
      messages: [m1, r1],
      has_more: false,
    })
    net.replyChains[`c1:${m2.id}`] = ok({
      root_id: m2.id,
      messages: [m2],
      has_more: false,
    })
    net.replyChains[`c1:${tm1.id}`] = ok({
      root_id: tm1.id,
      messages: [tm1, tr1],
      has_more: false,
    })

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 3)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      get innerWidth() {
        return testWin.innerWidth
      },
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // 1. Open Reply chain panel from main timeline by clicking 返信
    const m1Row = host.querySelector(`#main-content [data-message-id="${m1.id}"]`)!
    const m1ReplyBtn = buttonsByText(m1Row, '返信')[0]
    expect(m1ReplyBtn).toBeDefined()
    m1ReplyBtn.focus()
    m1ReplyBtn.click()
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')
    expect(panel).not.toBeNull()
    expect(panel!.tagName.toLowerCase()).toBe('aside')
    expect(panel!.getAttribute('aria-label')).toBe('返信のつながり')
    expect(panel!.querySelector('h2')?.textContent).toBe('返信のつながり')
    expect(panel!.textContent).toContain('タイムライン親メッセージ')
    expect(panel!.textContent).toContain('既存の返信1')
    // Only 1 listReplyChain request (navigationTargets did not duplicate it)
    expect(net.replyHistory.filter((h) => h.anchor === m1.id)).toHaveLength(1)
    // Reply count updated on m1 row in main timeline
    expect(buttonsByText(m1Row, '返信 1件›')).toHaveLength(1)
    // Focus moved to the Reply Composer
    const replyTextarea = panel!.querySelector('textarea')!
    expect(testDoc.activeElement).toBe(replyTextarea)

    // 2. Closing via Escape returns focus to the opener button
    const escEvent = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    escEvent.key = 'Escape'
    testWin.dispatchEvent(escEvent)
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('#panel-content')).toBeNull()
    expect(testDoc.activeElement).toBe(m1ReplyBtn)

    // 3. Keyboard path: ArrowUp from empty main Composer -> latest row -> ArrowUp -> R opens Reply panel -> Escape returns to row -> Escape returns to main Composer
    const mainTextarea = host.querySelector('#main-content textarea')!
    mainTextarea.focus()
    const arrowUpComposer = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    arrowUpComposer.key = 'ArrowUp'
    mainTextarea.dispatchEvent(arrowUpComposer)
    flushSync()

    const m2Article = host.querySelector(`#main-content [data-message-id="${m2.id}"] .ui-message-row`)!
    const m1Article = host.querySelector(`#main-content [data-message-id="${m1.id}"] .ui-message-row`)!
    expect(testDoc.activeElement).toBe(m2Article)

    const arrowUpRow = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    arrowUpRow.key = 'ArrowUp'
    m2Article.dispatchEvent(arrowUpRow)
    flushSync()
    expect(testDoc.activeElement).toBe(m1Article)

    const keyR = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    keyR.key = 'r'
    m1Article.dispatchEvent(keyR)
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('#panel-content')).not.toBeNull()
    expect(testDoc.activeElement).toBe(host.querySelector('#panel-content textarea'))

    // Close panel with × button -> returns focus to m1Article (the keyboard opener)
    const closeBtn = queryAll(host, '#panel-content button').find(
      (b) => b.getAttribute('aria-label') === 'パネルを閉じる(Esc)',
    )!
    closeBtn.click()
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('#panel-content')).toBeNull()
    expect(testDoc.activeElement).toBe(m1Article)

    // Escape on focused Message row when panel is closed returns focus to main Composer
    const escToComposer = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    escToComposer.key = 'Escape'
    testWin.dispatchEvent(escToComposer)
    flushSync()
    expect(testDoc.activeElement).toBe(mainTextarea)

    // 4. User focus moves are never overridden when opening the Reply panel
    const railChannelBtn = queryAll(host, 'button').find((b) => b.getAttribute('aria-label') === 'チャンネル一覧')!
    const m2ReplyBtn = buttonsByText(
      host.querySelector(`#main-content [data-message-id="${m2.id}"]`)!,
      '返信',
    )[0]
    m2ReplyBtn.focus()
    m2ReplyBtn.click()
    flushSync()
    railChannelBtn.focus()
    await settle()
    flushSync()
    expect(testDoc.activeElement).toBe(railChannelBtn)

    // Close panel before testing Topic view; verify tabs mode keeps complementary landmark name 詳細パネル
    navigation.navigate({ type: 'tab', tab: 'overview' })
    flushSync()
    expect(host.querySelector('aside#panel-content')?.getAttribute('aria-label')).toBe('詳細パネル')
    navigation.navigate({ type: 'close' })
    flushSync()
    await settle()
    flushSync()

    // 5. Open Reply chain from a Topic view (and check phone width < 600px level switching)
    testWin.innerWidth = 375
    testWin.dispatchEvent(new MiniDomEvent('resize'))
    navigation.navigate({ type: 'topic', topicId: 't-1', phone: true })
    flushSync()
    await settle()
    flushSync()

    const tm1Row = host.querySelector(`#main-content [data-message-id="${tm1.id}"]`)!
    const tm1ReplyBtn = buttonsByText(tm1Row, '返信')[0]
    tm1ReplyBtn.focus()
    tm1ReplyBtn.click()
    flushSync()
    await settle()
    flushSync()

    const workspaceEl = host.querySelector('.workspace')!
    expect(workspaceEl.getAttribute('data-mobile-level')).toBe('panel')
    const topicReplyPanel = host.querySelector('#panel-content')!
    expect(topicReplyPanel.textContent).toContain('トピック内メッセージ')
    expect(topicReplyPanel.textContent).toContain('トピック内への返信1')
    expect(testDoc.activeElement).toBe(topicReplyPanel.querySelector('textarea'))

    // Phone back button ‹ in Panel header closes the panel and returns focus to tm1ReplyBtn in TopicView
    const mobileBackBtn = queryAll(topicReplyPanel, 'button').find(
      (b) => b.getAttribute('aria-label') === '前の表示に戻る',
    )!
    mobileBackBtn.click()
    flushSync()
    await settle()
    flushSync()
    expect(workspaceEl.getAttribute('data-mobile-level')).toBe('view')
    expect(host.querySelector('#panel-content')).toBeNull()
    expect(testDoc.activeElement).toBe(tm1ReplyBtn)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('supports Reply chain paging (さらに返信を読み込む), live reply updates, and Reply Composer send/retry/restore/discard without late async focus', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: 'ルートメッセージ' }
    const r1 = { ...record(2, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: '返信ページ1' }
    const r2 = { ...record(3, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: '返信ページ2' }

    net.timelines.c1 = ok({
      as_of_seq: 1,
      has_more: false,
      items: [{ kind: 'message', message: m1 }],
    })
    net.replyChains[`c1:${m1.id}`] = ok({
      root_id: m1.id,
      messages: [m1, r1],
      has_more: true,
    })

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 1)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // Open Reply panel for m1
    const m1Row = host.querySelector(`#main-content [data-message-id="${m1.id}"]`)!
    m1Row.querySelector('button')!.click()
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel.textContent).toContain('ルートメッセージ')
    expect(panel.textContent).toContain('返信ページ1')
    expect(buttonsByText(panel, 'さらに返信を読み込む')).toHaveLength(1)

    // 1. Paging trigger: clicking さらに返信を読み込む fetches after_seq: 2 and appends r2
    net.replyChains[`c1:${m1.id}`] = ok({
      root_id: m1.id,
      messages: [r2],
      has_more: false,
    })
    buttonsByText(panel, 'さらに返信を読み込む')[0].click()
    flushSync()
    await settle()
    flushSync()

    expect(net.replyHistory.at(-1)).toEqual({
      channel: 'c1',
      anchor: m1.id,
      query: { after_seq: 2 },
    })
    expect(panel.textContent).toContain('返信ページ2')
    expect(buttonsByText(panel, 'さらに返信を読み込む')).toHaveLength(0)

    // 2. Live update: a new reply arriving on the stream appears in the panel immediately
    const liveReply = { ...record(4, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: 'ライブ到着の返信' }
    net.event({ type: 'message', message: liveReply })
    await settle()
    flushSync()
    expect(panel.textContent).toContain('ライブ到着の返信')
    expect(buttonsByText(m1Row, '返信 3件›')).toHaveLength(1)

    // 3. Send a reply from the Reply panel Composer; focus stays in Reply Composer synchronously and never steals focus on async settle
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = 'パネルからの返信送信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    const sendBtn = buttonsByText(panel, '送信')[0]
    sendBtn.click()
    flushSync()
    expect(testDoc.activeElement).toBe(replyTextarea)
    expect(replyTextarea.value).toBe('')
    expect(panel.textContent).toContain('パネルからの返信送信')
    expect(panel.textContent).toContain('送信中…')

    // User moves focus to main Composer while send is in flight
    const mainTextarea = host.querySelector('#main-content textarea')!
    mainTextarea.focus()
    expect(testDoc.activeElement).toBe(mainTextarea)

    await settle()
    expect(net.sends[0].body).toMatchObject({
      body: 'パネルからの返信送信',
      reply_to: m1.id,
    })
    expect(net.sends[0].body.topic_name).toBeUndefined()
    const sentMsg = {
      ...record(5, 'c1'),
      sender: 'me',
      client_message_id: net.sends[0].body.client_message_id,
      body: 'パネルからの返信送信',
      reply_to: m1.id,
      reply_root_id: m1.id,
    }
    net.sends[0].resolve(ok(sentMsg))
    net.event({ type: 'message', message: sentMsg })
    await settle()
    flushSync()

    // Focus remains on mainTextarea (no late async focus steal)
    expect(testDoc.activeElement).toBe(mainTextarea)
    expect(panel.textContent).not.toContain('送信中…')
    expect(panel.textContent).toContain('パネルからの返信送信')

    // 4. Refused send in panel: 編集して送り直す with non-empty draft opens confirmation Dialog
    replyTextarea.value = '失敗する返信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    net.sends[1].resolve({ ok: false, kind: 'http', status: 400, error: 'invalid_input' })
    await settle()
    flushSync()

    expect(buttonsByText(panel, '編集して送り直す')).toHaveLength(1)
    replyTextarea.value = '編集中の一時下書き'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    buttonsByText(panel, '編集して送り直す')[0].click()
    flushSync()
    const dialog = panel.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    buttonsByText(dialog, '置き換える')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(replyTextarea.value).toBe('失敗する返信')
    expect(testDoc.activeElement).toBe(replyTextarea)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('handles Reply panel load error, 404 unavailable, and C9/C10 states (preserving chain messages, draft, and failed pending 破棄)', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: 'C9確認用ルート' }
    const r1 = { ...record(2, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: 'C9確認用返信' }

    net.timelines.c1 = ok({
      as_of_seq: 1,
      has_more: false,
      items: [{ kind: 'message', message: m1 }],
    })
    net.replyChains[`c1:${m1.id}`] = { ok: false, kind: 'network' }

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 1)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
        organizations: [
          {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          {
            organization_id: 'org-2',
            name: 'Org 2',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
        ],
        onselectorganization: () => {},
      },
    })
    await settle()
    flushSync()

    // 0. 404 reply_chain_not_found on URL hint shows unavailable EmptyState and disables Reply Composer while Channel stays usable
    navigation.navigate({ type: 'reply', messageId: 'missing-reply-id' })
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel.textContent).toContain('この返信のつながりは利用できません。')
    expect(panel.textContent).not.toContain('このチャンネルは利用できません。')
    expect(panel.querySelector('textarea')!.disabled).toBe(true)
    expect(host.querySelector('#main-content textarea')!.disabled).toBe(false)

    // 1. Network error on opening Reply chain shows StatusBanner + 再試行
    const m1Row = host.querySelector(`#main-content [data-message-id="${m1.id}"]`)!
    m1Row.querySelector('button')!.click()
    flushSync()
    await settle()
    flushSync()

    expect(panel.textContent).toContain('返信のつながりを読み込めませんでした。通信状況を確認して、もう一度お試しください。')
    expect(buttonsByText(panel, '再試行')).toHaveLength(1)

    // Retry succeeds
    net.replyChains[`c1:${m1.id}`] = ok({
      root_id: m1.id,
      messages: [m1, r1],
      has_more: false,
    })
    buttonsByText(panel, '再試行')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(panel.textContent).toContain('C9確認用ルート')
    expect(panel.textContent).toContain('C9確認用返信')

    // 2. Start an in-flight reply send and type a new Reply Composer draft, then trigger C9 channel_access_lost
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = 'C9直前の送信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()

    replyTextarea.value = 'C9でも失わない返信下書き'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    net.event({ type: 'channel_access_lost', channel_id: 'c1' })
    await settle()
    flushSync()

    // Panel shows C9 StatusBanner, retains loaded chain messages & draft, disables Composer, and shows only 破棄 on failed pending reply
    expect(panel.textContent).toContain('このチャンネルは利用できません。')
    expect(buttonsByText(panel, 'チャンネル一覧へ')).toHaveLength(1)
    expect(panel.textContent).toContain('C9確認用ルート')
    expect(panel.textContent).toContain('C9確認用返信')
    expect(panel.textContent).toContain('C9直前の送信')
    expect(replyTextarea.value).toBe('C9でも失わない返信下書き')
    expect(replyTextarea.disabled).toBe(true)
    expect(buttonsByText(panel, '再送する')).toHaveLength(0)
    expect(buttonsByText(panel, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(panel, '破棄')).toHaveLength(1)

    // Clicking 破棄 removes the failed reply
    buttonsByText(panel, '破棄')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(buttonsByText(panel, '破棄')).toHaveLength(0)
    expect(panel.textContent).not.toContain('C9直前の送信')

    // 3. Re-select c1 (Workspace automatically re-opens the active Reply chain), start an in-flight send, and trigger C10 organization_unavailable (4003 close)
    rawSession.channels.select('c1')
    await settle()
    net.subscribed('c1', 1)
    await settle()
    flushSync()
    await settle()
    flushSync()

    const c10Textarea = panel.querySelector('textarea')!
    c10Textarea.value = 'C10直前の送信'
    c10Textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()

    c10Textarea.value = 'C10でも失わない返信下書き'
    c10Textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    net.socket.onClose(4003)
    await settle()
    flushSync()

    expect(panel.textContent).toContain('この組織は利用できません。')
    expect(buttonsByText(panel, 'メンバー資格を再確認')).toHaveLength(1)
    expect(buttonsByText(panel, '組織を切り替える')).toHaveLength(1)
    expect(buttonsByText(panel, 'チャンネル一覧へ')).toHaveLength(0)
    expect(panel.textContent).toContain('C9確認用ルート')
    expect(panel.textContent).toContain('C9確認用返信')
    expect(panel.textContent).toContain('C10直前の送信')
    expect(c10Textarea.value).toBe('C10でも失わない返信下書き')
    expect(c10Textarea.disabled).toBe(true)
    expect(buttonsByText(panel, '再送する')).toHaveLength(0)
    expect(buttonsByText(panel, '編集して送り直す')).toHaveLength(0)
    expect(buttonsByText(panel, '破棄')).toHaveLength(1)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('resolves a cold descendant reply URL (?panel=reply:<descendant-id>), renders the chain, pages with さらに返信を読み込む, and sends a reply', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    // mRoot and rDescendant1/rDescendant2 are outside the loaded main timeline window (which only has mRecent at seq 10)
    const mRoot = { ...record(1, 'c1'), id: 'cold-root', body: '未ロードのルートメッセージ' }
    const rDesc1 = { ...record(2, 'c1'), id: 'cold-desc-1', reply_to: mRoot.id, reply_root_id: mRoot.id, body: '未ロードの子孫返信1' }
    const rDesc2 = { ...record(3, 'c1'), id: 'cold-desc-2', reply_to: rDesc1.id, reply_root_id: mRoot.id, body: '未ロードの子孫返信2' }
    const mRecent = { ...record(10, 'c1'), id: 'recent-10', body: '最新タイムラインメッセージ' }

    net.timelines.c1 = ok({
      as_of_seq: 10,
      has_more: true,
      items: [{ kind: 'message', message: mRecent }],
    })
    // Cold URL lookup for rDesc2 with limit: 1 returns the root message (mRoot)
    net.replyChains[`c1:${rDesc2.id}`] = ok({
      root_id: mRoot.id,
      messages: [mRoot],
      has_more: true,
    })
    // Opening the chain from mRoot returns page 1 ([mRoot, rDesc1], has_more: true), then page 2 ([rDesc2], has_more: false)
    net.replyChains[`c1:${mRoot.id}:0`] = ok({
      root_id: mRoot.id,
      messages: [mRoot, rDesc1],
      has_more: true,
    })
    net.replyChains[`c1:${mRoot.id}:2`] = ok({
      root_id: mRoot.id,
      messages: [rDesc2],
      has_more: false,
    })

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 10)
    await settle()

    let href = `/o/org-1/c/c1?panel=reply:${rDesc2.id}`
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel.textContent).toContain('未ロードのルートメッセージ')
    expect(panel.textContent).toContain('未ロードの子孫返信1')
    expect(panel.textContent).not.toContain('未ロードの子孫返信2')
    expect(buttonsByText(panel, 'さらに返信を読み込む')).toHaveLength(1)

    // Send a reply BEFORE paging in rDesc2: reply_to must be the requested descendant (rDesc2.id), not the root
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = 'ページング前の子孫URLからの返信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    expect(buttonsByText(panel, '送信')[0].disabled).toBe(false)
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    expect(net.sends).toHaveLength(1)
    const firstClientMsgId = net.sends[0].body.client_message_id
    expect(net.sends[0].body).toMatchObject({
      body: 'ページング前の子孫URLからの返信',
      reply_to: rDesc2.id,
    })

    // Network failure on the cold descendant send renders 再送する, and clicking 再送する retries before rDesc2 is paged into w.messages
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await settle()
    flushSync()
    expect(buttonsByText(panel, '再送する')).toHaveLength(1)
    buttonsByText(panel, '再送する')[0].click()
    flushSync()
    await settle()
    expect(net.sends).toHaveLength(2)
    expect(net.sends[1].body).toEqual({
      client_message_id: firstClientMsgId,
      body: 'ページング前の子孫URLからの返信',
      reply_to: rDesc2.id,
    })
    net.sends[1].resolve(
      ok({
        ...record(11, 'c1'),
        id: 'cold-desc-reply-ack',
        sender: 'me',
        client_message_id: firstClientMsgId,
        body: 'ページング前の子孫URLからの返信',
        reply_to: rDesc2.id,
        reply_root_id: mRoot.id,
      }),
    )
    await settle()
    flushSync()

    // Page in rDesc2 with さらに返信を読み込む
    buttonsByText(panel, 'さらに返信を読み込む')[0].click()
    flushSync()
    await settle()
    flushSync()
    expect(panel.textContent).toContain('未ロードの子孫返信2')
    expect(buttonsByText(panel, 'さらに返信を読み込む')).toHaveLength(0)

    // Send another reply after paging in rDesc2: reply_to remains rDesc2.id
    replyTextarea.value = '子孫URLからの返信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    expect(buttonsByText(panel, '送信')[0].disabled).toBe(false)
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    expect(net.sends).toHaveLength(3)
    expect(net.sends[2].body).toMatchObject({
      body: '子孫URLからの返信',
      reply_to: rDesc2.id,
    })

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('exposes a roving tabindex="0" MessageRow for Tab entry even when Composer has a draft, and updates roving focus on ArrowUp/ArrowDown/Home/End', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: '1件目' }
    const m2 = { ...record(2, 'c1'), body: '2件目' }
    const m3 = { ...record(3, 'c1'), body: '3件目' }

    net.timelines.c1 = ok({
      as_of_seq: 3,
      has_more: false,
      items: [
        { kind: 'message', message: m1 },
        { kind: 'message', message: m2 },
        { kind: 'message', message: m3 },
      ],
    })
    net.replyChains[`c1:${m2.id}`] = ok({
      root_id: m2.id,
      messages: [m2],
      has_more: false,
    })

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 3)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // Non-empty Composer draft: ArrowUp does not leave the Composer, but the timeline has a single roving tabindex="0" row (the latest by default)
    const mainTextarea = host.querySelector('#main-content textarea')!
    mainTextarea.value = '消したくない下書き'
    mainTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    const rows = queryAll(host, '#main-content .ui-message-row[data-focusable="true"]')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])

    // Focus the roving tabindex="0" row (as Tab/Shift+Tab does) and press ArrowUp to move roving focus to m2
    rows[2].focus()
    const upEvt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    upEvt.key = 'ArrowUp'
    rows[2].dispatchEvent(upEvt)
    flushSync()

    expect(testDoc.activeElement).toBe(rows[1])
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
    expect(mainTextarea.value).toBe('消したくない下書き')

    // Press R on m2 to open its Reply chain while keeping the main Composer draft intact
    const rEvt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    rEvt.key = 'r'
    rows[1].dispatchEvent(rEvt)
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    expect(panel).not.toBeNull()
    expect(mainTextarea.value).toBe('消したくない下書き')
    const panelRows = queryAll(panel, '.ui-message-row[data-focusable="true"]')
    expect(panelRows).toHaveLength(1)
    expect(panelRows[0].getAttribute('tabindex')).toBe('0')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('renders 返信 / 返信 n件› on confirmed rows in ReplyPanel and opens a reply row chain via button click or Enter/R (replacing the current one and focusing its Reply Composer while preserving the root row and roving tabindex)', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const mRoot = { ...record(1, 'c1'), id: 'm-root', body: 'ルート本文' }
    const r1 = { ...record(2, 'c1'), id: 'r-1', reply_to: mRoot.id, reply_root_id: mRoot.id, body: '子返信1' }
    const r2 = { ...record(3, 'c1'), id: 'r-2', reply_to: r1.id, reply_root_id: mRoot.id, body: '孫返信2' }

    net.timelines.c1 = ok({
      as_of_seq: 1,
      has_more: false,
      items: [{ kind: 'message', message: mRoot }],
    })
    const chainPayload = ok({
      root_id: mRoot.id,
      messages: [mRoot, r1, r2],
      has_more: false,
    })
    net.replyChains[`c1:${mRoot.id}`] = chainPayload
    net.replyChains[`c1:${r1.id}`] = chainPayload
    net.replyChains[`c1:${r2.id}`] = chainPayload

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 3)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const pushSpy = vi.fn()
    const replaceSpy = vi.fn()
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          pushSpy(url)
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          replaceSpy(url)
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // Open mRoot's Reply chain from main timeline (pushState)
    const mRootMainRow = host.querySelector(`#main-content [data-message-id="${mRoot.id}"]`)!
    mRootMainRow.querySelector('button')!.click()
    flushSync()
    await settle()
    flushSync()

    expect(href).toBe(`/o/org-1/c/c1?panel=reply:${mRoot.id}`)
    expect(pushSpy).toHaveBeenCalledTimes(1)
    replaceSpy.mockClear()

    const panel = host.querySelector('#panel-content')!
    const rootItem = panel.querySelector(`[data-message-id="${mRoot.id}"]`)!
    const r1Item = panel.querySelector(`[data-message-id="${r1.id}"]`)!
    const r2Item = panel.querySelector(`[data-message-id="${r2.id}"]`)!

    // Root row keeps .reply-panel__item--root, and confirmed rows show replyCount / 返信 actions
    expect(rootItem.classList.contains('reply-panel__item--root')).toBe(true)
    expect(r1Item.classList.contains('reply-panel__item--root')).toBe(false)
    expect(buttonsByText(rootItem, '返信 2件›')).toHaveLength(1)
    expect(buttonsByText(r1Item, '返信 1件›')).toHaveLength(1)
    expect(buttonsByText(r2Item, '返信')).toHaveLength(1)

    // Roving tabindex defaults to the latest row (r2)
    const panelRows = queryAll(panel, '.ui-message-row[data-focusable="true"]')
    expect(panelRows).toHaveLength(3)
    expect(panelRows.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])

    // 1. ArrowUp from empty Reply Composer focuses latest row (r2), ArrowUp moves to r1, and pressing R opens r1's chain (replaceState) and focuses Reply Composer
    const replyTextarea = panel.querySelector('textarea')!
    expect(testDoc.activeElement).toBe(replyTextarea)
    const upFromComposer = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    upFromComposer.key = 'ArrowUp'
    replyTextarea.dispatchEvent(upFromComposer)
    flushSync()
    expect(testDoc.activeElement).toBe(panelRows[2])

    const upToR1 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    upToR1.key = 'ArrowUp'
    panelRows[2].dispatchEvent(upToR1)
    flushSync()
    expect(testDoc.activeElement).toBe(panelRows[1])
    expect(panelRows.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])

    const keyR = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    keyR.key = 'r'
    panelRows[1].dispatchEvent(keyR)
    flushSync()
    await settle()
    flushSync()

    expect(href).toBe(`/o/org-1/c/c1?panel=reply:${r1.id}`)
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).toHaveBeenCalledWith(`/o/org-1/c/c1?panel=reply:${r1.id}`)
    expect(testDoc.activeElement).toBe(panel.querySelector('textarea'))
    expect(panel.querySelector(`[data-message-id="${mRoot.id}"]`)!.classList.contains('reply-panel__item--root')).toBe(true)

    // Submitting now sends reply_to: r1.id
    replyTextarea.value = 'r1への返信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    expect(net.sends.at(-1)?.body).toMatchObject({
      body: 'r1への返信',
      reply_to: r1.id,
    })

    // 2. Clicking the inline 返信 button on r2 replaces the chain with r2.id and focuses Reply Composer
    const r2ReplyBtn = buttonsByText(panel.querySelector(`[data-message-id="${r2.id}"]`)!, '返信')[0]
    r2ReplyBtn.focus()
    r2ReplyBtn.click()
    flushSync()
    await settle()
    flushSync()

    expect(href).toBe(`/o/org-1/c/c1?panel=reply:${r2.id}`)
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).toHaveBeenLastCalledWith(`/o/org-1/c/c1?panel=reply:${r2.id}`)
    expect(testDoc.activeElement).toBe(panel.querySelector('textarea'))

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('tracks Reply panel scroll state: follows own sends and pinned live arrivals, and shows 新着 n件 ↓ when unpinned', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), body: 'スクロール検証ルート' }
    const r1 = { ...record(2, 'c1'), reply_to: m1.id, reply_root_id: m1.id, body: '初期返信' }

    net.timelines.c1 = ok({
      as_of_seq: 2,
      has_more: false,
      items: [
        { kind: 'message', message: m1 },
        { kind: 'message', message: r1 },
      ],
    })
    net.replyChains[`c1:${m1.id}`] = ok({
      root_id: m1.id,
      messages: [m1, r1],
      has_more: false,
    })

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 2)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    const m1Row = host.querySelector(`#main-content [data-message-id="${m1.id}"]`)!
    m1Row.querySelector('button')!.click()
    flushSync()
    await settle()
    flushSync()

    const panel = host.querySelector('#panel-content')!
    const scrollEl = panel.querySelector('.reply-panel__scroll')!
    scrollEl.scrollHeight = 1200
    scrollEl.clientHeight = 300
    scrollEl.scrollTop = 900

    // 1. Pinned live arrival scrolls to the new scrollHeight
    scrollEl.scrollHeight = 1300
    net.event({
      type: 'message',
      message: { ...record(3, 'c1'), sender: 'other', reply_to: m1.id, reply_root_id: m1.id, body: 'ピン留め中のライブ返信' },
    })
    await settle()
    flushSync()
    expect(scrollEl.scrollTop).toBe(1300)
    expect(buttonsByText(panel, '新着 1件 ↓')).toHaveLength(0)

    // 2. Scroll up (unpinned): live arrival from another user does not move scrollTop and shows 新着 1件 ↓
    scrollEl.scrollTop = 100
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    flushSync()

    scrollEl.scrollHeight = 1400
    net.event({
      type: 'message',
      message: { ...record(4, 'c1'), sender: 'other', reply_to: m1.id, reply_root_id: m1.id, body: '未ピン中のライブ返信' },
    })
    await settle()
    flushSync()
    expect(scrollEl.scrollTop).toBe(100)
    expect(buttonsByText(panel, '新着 1件 ↓')).toHaveLength(1)

    // Clicking 新着 1件 ↓ scrolls to bottom and hides the button
    buttonsByText(panel, '新着 1件 ↓')[0].click()
    flushSync()
    expect(scrollEl.scrollTop).toBe(1400)
    expect(buttonsByText(panel, '新着 1件 ↓')).toHaveLength(0)

    // 3. Scroll up again and send own reply -> scrolls to bottom
    scrollEl.scrollTop = 50
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    flushSync()

    scrollEl.scrollHeight = 1500
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = '自分の返信送信'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(panel, '送信')[0].click()
    flushSync()
    await settle()
    expect(scrollEl.scrollTop).toBe(1500)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('preserves a Reply Composer draft typed while a Topic reply URL is still resolving', async () => {
    const net = fakeNetwork()
    const baseOptions = net.options('me')
    let resolveChainLookup!: (result: ReturnType<typeof ok<{ root_id: string; messages: ReturnType<typeof record>[]; has_more: boolean }>>) => void
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      repliesApi: {
        async listReplyChain(channelId, anchor, query) {
          if (query?.limit === 1 && resolveChainLookup) {
            return new Promise((r) => {
              resolveChainLookup = r
            })
          }
          return baseOptions.repliesApi!.listReplyChain(channelId, anchor, query)
        },
      },
    })
    resolveChainLookup = () => {}
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const topicRoot = { ...record(1, 'c1'), id: 'topic-root-1', topic_id: 't-1', body: 'トピック内ルート' }
    net.timelines.c1 = ok({
      as_of_seq: 1,
      has_more: false,
      items: [],
    })
    net.replyChains[`c1:${topicRoot.id}`] = ok({
      root_id: topicRoot.id,
      messages: [topicRoot],
      has_more: false,
    })

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 1)
    await settle()

    let href = `/o/org-1/c/c1?panel=reply:${topicRoot.id}`
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: {
        get href() {
          return href
        },
      } as Location,
      history: {
        get state() {
          return historyState
        },
        pushState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
        replaceState(state: unknown, _: string, url?: string | URL | null) {
          historyState = state
          href = String(url)
        },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // While the reply URL lookup is still delayed, user types a draft into the Reply Composer
    const panel = host.querySelector('#panel-content')!
    const replyTextarea = panel.querySelector('textarea')!
    replyTextarea.value = 'URL解決中に入力した返信下書き'
    replyTextarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    expect(replyTextarea.value).toBe('URL解決中に入力した返信下書き')

    // Now the lookup resolves with topic_id: 't-1'
    resolveChainLookup(
      ok({
        root_id: topicRoot.id,
        messages: [topicRoot],
        has_more: false,
      }),
    )
    await settle()
    await settle()
    flushSync()

    // Draft is preserved under the resolved (topicRoot.id, 't-1') target and cleared from the temporary (topicRoot.id, null) target
    expect(replyTextarea.value).toBe('URL解決中に入力した返信下書き')
    expect(sessionModel.sync.channel('c1').reply(topicRoot.id, 't-1').composer.draft).toBe('URL解決中に入力した返信下書き')
    expect(sessionModel.sync.channel('c1').reply(topicRoot.id, null).composer.draft).toBe('')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it.each([403, 404])('Topic history %s shows Channel denial and keeps the Topic draft', async status => {
    const net = fakeNetwork()
    const raw = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
    net.pages.A = ok({ messages: [{ ...record(10), topic_id: 'T' }], has_more: false })
    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('A')] }))
    await settle(); net.subscribed('A', 10); await settle()
    const ch = syncAdapter(raw.sync).channel('A')
    ch.topic('T').setDraft('失わないトピック下書き')
    net.topicMessages['A:T'] = { ok: false, kind: 'http', status, error: 'channel_not_found' }
    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(TopicView, { target: host as unknown as Element,
      props: { channel: ch, topics: topicsAdapter(raw.topics, 'A'), channelId: 'A', topicId: 'T', topicName: 'Topic T', ongoToChannelList: vi.fn() } })
    await settle()
    expect(host.textContent).toContain('このチャンネルは利用できません。')
    expect(buttonsByText(host, '再試行')).toHaveLength(0)
    expect(buttonsByText(host, 'チャンネル一覧へ')).toHaveLength(1)
    const textarea = queryAll(host, 'textarea')[0]
    expect(textarea.disabled).toBe(true)
    expect(textarea.value).toBe('失わないトピック下書き')
    expect(await ch.topic('T').submit('Topic T')).toBe(false)
    expect(net.sends).toHaveLength(0)
    await unmount(instance); raw.close()
  })

  it('renders Channel and Topic Unread badges across sidebar, accordion, Topic list panel and timeline summary lines, and hides badges when counts are null or zero', async () => {
    const net = fakeNetwork()
    // Start with failed Channel-list baseline so counts are unresolved (null)
    net.unreadListResult = { ok: false, kind: 'http', status: 500, error: 'internal_error' }
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const t1Latest = { ...record(5, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック1最新' }
    const t2Latest = { ...record(6, 'c1'), sender: 'other', topic_id: 't2', body: 'トピック2最新' }
    const t1Summary = {
      id: 't1',
      name: '進行中トピック',
      first_seq: 5,
      last_seq: 5,
      message_count: 2,
      latest_message: t1Latest,
      read_seq: 3,
      unread_count: 2,
    }
    const t2Summary = {
      id: 't2',
      name: '既読トピック',
      first_seq: 6,
      last_seq: 6,
      message_count: 1,
      latest_message: t2Latest,
      read_seq: 6,
      unread_count: 0,
    }

    net.timelines.c1 = ok({
      as_of_seq: 6,
      has_more: false,
      items: [
        { kind: 'topic', topic: t1Summary },
        { kind: 'topic', topic: t2Summary },
      ],
    })
    net.topicLists.c1 = ok({
      as_of_seq: 6,
      has_more: false,
      topics: [t1Summary, t2Summary],
    })
    net.topicSummaries['c1:t1'] = ok({ as_of_seq: 6, topic: t1Summary })
    net.topicSummaries['c1:t2'] = ok({ as_of_seq: 6, topic: t2Summary })
    net.topicSummaries['c1:t3'] = { ok: false, kind: 'http', status: 500 }

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general'), channel('c2', 'random')] }))
    await settle()
    net.subscribed('c1', 6)
    await settle()
    // Deliver a live message in t3 while its summary recovery fails -> t3 has unreadCount === null
    net.event({
      type: 'message',
      message: { ...record(7, 'c1'), topic_id: 't3', sender: 'other', body: 't3の新着メッセージ' },
    })
    await settle()

    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // While Channel-list baseline failed (null), Channel and Topic badges are hidden
    const channelNav = host.querySelector('#channel-content')!
    expect(channelNav.querySelectorAll('.ui-badge--unread')).toHaveLength(0)
    expect(host.querySelectorAll('#main-content .ui-topic-summary .ui-badge--unread')).toHaveLength(0)
    expect(host.querySelectorAll('#panel-content .ui-topic-summary .ui-badge--unread')).toHaveLength(0)

    // Now resolve the Channel-list baseline: c1 has 2 Unread (from t1), c2 has 4 Unread
    net.unreadListResult = null
    net.unreadChannels.c1 = {
      ...channel('c1', 'general'),
      as_of_seq: 6,
      read_seq: 6,
      unread_count: 2,
      main_unread_count: 0,
    }
    net.unreadChannels.c2 = {
      ...channel('c2', 'random'),
      as_of_seq: 4,
      read_seq: 0,
      unread_count: 4,
      main_unread_count: 4,
    }
    await rawSession.unread.refresh()
    await settle()
    flushSync()

    // Topic t1 has unread_count = 2 -> shown in accordion, main timeline summary line, and right panel Topic list
    // Topic t2 has unread_count = 0 -> no badge shown
    // Topic t3 has unreadCount === null (summary fetch failed) -> no badge shown
    expect(sessionModel.unread('c1').state.topics.t3?.unreadCount ?? null).toBeNull()
    const accordionBadges = channelNav.querySelectorAll('.ui-list-row-group--topic .ui-badge--unread')
    expect(accordionBadges).toHaveLength(1)
    expect(accordionBadges[0].getAttribute('aria-label')).toBe('未読 2件')

    const allSidebarBadges = channelNav.querySelectorAll('.ui-badge--unread')
    // 2 Channel row badges (c1: 未読 3件 including seq 7 > as_of_seq 6, c2: 未読 4件) + 1 accordion Topic badge (t1: 未読 2件)
    expect(allSidebarBadges.map((b) => b.getAttribute('aria-label'))).toEqual(['未読 3件', '未読 2件', '未読 4件'])

    const timelineBadges = host.querySelectorAll('#main-content .ui-topic-summary .ui-badge--unread')
    expect(timelineBadges).toHaveLength(1)
    expect(timelineBadges[0].getAttribute('aria-label')).toBe('未読 2件')

    const panelBadges = host.querySelectorAll('#panel-content .ui-topic-summary .ui-badge--unread')
    expect(panelBadges).toHaveLength(1)
    expect(panelBadges[0].getAttribute('aria-label')).toBe('未読 2件')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('opens at the first Unread Message with the 未読 read marker (loading older pages as needed), keeps the marker for the visit while scrolling marks visible confirmed rows, and never marks from hidden tabs, Topic summary lines or ReplyPanel', async () => {
    const net = fakeNetwork()
    const sessionOpts = net.options('me')
    let timelineCalls = 0
    const origListTimeline = sessionOpts.topicsApi!.listTimeline
    const m1 = { ...record(1, 'c1'), sender: 'me', body: '自分の既読メッセージ' }
    const m2 = { ...record(2, 'c1'), sender: 'other', body: '最初の未読メッセージ' }
    const m3 = { ...record(3, 'c1'), sender: 'other', body: '2番目の未読メッセージ' }
    const m4 = { ...record(4, 'c1'), sender: 'other', body: '3番目の未読メッセージ' }
    const t1Msg = { ...record(5, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック内の未読' }
    const m6 = { ...record(6, 'c1'), sender: 'other', body: '4番目の未読メッセージ' }

    const t1Summary = {
      id: 't1',
      name: '別トピック',
      first_seq: 5,
      last_seq: 5,
      message_count: 1,
      latest_message: t1Msg,
      read_seq: 0,
      unread_count: 1,
    }

    sessionOpts.topicsApi!.listTimeline = async (ch, query) => {
      timelineCalls++
      if (query?.before_position !== undefined) {
        return ok({
          as_of_seq: 6,
          has_more: false,
          items: [
            { kind: 'message', message: m1 },
            { kind: 'message', message: m2 },
            { kind: 'message', message: m3 },
          ],
        })
      }
      return origListTimeline(ch, query)
    }

    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...sessionOpts })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    // Initial timeline page has only seq 4..6 (has_more: true); older page has seq 1..3 (containing first Unread m2 at seq 2)
    net.timelines.c1 = ok({
      as_of_seq: 6,
      has_more: true,
      items: [
        { kind: 'message', message: m4 },
        { kind: 'topic', topic: t1Summary },
        { kind: 'message', message: m6 },
      ],
    })
    net.topicSummaries['c1:t1'] = ok({ as_of_seq: 6, topic: t1Summary })
    net.replyChains[`c1:${m2.id}`] = ok({ root_id: m2.id, messages: [m2], has_more: false })
    net.unreadChannels.c1 = {
      ...channel('c1', 'general'),
      as_of_seq: 6,
      read_seq: 1,
      unread_count: 5,
      main_unread_count: 4,
    }

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 6)
    await settle()

    // Also add a failed pending send in c1 to verify unconfirmed rows never mark
    const chSync = sessionModel.sync.channel('c1')
    const pSend = chSync.send('未確定の送信失敗メッセージ')
    await settle()
    net.sends[0].resolve({ ok: false, kind: 'network' })
    await pSend
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    // Configure 2-row viewport (clientHeight = 100, rowHeight = 50, total 6 items = 300px) before older page settles
    const scrollEl = host.querySelector('#main-content .timeline-scroll')!
    scrollEl.clientHeight = 100
    scrollEl.scrollHeight = 300
    scrollEl.layoutRowHeight = 50

    await settle()
    await settle()
    flushSync()

    // 1. Older page was automatically loaded so m2 (first Unread above read_seq 1) is in the window
    expect(timelineCalls).toBeGreaterThanOrEqual(2)
    const m2Item = host.querySelector(`#main-content [data-message-id="${m2.id}"]`)!
    const marker = m2Item.querySelector('[data-read-marker="true"]')
    expect(marker).not.toBeNull()
    expect(marker!.textContent.trim()).toBe('未読')

    // 2. Scroll container opened positioned at m2 (index 1 -> scrollTop = 50), NOT at the bottom (300)
    expect(scrollEl.scrollTop).toBe(50)

    // 3. Only m2 (seq 2) and m3 (seq 3) are inside the 100px viewport at scrollTop = 50 -> markRead submitted seq 3 only
    expect(net.markReads).toEqual([{ scope: { channel: 'c1', topicId: null }, body: { read_seq: 3 } }])
    expect(sessionModel.unread('c1').state.main.unreadCount).toBe(2) // m4 and m6 remain Unread
    expect(sessionModel.unread('c1').state.topics.t1?.unreadCount).toBe(1) // Topic t1 remains Unread

    // 4. Opening ReplyPanel on m2 never marks additional main or Topic Messages as read
    m2Item.querySelector('button')!.click()
    flushSync()
    await settle()
    flushSync()
    expect(host.querySelector('#panel-content')).not.toBeNull()
    expect(net.markReads).toEqual([{ scope: { channel: 'c1', topicId: null }, body: { read_seq: 3 } }])

    // 5. While document is hidden, scrolling through m4 and m6 emits no presented intent and sends no markRead
    testDoc.visibilityState = 'hidden'
    testDoc.dispatchEvent(new MiniDomEvent('visibilitychange'))
    flushSync()

    scrollEl.scrollTop = 150
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    scrollEl.scrollTop = 200
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    flushSync()
    await settle()
    expect(net.markReads).toEqual([{ scope: { channel: 'c1', topicId: null }, body: { read_seq: 3 } }])
    expect(sessionModel.unread('c1').state.main.unreadCount).toBe(2)

    // 6. Returning to visible document and scrolling through m4 (index 3) and m6 (index 5) emits presented for confirmed rows, ignoring Topic summary line t1 and failed pending send
    scrollEl.scrollTop = 150
    testDoc.visibilityState = 'visible'
    testDoc.dispatchEvent(new MiniDomEvent('visibilitychange'))
    flushSync()
    await settle()
    scrollEl.scrollTop = 200
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    flushSync()
    await settle()
    flushSync()

    expect(net.markReads).toEqual([
      { scope: { channel: 'c1', topicId: null }, body: { read_seq: 3 } },
      { scope: { channel: 'c1', topicId: null }, body: { read_seq: 4 } },
      { scope: { channel: 'c1', topicId: null }, body: { read_seq: 6 } },
    ])
    expect(sessionModel.unread('c1').state.main.unreadCount).toBe(0)
    // Topic summary line in main timeline never marked Topic t1 as read
    expect(sessionModel.unread('c1').state.topics.t1?.unreadCount).toBe(1)
    expect(sessionModel.unread('c1').state.unreadCount).toBe(1)

    // 7. Read marker stays at m2 for the entire visit even after main unreadCount reaches 0
    expect(m2Item.querySelector('[data-read-marker="true"]')?.textContent.trim()).toBe('未読')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('calls enter and leave on navigating between main timeline and Topic views, marks only the active Topic, and opens without a marker on a revisit after reading', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const t1m1 = { ...record(1, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック1の未読1' }
    const t1m2 = { ...record(2, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック1の未読2' }
    const t2m1 = { ...record(3, 'c1'), sender: 'other', topic_id: 't2', body: 'トピック2の未読1' }

    const t1Summary = {
      id: 't1',
      name: 'トピックA',
      first_seq: 1,
      last_seq: 2,
      message_count: 2,
      latest_message: t1m2,
      read_seq: 0,
      unread_count: 2,
    }
    const t2Summary = {
      id: 't2',
      name: 'トピックB',
      first_seq: 3,
      last_seq: 3,
      message_count: 1,
      latest_message: t2m1,
      read_seq: 0,
      unread_count: 1,
    }

    net.timelines.c1 = ok({
      as_of_seq: 3,
      has_more: false,
      items: [
        { kind: 'topic', topic: t1Summary },
        { kind: 'topic', topic: t2Summary },
      ],
    })
    net.topicSummaries['c1:t1'] = ok({ as_of_seq: 3, topic: t1Summary })
    net.topicSummaries['c1:t2'] = ok({ as_of_seq: 3, topic: t2Summary })
    net.topicMessages['c1:t1'] = ok({ messages: [t1m1, t1m2], has_more: false })
    net.topicMessages['c1:t2'] = ok({ messages: [t2m1], has_more: false })
    net.unreadChannels.c1 = {
      ...channel('c1', 'general'),
      as_of_seq: 3,
      read_seq: 3,
      unread_count: 3,
      main_unread_count: 0,
    }

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 3)
    await settle()

    const enterSpy = vi.spyOn(rawSession.unread, 'enter')
    const leaveSpy = vi.spyOn(rawSession.unread, 'leave')

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    // 1. Entered main timeline (topicId: null) with 0 main Unread -> no read marker
    expect(enterSpy).toHaveBeenCalledWith({ channel: 'c1', topicId: null })
    expect(host.querySelector('[data-read-marker="true"]')).toBeNull()
    expect(net.markReads).toHaveLength(0)
    sessionModel.sync.channel('c1').setDraft('main draft')
    flushSync()
    expect(leaveSpy).toHaveBeenCalledTimes(0)

    // 2. Click Topic t1 summary line -> leaves main timeline and enters Topic t1
    const t1LineBtn = host.querySelector('#main-content button.ui-topic-summary[data-topic-id="t1"]')!
    t1LineBtn.click()
    flushSync()
    await settle()
    await settle()
    flushSync()

    expect(leaveSpy).toHaveBeenCalledTimes(1)
    expect(enterSpy).toHaveBeenLastCalledWith({ channel: 'c1', topicId: 't1' })

    // Topic t1 shows read marker on t1m1, marks only t1 read, and leaves t2 Unread
    const t1m1Item = host.querySelector(`#main-content [data-message-id="${t1m1.id}"]`)!
    expect(t1m1Item.querySelector('[data-read-marker="true"]')?.textContent.trim()).toBe('未読')
    expect(net.markReads).toEqual([{ scope: { channel: 'c1', topicId: 't1' }, body: { read_seq: 2 } }])
    expect(sessionModel.unread('c1').state.topics.t1?.unreadCount).toBe(0)
    expect(sessionModel.unread('c1').state.topics.t2?.unreadCount).toBe(1)
    expect(sessionModel.unread('c1').state.unreadCount).toBe(1)

    // Marker remains visible for the rest of the visit to t1 even across timeline state updates
    sessionModel.sync.channel('c1').setDraft('updated draft')
    flushSync()
    await settle()
    flushSync()
    expect(leaveSpy).toHaveBeenCalledTimes(1)
    expect(t1m1Item.querySelector('[data-read-marker="true"]')).not.toBeNull()

    // 3. Return to main timeline and re-enter Topic t1 -> now t1 has 0 Unread so it opens pinned at bottom with no marker
    host
      .querySelectorAll('#main-content .main-card__header button')
      .find((b) => b.textContent.includes('チャンネルへ戻る'))!
      .click()
    flushSync()
    await settle()
    flushSync()
    expect(leaveSpy).toHaveBeenCalledTimes(2)
    expect(enterSpy).toHaveBeenLastCalledWith({ channel: 'c1', topicId: null })

    host.querySelector('#main-content button.ui-topic-summary[data-topic-id="t1"]')!.click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenLastCalledWith({ channel: 'c1', topicId: 't1' })
    expect(host.querySelector('[data-read-marker="true"]')).toBeNull()

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('stops automatic Unread re-entry on Channel or Topic 404 while sync remains ready, recovers on C8 clamp, and restarts on explicit user selection', async () => {
    const net = fakeNetwork()
    let markReadResponses: Array<Result<ReadPosition>> = [
      { ok: false, kind: 'http', status: 404, error: 'channel_not_found' },
      { ok: false, kind: 'http', status: 404, error: 'channel_not_found' },
    ]
    const baseOptions = net.options('me')
    const rawSession = createSession({
      selfId: 'me',
      organizationId: 'org-1',
      onEnded: () => {},
      ...baseOptions,
      sync: {
        ...baseOptions.sync,
        schedule: (fn) => {
          fn()
          return 0
        },
      },
      unreadApi: {
        ...baseOptions.unreadApi!,
        markRead: async (scope, body) => {
          net.markReads.push({ scope, body })
          const next = markReadResponses.shift()
          if (next) return next
          return ok({ read_seq: body.read_seq })
        },
      },
    })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const m1 = { ...record(1, 'c1'), sender: 'other', body: '未読メッセージ1' }
    const t1m1 = { ...record(2, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック未読1' }
    const t1Summary = {
      id: 't1',
      name: 'トピックA',
      first_seq: 2,
      last_seq: 2,
      message_count: 1,
      latest_message: t1m1,
      read_seq: 0,
      unread_count: 1,
    }

    net.pages.c1 = ok({ messages: [m1, t1m1], has_more: false })
    net.timelines.c1 = ok({
      as_of_seq: 2,
      has_more: false,
      items: [
        { kind: 'message', message: m1 },
        { kind: 'topic', topic: t1Summary },
      ],
    })
    net.topicSummaries['c1:t1'] = ok({ as_of_seq: 2, topic: t1Summary })
    net.topicMessages['c1:t1'] = ok({ messages: [t1m1], has_more: false })
    net.unreadChannels.c1 = {
      ...channel('c1', 'general'),
      as_of_seq: 2,
      read_seq: 0,
      unread_count: 2,
      main_unread_count: 1,
    }

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 2)
    await settle()

    const enterSpy = vi.spyOn(rawSession.unread, 'enter')

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    const scrollEl = host.querySelector('#main-content .timeline-scroll')!
    scrollEl.clientHeight = 100
    scrollEl.scrollHeight = 100
    scrollEl.layoutRowHeight = 50

    await settle()
    await settle()
    flushSync()
    await settle()
    flushSync()

    // 1. Two 404s queued, but the 1st 404 stops automatic Unread work while sync stays ready (only 1 enter & 1 markRead, never 3)
    expect(sessionModel.sync.channel('c1').timeline.status).toBe('ready')
    expect(enterSpy).toHaveBeenCalledTimes(1)
    expect(net.markReads).toHaveLength(1)
    expect(sessionModel.unread('c1').state.stopped).toBe(true)

    const selectChannelBtn = () =>
      host.querySelectorAll('#channel-content button').find((b) => b.textContent.includes('general'))!
    const selectTopicBtn = () =>
      host.querySelectorAll('#channel-content button').find((b) => b.textContent.includes('トピックA'))!

    // 2. Explicit user selection of Channel c1 restarts Unread work once, consumes the 2nd 404, and stops again without looping
    selectChannelBtn().click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenCalledTimes(2)
    expect(net.markReads).toHaveLength(2)
    expect(sessionModel.unread('c1').state.stopped).toBe(true)

    // 3. Explicit user selection when server allows markRead recovers and marks read
    selectChannelBtn().click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenCalledTimes(3)
    expect(net.markReads).toHaveLength(3)
    expect(sessionModel.unread('c1').state.stopped).toBe(false)
    expect(sessionModel.unread('c1').state.main.unreadCount).toBe(0)

    // 4. C8 clamp (reconnect with caught_up_seq < cursor -> resetHistory) automatically creates a new visit for the new generation
    const visitBeforeC8 = sessionModel.unread('c1').state.entry?.id
    net.socket.onClose(1006)
    await settle()
    net.socket.onReady()
    await settle()
    net.subscribed('c1', 0)
    await settle()
    await settle()
    flushSync()
    expect(sessionModel.unread('c1').state.entry?.id).toBeDefined()
    expect(sessionModel.unread('c1').state.entry?.id).not.toBe(visitBeforeC8)
    expect(net.markReads).toHaveLength(4)

    // 5. Open Topic t1 where markRead returns a Topic 404 (topic_not_found) and then a Channel 404: stops until explicit selection
    markReadResponses = [
      { ok: false, kind: 'http', status: 404, error: 'topic_not_found' },
      { ok: false, kind: 'http', status: 404, error: 'channel_not_found' },
    ]
    host.querySelector('#main-content button.ui-topic-summary[data-topic-id="t1"]')!.click()
    flushSync()
    const topicScrollEl = host.querySelector('#main-content .topic-view__scroll')!
    topicScrollEl.clientHeight = 100
    topicScrollEl.scrollHeight = 100
    topicScrollEl.layoutRowHeight = 50
    await settle()
    await settle()
    flushSync()
    await settle()
    flushSync()

    expect(enterSpy).toHaveBeenCalledTimes(4)
    expect(net.markReads).toHaveLength(5)
    expect(sessionModel.unread('c1').state.topics.t1?.stopped).toBe(true)

    // Explicit user selection of Topic t1 in sidebar restarts once, hits Channel 404, and stops without looping
    selectTopicBtn().click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenCalledTimes(5)
    expect(net.markReads).toHaveLength(6)
    expect(sessionModel.unread('c1').state.stopped).toBe(true)

    // Explicit user selection of Topic t1 again when server allows markRead succeeds
    selectTopicBtn().click()
    flushSync()
    await settle()
    await settle()
    flushSync()
    expect(enterSpy).toHaveBeenCalledTimes(6)
    expect(net.markReads).toHaveLength(7)
    expect(sessionModel.unread('c1').state.stopped).toBe(false)
    expect(sessionModel.unread('c1').state.topics.t1?.unreadCount).toBe(0)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('defers first-Unread positioning on phone while a panel (?panel=topics) hides main, and scrolls to first Unread when the panel closes', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    // 6 messages (m1..m6), read_seq = 4 so first Unread is at row index 4 (5th row, top = 200px at rowHeight = 50)
    const msgs = [1, 2, 3, 4, 5, 6].map((seq) => ({
      ...record(seq, 'c1'),
      sender: 'other',
      body: `メッセージ${seq}`,
    }))
    net.pages.c1 = ok({ messages: msgs, has_more: false })
    net.timelines.c1 = ok({
      as_of_seq: 6,
      has_more: false,
      items: msgs.map((message) => ({ kind: 'message' as const, message })),
    })
    net.unreadChannels.c1 = {
      ...channel('c1', 'general'),
      as_of_seq: 6,
      read_seq: 4,
      unread_count: 2,
      main_unread_count: 2,
    }

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 6)
    await settle()

    testWin.innerWidth = 375
    let href = '/o/org-1/c/c1?panel=topics'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 375,
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    const scrollEl = host.querySelector('#main-content .timeline-scroll')!
    scrollEl.clientHeight = 100
    scrollEl.scrollHeight = 300
    scrollEl.layoutRowHeight = 50

    await settle()
    await settle()
    flushSync()

    // While ?panel=topics is open on phone, main is display: none (data-mobile-level="panel"): positioning and markRead are deferred
    expect(host.querySelector('.workspace')?.getAttribute('data-mobile-level')).toBe('panel')
    expect(scrollEl.isRenderedVisible()).toBe(false)
    expect(scrollEl.scrollTop).toBe(0)
    expect(net.markReads).toEqual([])

    // Closing the panel displays main (data-mobile-level="view") and positions scrollTop at row index 4 (200px)
    host.querySelector('#panel-content button[aria-label="パネルを閉じる(Esc)"]')!.click()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('.workspace')?.getAttribute('data-mobile-level')).toBe('view')
    expect(scrollEl.isRenderedVisible()).toBe(true)
    expect(scrollEl.scrollTop).toBe(200)
    expect(net.markReads).toEqual([{ scope: { channel: 'c1', topicId: null }, body: { read_seq: 6 } }])

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('resets initial scroll state on a new visit after same-Channel C9 recovery with zero Unread', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    const msgs = [1, 2, 3, 4, 5, 6].map((seq) => ({
      ...record(seq, 'c1'),
      sender: 'other',
      body: `メッセージ${seq}`,
    }))
    net.pages.c1 = ok({ messages: msgs, has_more: false })
    net.timelines.c1 = ok({
      as_of_seq: 6,
      has_more: false,
      items: msgs.map((message) => ({ kind: 'message' as const, message })),
    })
    net.unreadChannels.c1 = {
      ...channel('c1', 'general'),
      as_of_seq: 6,
      read_seq: 6,
      unread_count: 0,
      main_unread_count: 0,
    }

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 6)
    await settle()

    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    const scrollEl = host.querySelector('#main-content .timeline-scroll')!
    scrollEl.clientHeight = 100
    scrollEl.scrollHeight = 300
    scrollEl.layoutRowHeight = 50

    await settle()
    await settle()
    flushSync()

    // 1. Initial visit with 0 Unread pins to bottom (scrollTop = 300)
    const firstVisitId = sessionModel.unread('c1').state.entry?.id
    expect(firstVisitId).toBeDefined()
    expect(scrollEl.scrollTop).toBe(300)

    // 2. User scrolls upward to top (unpinned at scrollTop = 0)
    scrollEl.scrollTop = 0
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    flushSync()
    expect(scrollEl.scrollTop).toBe(0)

    // 3. Lose Channel access via C9
    net.socket.onEvent({ type: 'channel_access_lost', channel_id: 'c1' })
    await settle()
    flushSync()
    expect(sessionModel.sync.channel('c1').timeline.status).toBe('unavailable')

    // 4. Access returns with boundary 20 and 0 Unread (unchanged rows); user explicitly reselects Channel c1
    net.unreadChannels.c1 = {
      ...channel('c1', 'general'),
      as_of_seq: 20,
      read_seq: 20,
      unread_count: 0,
      main_unread_count: 0,
    }
    host
      .querySelectorAll('#channel-content button')
      .find((b) => b.textContent.includes('general'))!
      .click()
    flushSync()
    await settle()
    net.subscribed('c1', 20)
    await settle()
    await settle()
    flushSync()

    // New visit (new entry id, boundary 20, 0 Unread) resets scroll state and pins to bottom (300) instead of staying at 0
    const secondVisitId = sessionModel.unread('c1').state.entry?.id
    expect(secondVisitId).toBeDefined()
    expect(secondVisitId).not.toBe(firstVisitId)
    expect(sessionModel.unread('c1').state.entry?.boundary).toBe(20)
    expect(scrollEl.scrollTop).toBe(300)

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('keeps following the bottom instead of jumping back to first Unread when a live Message arrives while hidden behind a phone panel', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: syncAdapter(rawSession.sync),
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) unreadAdapters.set(id, (a = unreadAdapter(rawSession.unread, id)))
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()

    // 6 main messages (seq 1..6, read_seq = 2 -> first Unread m3 at row index 2, top = 100px)
    const mainMsgs = [1, 2, 3, 4, 5, 6].map((seq) => ({
      ...record(seq, 'c1'),
      sender: 'other',
      body: `メインメッセージ${seq}`,
    }))
    // 6 Topic t1 messages (seq 7..12, read_seq = 8 -> first Unread t1m3 at row index 2, top = 100px)
    const topicMsgs = [7, 8, 9, 10, 11, 12].map((seq) => ({
      ...record(seq, 'c1'),
      sender: 'other',
      topic_id: 't1',
      body: `トピックメッセージ${seq}`,
    }))
    const t1Summary = {
      id: 't1',
      name: 'トピックA',
      first_seq: 7,
      last_seq: 12,
      message_count: 6,
      latest_message: topicMsgs[5],
      read_seq: 8,
      unread_count: 4,
    }

    net.pages.c1 = ok({ messages: [...mainMsgs, ...topicMsgs], has_more: false })
    net.timelines.c1 = ok({
      as_of_seq: 12,
      has_more: false,
      items: [
        ...mainMsgs.map((message) => ({ kind: 'message' as const, message })),
        { kind: 'topic' as const, topic: t1Summary },
      ],
    })
    net.topicLists.c1 = ok({ as_of_seq: 12, has_more: false, topics: [t1Summary] })
    net.topicSummaries['c1:t1'] = ok({ as_of_seq: 12, topic: t1Summary })
    net.topicMessages['c1:t1'] = ok({ messages: topicMsgs, has_more: false })
    net.unreadChannels.c1 = {
      ...channel('c1', 'general'),
      as_of_seq: 12,
      read_seq: 2,
      unread_count: 8,
      main_unread_count: 4,
    }

    net.lists[0].resolve(ok({ channels: [channel('c1', 'general')] }))
    await settle()
    net.subscribed('c1', 12)
    await settle()

    testWin.innerWidth = 375
    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 375,
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)

    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })

    const scrollEl = host.querySelector('#main-content .timeline-scroll')!
    scrollEl.clientHeight = 100
    scrollEl.scrollHeight = 300
    scrollEl.layoutRowHeight = 50

    await settle()
    await settle()
    flushSync()

    // 1. Main Timeline enters with Unread -> positions at first Unread (m3 at row index 2 = 100px)
    expect(host.querySelector('.workspace')?.getAttribute('data-mobile-level')).toBe('view')
    expect(scrollEl.scrollTop).toBe(100)
    expect(host.querySelector(`#main-content [data-message-id="${mainMsgs[2].id}"] [data-read-marker="true"]`)).not.toBeNull()

    // 2. User scrolls to the bottom (pinned), presenting m5 and m6 along the way
    scrollEl.scrollTop = 200
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    scrollEl.scrollTop = 250
    scrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    flushSync()
    await settle()

    // 3. User opens phone panel -> main view is hidden (data-mobile-level="panel")
    host.querySelector('#main-content button[aria-label="パネルを開く(⌘.)"]')!.click()
    flushSync()
    await settle()
    expect(host.querySelector('.workspace')?.getAttribute('data-mobile-level')).toBe('panel')
    expect(scrollEl.isRenderedVisible()).toBe(false)

    // 4. Live Message arrives on main Timeline while hidden
    const m7 = { ...record(13, 'c1'), sender: 'other', body: 'メイン新着7' }
    net.unreadChannels.c1.as_of_seq = 13
    net.topicLists.c1 = ok({ as_of_seq: 13, has_more: false, topics: [t1Summary] })
    net.topicSummaries['c1:t1'] = ok({ as_of_seq: 13, topic: t1Summary })
    scrollEl.scrollHeight = 350
    net.event({ type: 'message', message: m7 })
    await settle()
    flushSync()

    // 5. User closes phone panel -> stays following the bottom (350px), not jumping back to first Unread (100px)
    host.querySelector('#panel-content button[aria-label="パネルを閉じる(Esc)"]')!.click()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('.workspace')?.getAttribute('data-mobile-level')).toBe('view')
    expect(scrollEl.isRenderedVisible()).toBe(true)
    expect(scrollEl.scrollTop).toBe(350)
    expect(host.querySelector(`#main-content [data-message-id="${mainMsgs[2].id}"] [data-read-marker="true"]`)).not.toBeNull()
    expect(net.markReads.at(-1)).toEqual({ scope: { channel: 'c1', topicId: null }, body: { read_seq: 13 } })

    // 6. Same scenario in TopicView: open Topic t1 -> positions at first Unread (t1m3 at row index 2 = 100px)
    host.querySelector('#main-content button.ui-topic-summary[data-topic-id="t1"]')!.click()
    flushSync()
    const topicScrollEl = host.querySelector('#main-content .topic-view__scroll')!
    topicScrollEl.clientHeight = 100
    topicScrollEl.scrollHeight = 250
    topicScrollEl.layoutRowHeight = 50

    await settle()
    await settle()
    flushSync()

    expect(topicScrollEl.scrollTop).toBe(100)
    expect(sessionModel.unread('c1').state.entry?.boundary).toBe(8)
    expect(host.querySelector(`#main-content [data-message-id="${topicMsgs[2].id}"] [data-read-marker="true"]`)).not.toBeNull()

    // 7. Scroll TopicView to the bottom, open phone panel, receive live Topic Message, close panel -> follows bottom (300px)
    topicScrollEl.scrollTop = 200
    topicScrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    topicScrollEl.scrollTop = 250
    topicScrollEl.dispatchEvent(new MiniDomEvent('scroll'))
    flushSync()
    await settle()

    host.querySelector('#main-content button[aria-label="パネルを開く(⌘.)"]')!.click()
    flushSync()
    await settle()
    expect(host.querySelector('.workspace')?.getAttribute('data-mobile-level')).toBe('panel')
    expect(topicScrollEl.isRenderedVisible()).toBe(false)

    const t1m7 = { ...record(14, 'c1'), sender: 'other', topic_id: 't1', body: 'トピック新着7' }
    net.unreadChannels.c1.as_of_seq = 14
    net.topicLists.c1 = ok({ as_of_seq: 14, has_more: false, topics: [t1Summary] })
    net.topicSummaries['c1:t1'] = ok({ as_of_seq: 14, topic: t1Summary })
    topicScrollEl.scrollHeight = 300
    net.event({ type: 'message', message: t1m7 })
    await settle()
    flushSync()

    host.querySelector('#panel-content button[aria-label="パネルを閉じる(Esc)"]')!.click()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('.workspace')?.getAttribute('data-mobile-level')).toBe('view')
    expect(topicScrollEl.isRenderedVisible()).toBe(true)
    expect(topicScrollEl.scrollTop).toBe(300)
    expect(host.querySelector(`#main-content [data-message-id="${topicMsgs[2].id}"] [data-read-marker="true"]`)).not.toBeNull()
    expect(net.markReads.at(-1)).toEqual({ scope: { channel: 'c1', topicId: 't1' }, body: { read_seq: 14 } })

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

  it('subscribes to Unread per Channel in Workspace/ChannelList and does not re-read timeline when typing in Timeline composer', async () => {
    const net = fakeNetwork()
    const rawSession = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
    const unreadAdapters = new Map<string, ReturnType<typeof unreadAdapter>>()
    let c2UnreadReads = 0
    let c1TimelineReads = 0
    const baseSync = syncAdapter(rawSession.sync)
    const c1Channel = baseSync.channel('c1')
    const wrappedC1: typeof c1Channel = {
      ...c1Channel,
      get timeline() {
        c1TimelineReads++
        return c1Channel.timeline
      },
      get composer() {
        return c1Channel.composer
      },
      get live() {
        return c1Channel.live
      },
    }
    const sessionModel = {
      channels: channelsAdapter(rawSession.channels),
      sync: {
        ...baseSync,
        get unavailable() {
          return baseSync.unavailable
        },
        channel: (id: string) => (id === 'c1' ? wrappedC1 : baseSync.channel(id)),
      },
      topics: (id: string) => topicsAdapter(rawSession.topics, id),
      replies: (id: string) => repliesAdapter(rawSession.replies, id),
      unread: (id: string) => {
        let a = unreadAdapters.get(id)
        if (!a) {
          const base = unreadAdapter(rawSession.unread, id)
          a =
            id === 'c2'
              ? {
                  ...base,
                  get state() {
                    c2UnreadReads++
                    return base.state
                  },
                }
              : base
          unreadAdapters.set(id, a)
        }
        return a
      },
      navigationTargets: navigationTargetsAdapter(rawSession.navigationTargets),
      close: rawSession.close,
    }
    net.socket.onReady()
    net.pages.c1 = ok({ messages: [record(1, 'c1')], has_more: false })
    net.pages.c2 = ok({ messages: [record(1, 'c2')], has_more: false })
    net.unreadChannels.c1 = {
      ...channel('c1', 'general'),
      as_of_seq: 1,
      read_seq: 0,
      unread_count: 1,
      main_unread_count: 1,
    }
    net.unreadChannels.c2 = {
      ...channel('c2', 'random'),
      as_of_seq: 1,
      read_seq: 0,
      unread_count: 2,
      main_unread_count: 2,
    }
    net.lists[0].resolve(ok({ channels: [channel('c1', 'general'), channel('c2', 'random')] }))
    await settle()
    net.subscribed('c1', 1)
    await settle()

    testWin.innerWidth = 1280
    let href = '/o/org-1/c/c1'
    let historyState: unknown = null
    const browser: NavigationBrowser = {
      innerWidth: 1280,
      location: { get href() { return href } } as Location,
      history: {
        get state() { return historyState },
        pushState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
        replaceState(state: unknown, _: string, url?: string | URL | null) { historyState = state; href = String(url) },
      } as History,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    const navigation = createNavigation(browser)
    const host = testDoc.createElement('div')
    testDoc.body.appendChild(host)
    const instance = mount(Workspace, {
      target: host as unknown as Element,
      props: {
        session: sessionModel,
        navigation,
        organization: {
          organization: {
            organization_id: 'org-1',
            name: 'Org 1',
            capabilities: {
              can_create_channels: { allowed: true },
              can_invite: { allowed: true },
              can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: true },
            },
          },
          member: { id: 'me', name: '自分', role: 'admin' },
        },
        selectedOrganizationId: 'org-1',
      },
    })
    await settle()
    flushSync()

    const c2ReadsBefore = c2UnreadReads
    // Live message on c1 changes c1's Unread -> must NOT re-read c2's Unread in Workspace/ChannelList.
    net.event({ type: 'message', message: { ...record(2, 'c1'), sender: 'other', body: 'c1新着' } })
    await settle()
    flushSync()
    expect(c2UnreadReads).toBe(c2ReadsBefore)

    // Typing in c1's Composer -> must NOT re-read c1's timeline in Workspace/Timeline.
    const c1TimelineReadsBefore = c1TimelineReads
    const c1TimelineRefBefore = c1Channel.timeline
    c1Channel.setDraft('キーストロークテスト')
    c1Channel.setTopicDraft('トピック名テスト')
    await settle()
    flushSync()
    expect(c1TimelineReads).toBe(c1TimelineReadsBefore)
    expect(c1Channel.timeline).toBe(c1TimelineRefBefore)
    const textarea = host.querySelector('#main-content textarea') as unknown as { value: string } | null
    expect(textarea?.value).toBe('キーストロークテスト')

    navigation.destroy()
    await unmount(instance)
    sessionModel.close()
  })

})
