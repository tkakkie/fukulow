import { flushSync, mount, tick, unmount } from 'svelte'
import { parse, type AST } from 'svelte/compiler'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import Timeline from './Timeline.svelte'
import { topicsAdapter, type TopicsAdapter } from './topics.svelte'
import MessageRow from './ui/MessageRow.svelte'
import Workspace from './Workspace.svelte'

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
    this.dispatchEvent(new MiniDomEvent('click', { bubbles: true, cancelable: true }))
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
    const channelColumn = this.closest('.channel-column')
    if (channelColumn) {
      const workspace = channelColumn.closest('.workspace')
      const width = this.ownerDocument.defaultView?.innerWidth ?? 1280
      if (workspace) {
        if (width >= 600 && width < 960 && workspace.getAttribute('data-drawer-open') !== 'true') {
          return false
        }
        if (width < 600 && workspace.getAttribute('data-mobile-level') !== 'channels') {
          return false
        }
      }
    }
    return true
  }

  getBoundingClientRect() {
    if (!this.isRenderedVisible()) {
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
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

describe('Timeline, MessageRow and Workspace component states (docs/ui.md §3, §5)', () => {
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
    expect(ch.timeline.draft).toBe('入力途中の大事な下書き')
    expect(ch.timeline.pending).toHaveLength(1)

    // 2. Clicking キャンセル closes the dialog and preserves both the draft and the failed Message
    buttonsByText(dialog!, 'キャンセル')[0].click()
    flushSync()
    await settle()
    flushSync()

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(ch.timeline.draft).toBe('入力途中の大事な下書き')
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
    expect(ch.timeline.draft).toBe('拒否されたメッセージ本文')
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
              can_manage_roles: { allowed: true },
            },
          },
        },
        selectedOrganizationId: 'org-1',
        resolveSenderName: (id: string) => (id === 'other' ? '田中' : '自分'),
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

    // Return to Channel -> focuses the Topic's summary line and preserves the Channel draft
    const backToChannelBtn = queryAll(host, '#main-content button').find(
      (b) => b.getAttribute('aria-label') === 'チャンネルへ戻る',
    )!
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
  })
})
