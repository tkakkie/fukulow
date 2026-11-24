import { parse, type AST } from 'svelte/compiler'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'

type ListenerEntry = {
  fn: (event: MiniDomEvent) => void
  capture: boolean
}

export interface MiniDomEventInit {
  bubbles?: boolean
  cancelable?: boolean
  key?: string
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
  keyCode?: number
}

export class MiniDomEvent {
  readonly type: string
  readonly bubbles: boolean
  readonly cancelable: boolean
  defaultPrevented = false
  cancelBubble = false
  target: unknown = null
  currentTarget: unknown = null
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
  keyCode: number
  private path: MiniEventTarget[] = []

  constructor(type: string, init?: MiniDomEventInit) {
    this.type = type
    this.bubbles = init?.bubbles ?? false
    this.cancelable = init?.cancelable ?? false
    this.key = init?.key ?? ''
    this.shiftKey = init?.shiftKey ?? false
    this.altKey = init?.altKey ?? false
    this.ctrlKey = init?.ctrlKey ?? false
    this.metaKey = init?.metaKey ?? false
    this.isComposing = init?.isComposing ?? false
    this.keyCode = init?.keyCode ?? 0
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

export class MiniEventTarget {
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
    if (list && list.length > 0) {
      for (const entry of [...list]) {
        if (entry.capture !== capture) continue
        Object.defineProperty(event, 'currentTarget', {
          configurable: true,
          get: () => this,
        })
        entry.fn.call(this, event)
      }
    }
    if (!capture && this instanceof MiniNode && this.ownerDocument?.options.invokeDelegatedProp) {
      const prop = (this as unknown as Record<string, unknown>)[`__${event.type}`]
      if (typeof prop === 'function') {
        Object.defineProperty(event, 'currentTarget', {
          configurable: true,
          get: () => this,
        })
        ;(prop as (e: MiniDomEvent) => void).call(this, event)
      }
    }
  }
}

export class MiniNode extends MiniEventTarget {
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
    return this.childNodes
      .filter((c) => c.nodeType !== 8)
      .map((c) => c.textContent)
      .join('')
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

  before(...nodes: (MiniNode | string)[]): void {
    if (!this.parentNode) return
    for (const n of nodes) {
      const node = typeof n === 'string' ? (this.ownerDocument ?? (this as unknown as MiniDocument)).createTextNode(n) : n
      this.parentNode.insertBefore(node, this)
    }
  }

  after(...nodes: (MiniNode | string)[]): void {
    if (!this.parentNode) return
    const ref = this.nextSibling
    for (const n of nodes) {
      const node = typeof n === 'string' ? (this.ownerDocument ?? (this as unknown as MiniDocument)).createTextNode(n) : n
      this.parentNode.insertBefore(node, ref)
    }
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
    if (
      this.ownerDocument &&
      !this.ownerDocument.options.stopBubbleAtDocument &&
      path[path.length - 1] === this.ownerDocument &&
      this.ownerDocument.defaultView
    ) {
      path.push(this.ownerDocument.defaultView)
    }
    return path
  }
}

export class MiniCharacterData extends MiniNode {
  data: string

  constructor(nodeType: 3 | 8, nodeName: string, data: string, ownerDocument: MiniDocument | null) {
    super(nodeType, nodeName, ownerDocument)
    this.data = data
  }

  get nodeValue(): string {
    return this.data
  }

  set nodeValue(v: string | null) {
    this.data = v ?? ''
  }

  override cloneNode(): MiniCharacterData {
    return new MiniCharacterData(this.nodeType as 3 | 8, this.nodeName, this.data, this.ownerDocument)
  }
}

export class MiniText extends MiniCharacterData {
  constructor(data: string, ownerDocument: MiniDocument | null) {
    super(3, '#text', data, ownerDocument)
  }

  override cloneNode(): MiniText {
    return new MiniText(this.data, this.ownerDocument)
  }
}

export class MiniComment extends MiniCharacterData {
  constructor(data: string, ownerDocument: MiniDocument | null) {
    super(8, '#comment', data, ownerDocument)
  }

  override cloneNode(): MiniComment {
    return new MiniComment(this.data, this.ownerDocument)
  }
}

export class MiniDocumentFragment extends MiniNode {
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

const ZERO_RECT = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
const UNIT_RECT = { top: 0, bottom: 24, left: 0, right: 260, width: 260, height: 24, x: 0, y: 0, toJSON: () => ({}) }

export class MiniElement extends MiniNode {
  readonly tagName: string
  readonly localName: string
  private readonly attrs = new Map<string, string>()
  private _value = ''
  defaultValue = ''
  checked = false
  scrollIntoView() {}
  selectionStart: number | null = 0
  selectionEnd: number | null = 0
  setSelectionRange(start: number, end = start) { this.selectionStart = start; this.selectionEnd = end }
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0
  readonly content: MiniDocumentFragment
  readonly dataset: Record<string, string> = {}
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
    this.scrollHeight = ownerDocument?.options.initialScrollHeight ?? 0
    this.clientHeight = ownerDocument?.options.initialClientHeight ?? 0
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

  get open(): boolean {
    return this.attrs.has('open')
  }

  set open(v: boolean) {
    const next = Boolean(v)
    const prev = this.attrs.has('open')
    if (next) this.attrs.set('open', '')
    else this.attrs.delete('open')
    if (this.tagName === 'DETAILS' && next !== prev) this.dispatchEvent(new MiniDomEvent('toggle'))
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
    const opts = this.ownerDocument?.options
    if (this.disabled || !this.ownerDocument) return
    if (!opts?.allowDetachedFocus && !this.isConnected) return
    const changed = this.ownerDocument.activeElement !== this
    this.ownerDocument.activeElement = this
    if (changed && (opts?.dispatchFocusIn ?? true)) {
      this.dispatchEvent(new MiniDomEvent('focusin', { bubbles: true }))
    }
  }

  click(): void {
    if (this.disabled) return
    const opts = this.ownerDocument?.options
    if (opts?.focusOnClick ?? true) {
      this.focus()
    }
    const evt = new MiniDomEvent('click', { bubbles: true, cancelable: true })
    this.dispatchEvent(evt)
    const parent = this.parentNode
    if (!evt.defaultPrevented && this.tagName === 'SUMMARY' && parent instanceof MiniElement && parent.tagName === 'DETAILS') {
      parent.open = !parent.open
    }
    const submitMode = opts?.clickSubmit ?? 'default'
    if (
      submitMode !== 'never' &&
      (submitMode === 'always' || !evt.defaultPrevented) &&
      this.tagName === 'BUTTON' &&
      (this.getAttribute('type') ?? 'submit') === 'submit'
    ) {
      const form = this.closest('form')
      form?.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
    }
  }

  input(val: string): void {
    if (this.disabled) return
    this._value = val
    this.dispatchEvent(new MiniDomEvent('input', { bubbles: true, cancelable: true }))
  }

  keydown(
    key: string,
    opts: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number } = {},
  ): MiniDomEvent {
    const evt = new MiniDomEvent('keydown', { bubbles: true, cancelable: true, key, ...opts })
    this.dispatchEvent(evt)
    return evt
  }

  override dispatchEvent(event: MiniDomEvent): boolean {
    const notPrevented = super.dispatchEvent(event)
    if (
      notPrevented &&
      event.type === 'keydown' &&
      this.tagName === 'INPUT' &&
      !this.disabled &&
      event.key === 'Enter' &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const form = this.closest('form')
      const defaultSubmit = form?.querySelectorAll('button').find(
        (btn) => (btn.getAttribute('type') ?? 'submit') === 'submit',
      )
      if (form && defaultSubmit && !defaultSubmit.disabled) {
        const clickEvt = new MiniDomEvent('click', { bubbles: true, cancelable: true })
        defaultSubmit.dispatchEvent(clickEvt)
        const submitMode = this.ownerDocument?.options.clickSubmit ?? 'default'
        if (submitMode !== 'never' && (submitMode === 'always' || !clickEvt.defaultPrevented)) {
          form.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
        }
      }
    } else if (
      notPrevented &&
      event.type === 'keydown' &&
      this.tagName === 'BUTTON' &&
      !this.disabled &&
      event.key === 'Enter' &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      this.click()
    }
    return notPrevented
  }

  get hidden(): boolean {
    return this.attrs.has('hidden')
  }

  set hidden(v: boolean) {
    if (v) this.setAttribute('hidden', '')
    else this.removeAttribute('hidden')
  }

  // Minimal non-emulated box so components that check connection/non-zero rect work in Node.
  // Real geometry, CSS visibility and viewport breakpoints are covered by Playwright in web/e2e/.
  getBoundingClientRect() {
    if (this.ownerDocument?.options.zeroRect) return ZERO_RECT
    return this.isConnected ? UNIT_RECT : ZERO_RECT
  }

  getClientRects() {
    return this.isConnected ? [UNIT_RECT] : []
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

export interface MiniDomOptions {
  observers?: boolean
  initialScrollHeight?: number
  initialClientHeight?: number
  zeroRect?: boolean
  stopBubbleAtDocument?: boolean
  invokeDelegatedProp?: boolean
  focusOnClick?: boolean
  allowDetachedFocus?: boolean
  dispatchFocusIn?: boolean
  clickSubmit?: 'default' | 'always' | 'never'
}

export class MiniDocument extends MiniNode {
  readonly documentElement: MiniElement
  readonly head: MiniElement
  readonly body: MiniElement
  readonly options: MiniDomOptions
  activeElement: MiniElement | null = null
  defaultView: MiniWindow | null = null
  visibilityState = 'visible'

  constructor(options: MiniDomOptions = {}) {
    super(9, '#document', null)
    this.options = options
    this.ownerDocument = this
    this.documentElement = new MiniElement('html', this)
    this.head = new MiniElement('head', this)
    this.body = new MiniElement('body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
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

  getElementById(id: string): MiniElement | null {
    return this.querySelector(`#${id}`)
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

export class MiniWindow extends MiniEventTarget {
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

export function queryAll(root: MiniNode, selector: string): MiniElement[] {
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

export function queryFirst(root: MiniNode, selector: string): MiniElement | null {
  return queryAll(root, selector)[0] ?? null
}

export function buttonsByText(root: MiniNode, text: string): MiniElement[] {
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

const OBSERVER_GLOBAL_KEYS = ['ResizeObserver', 'IntersectionObserver'] as const

class StubObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function installGlobals(options: MiniDomOptions = {}): { doc: MiniDocument; win: MiniWindow; restore: () => void } {
  const keys = options.observers ? [...GLOBAL_KEYS, ...OBSERVER_GLOBAL_KEYS] : [...GLOBAL_KEYS]
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
  for (const key of keys) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  const doc = new MiniDocument(options)
  const win = new MiniWindow(doc)
  const patches: Record<string, unknown> = {
    window: win,
    document: doc,
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
  if (options.observers) {
    patches.ResizeObserver = StubObserver
    patches.IntersectionObserver = StubObserver
  }
  for (const [k, v] of Object.entries(patches)) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  }
  const restore = () => {
    for (const [key, desc] of savedGlobals) {
      if (desc) Object.defineProperty(globalThis, key, desc)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  return { doc, win, restore }
}

export async function withMiniDom<T>(
  fn: (doc: MiniDocument, win: MiniWindow) => Promise<T>,
  options?: MiniDomOptions,
): Promise<T> {
  const { doc, win, restore } = installGlobals(options)
  try {
    return await fn(doc, win)
  } finally {
    restore()
  }
}

export interface MiniDomEnv {
  readonly doc: MiniDocument
  readonly win: MiniWindow
}

export function installMiniDom(options?: MiniDomOptions): MiniDomEnv {
  let doc!: MiniDocument
  let win!: MiniWindow
  let restore: (() => void) | null = null

  beforeAll(() => {
    const installed = installGlobals(options)
    doc = installed.doc
    win = installed.win
    restore = installed.restore
  })

  beforeEach(() => {
    doc.reset()
    win.innerWidth = 1280
    win.innerHeight = 800
  })

  afterAll(() => {
    restore?.()
    restore = null
  })

  afterEach(() => vi.useRealTimers())

  return {
    get doc() {
      return doc
    },
    get win() {
      return win
    },
  }
}
