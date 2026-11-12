import { flushSync, mount, unmount } from 'svelte'
import { parse, type AST } from 'svelte/compiler'
import { afterEach, expect, it, vi } from 'vitest'
import { createChannelMembers, channelMemberError } from './channel-members'
import { channelMembersAdapter } from './channel-members.svelte'
import ChannelMembers from './ChannelMembers.svelte'
import * as api from './api'

afterEach(() => vi.useRealTimers())
function fixture() {
  const deps = {
    listChannelMembers: vi.fn().mockResolvedValue({ ok: true, data: { members: [{ id: 'self', name: '本人', role: 'admin', manager: true }] } }),
    addChannelMember: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    removeChannelMember: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    changeChannelManager: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  }
  const observed = vi.fn(), left = vi.fn()
  const controller = createChannelMembers('org', 'channel', observed, deps, left)
  return { deps, observed, left, controller }
}
it('loads generated Member records, refreshes after add/remove, and forwards leave without restoring a list', async () => {
  const c = fixture(); await c.controller.load()
  expect(c.controller.get().members[0]).toEqual({ id: 'self', name: '本人', role: 'admin', manager: true })
  await c.controller.add('other'); expect(c.deps.addChannelMember).toHaveBeenCalledWith('org', 'channel', { member_id: 'other' })
  await c.controller.remove('other'); expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(3)
  await c.controller.remove('self'); expect(c.left).not.toHaveBeenCalled(); expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(4)
})
it('grants and revokes the Channel manager right, prevents double clicks while pending, and refreshes the list on 204 success', async () => {
  const c = fixture(); await c.controller.load()
  let finish!: (r: api.Result<undefined>) => void
  c.deps.changeChannelManager.mockImplementationOnce(() => new Promise(r => { finish = r }))
  c.deps.listChannelMembers.mockResolvedValueOnce({
    ok: true,
    data: { members: [{ id: 'self', name: '本人', role: 'admin', manager: true }, { id: 'other', name: '佐藤', role: 'member', manager: true }] },
  })
  const first = c.controller.changeManager('other', true)
  expect(c.controller.get().busy).toBe(true)
  // Double click while pending is ignored
  await c.controller.changeManager('other', false)
  await c.controller.add('other')
  await c.controller.remove('other')
  expect(c.deps.changeChannelManager).toHaveBeenCalledTimes(1)
  expect(c.deps.changeChannelManager).toHaveBeenCalledWith('org', 'channel', 'other', { manager: true })
  expect(c.deps.addChannelMember).not.toHaveBeenCalled()
  expect(c.deps.removeChannelMember).not.toHaveBeenCalled()

  finish({ ok: true, data: undefined })
  await first
  expect(c.controller.get().busy).toBe(false)
  expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(2)
  expect(c.controller.get().members).toEqual([
    { id: 'self', name: '本人', role: 'admin', manager: true },
    { id: 'other', name: '佐藤', role: 'member', manager: true },
  ])

  c.deps.listChannelMembers.mockResolvedValueOnce({
    ok: true,
    data: { members: [{ id: 'self', name: '本人', role: 'admin', manager: true }, { id: 'other', name: '佐藤', role: 'member', manager: false }] },
  })
  await c.controller.changeManager('other', false)
  expect(c.deps.changeChannelManager).toHaveBeenLastCalledWith('org', 'channel', 'other', { manager: false })
  expect(c.deps.listChannelMembers).toHaveBeenCalledTimes(3)
  expect(c.controller.get().members[1].manager).toBe(false)
})
it('C9 stops automatic Member work and fences late results while same-session late 401 is still observed', async () => {
  const c = fixture()
  let resolve!: (r: api.Result<api.ChannelMemberList>) => void
  c.deps.listChannelMembers.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const loading = c.controller.load(); c.controller.unavailable()
  resolve({ ok: true, data: { members: [{ id: 'late', name: '古い結果', role: 'member', manager: false }] } }); await loading
  expect(c.controller.get().members).toEqual([])
  await c.controller.load(); await c.controller.add('other'); await c.controller.remove('other'); await c.controller.changeManager('other', true)
  expect(c.deps.listChannelMembers).toHaveBeenCalledOnce(); expect(c.deps.addChannelMember).not.toHaveBeenCalled(); expect(c.deps.changeChannelManager).not.toHaveBeenCalled()
  const b = fixture(); let end!: (r: api.Result<api.ChannelMemberList>) => void
  b.deps.listChannelMembers.mockImplementationOnce(() => new Promise(r => { end = r }))
  const pending = b.controller.load(); b.controller.close(); end({ ok: false, kind: 'http', status: 401 }); await pending
  expect(b.observed).toHaveBeenCalledWith({ ok: false, kind: 'http', status: 401 })
})
it('explains both private Channel protections in Japanese and preserves the list on refusal', async () => {
  const c = fixture(); await c.controller.load()
  for (const error of ['last_channel_manager', 'last_channel_grant']) {
    c.deps.removeChannelMember.mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error })
    await c.controller.remove('other')
    expect(c.controller.get().error).toBe(channelMemberError({ ok: false, kind: 'http', status: 409, error }))
    expect(c.controller.get().error).toMatch(/最後/); expect(c.controller.get().members).toHaveLength(1)
  }
})
it('explains every Channel manager PATCH refusal in Japanese and preserves the list without raw codes', async () => {
  const c = fixture(); await c.controller.load()
  const refusals: Array<[number, string, string]> = [
    [409, 'last_channel_manager', '最後のチャンネル管理者は外せません。先に別のチャンネル管理者を設定してください。'],
    [400, 'channel_manager_private_only', 'パブリックチャンネルではチャンネル管理者を設定できません。'],
    [400, 'channel_manager_guest', 'ゲストにはチャンネル管理者を設定できません。'],
    [403, 'forbidden', 'この操作の権限がありません。'],
    [404, 'member_not_found', '対象のメンバーが見つかりません。一覧を更新してからもう一度お試しください。'],
    [404, 'channel_grant_not_found', 'このメンバーはチャンネルに参加していません。一覧を更新してからもう一度お試しください。'],
    [404, 'channel not found', 'このチャンネルは利用できません。チャンネル一覧から選び直してください。'],
  ]
  for (const [status, error, expected] of refusals) {
    c.deps.changeChannelManager.mockResolvedValueOnce({ ok: false, kind: 'http', status, error })
    await c.controller.changeManager('other', true)
    expect(c.controller.get().error).toBe(expected)
    expect(c.controller.get().error).not.toContain(error)
    expect(c.controller.get().error).not.toContain(String(status))
    expect(c.controller.get().members).toHaveLength(1)
    expect(c.deps.listChannelMembers).toHaveBeenCalledOnce()
  }
})
it('times out loading after 10 seconds and never lets a late list replace the retry', async () => {
  vi.useFakeTimers(); const c = fixture(); let late!: (r: api.Result<api.ChannelMemberList>) => void
  c.deps.listChannelMembers.mockImplementationOnce(() => new Promise(r => { late = r }))
  const first = c.controller.load(); await vi.advanceTimersByTimeAsync(10_000); await first
  expect(c.controller.get().loading).toBe(false); expect(c.controller.get().error).not.toBe('')
  await c.controller.load(); late({ ok: true, data: { members: [] } }); await Promise.resolve()
  expect(c.controller.get().members[0].id).toBe('self')
})

class MiniNode {
  parentNode: MiniNode | null = null
  childNodes: MiniNode[] = []
  constructor(readonly nodeType: number, readonly nodeName: string, public ownerDocument: MiniDoc | null, public data = '') {}
  get nodeValue(): string { return this.data }
  set nodeValue(v: string) { this.data = String(v ?? '') }
  get firstChild(): MiniNode | null { return this.childNodes[0] ?? null }
  get lastChild(): MiniNode | null { return this.childNodes[this.childNodes.length - 1] ?? null }
  get nextSibling(): MiniNode | null {
    if (!this.parentNode) return null
    const i = this.parentNode.childNodes.indexOf(this)
    return i >= 0 ? (this.parentNode.childNodes[i + 1] ?? null) : null
  }
  get previousSibling(): MiniNode | null {
    if (!this.parentNode) return null
    const i = this.parentNode.childNodes.indexOf(this)
    return i > 0 ? (this.parentNode.childNodes[i - 1] ?? null) : null
  }
  get parentElement(): MiniEl | null { return this.parentNode instanceof MiniEl ? this.parentNode : null }
  get isConnected(): boolean {
    let cur: MiniNode | null = this
    while (cur) { if (cur.nodeType === 9) return true; cur = cur.parentNode }
    return false
  }
  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.data
    return this.childNodes.map(c => c.textContent).join('')
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    if (v && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(v))
  }
  appendChild<T extends MiniNode>(child: T): T { return this.insertBefore(child, null) }
  insertBefore<T extends MiniNode>(child: T, ref: MiniNode | null): T {
    if (child.nodeType === 11) { for (const g of [...child.childNodes]) this.insertBefore(g, ref); return child }
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const idx = ref ? this.childNodes.indexOf(ref) : -1
    if (idx === -1) this.childNodes.push(child)
    else this.childNodes.splice(idx, 0, child)
    return child
  }
  removeChild<T extends MiniNode>(child: T): T {
    const i = this.childNodes.indexOf(child)
    if (i !== -1) { this.childNodes.splice(i, 1); child.parentNode = null }
    return child
  }
  remove(): void { this.parentNode?.removeChild(this) }
  append(...nodes: (MiniNode | string)[]): void {
    for (const n of nodes) {
      this.appendChild(typeof n === 'string' ? (this.ownerDocument ?? (this as unknown as MiniDoc)).createTextNode(n) : n)
    }
  }
  before(...nodes: MiniNode[]): void { for (const n of nodes) this.parentNode?.insertBefore(n, this) }
  after(...nodes: MiniNode[]): void { const ref = this.nextSibling; for (const n of nodes) this.parentNode?.insertBefore(n, ref) }
  cloneNode(deep = false): MiniNode {
    const copy = new MiniNode(this.nodeType, this.nodeName, this.ownerDocument, this.data)
    if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true))
    return copy
  }
  private listeners = new Map<string, Array<(e: unknown) => void>>()
  addEventListener(type: string, fn: ((e: unknown) => void) | null): void {
    if (!fn) return
    const list = this.listeners.get(type) ?? []
    list.push(fn); this.listeners.set(type, list)
  }
  removeEventListener(type: string, fn: ((e: unknown) => void) | null): void {
    const list = this.listeners.get(type)
    if (!list || !fn) return
    const i = list.indexOf(fn); if (i !== -1) list.splice(i, 1)
  }
  dispatchClick(): void {
    let cur: MiniNode | null = this
    const evt = { type: 'click', target: this, currentTarget: this as MiniNode | null, defaultPrevented: false, cancelBubble: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.cancelBubble = true } }
    while (cur && !evt.cancelBubble) {
      evt.currentTarget = cur
      for (const fn of [...(cur.listeners.get('click') ?? [])]) fn.call(cur, evt)
      cur = cur.parentNode
    }
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
  get disabled(): boolean { return this.attrs.has('disabled') }
  set disabled(v: boolean) { if (v) this.attrs.set('disabled', ''); else this.attrs.delete('disabled') }
  get className(): string { return this.attrs.get('class') ?? '' }
  set className(v: string) { this.setAttribute('class', v) }
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
  focus(): void { if (!this.disabled && this.ownerDocument) this.ownerDocument.activeElement = this }
  click(): void { if (!this.disabled) { this.focus(); this.dispatchClick() } }
  querySelectorAll(sel: string): MiniEl[] { return findAll(this, sel) }
  querySelector(sel: string): MiniEl | null { return findAll(this, sel)[0] ?? null }
  override cloneNode(deep = false): MiniEl {
    const copy = new MiniEl(this.localName, this.ownerDocument)
    for (const [k, v] of this.attrs) copy.attrs.set(k, v)
    if (deep) {
      for (const c of this.childNodes) copy.appendChild(c.cloneNode(true))
      for (const c of this.content.childNodes) copy.content.appendChild(c.cloneNode(true))
    }
    return copy
  }
}

class MiniDoc extends MiniNode {
  readonly body: MiniEl
  activeElement: MiniEl | null = null
  constructor() {
    super(9, '#document', null)
    this.ownerDocument = this
    this.body = new MiniEl('body', this)
    this.appendChild(this.body)
    this.activeElement = this.body
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

function findAll(root: MiniNode, sel: string): MiniEl[] {
  const out: MiniEl[] = []
  const visit = (n: MiniNode) => {
    for (const c of n.childNodes) {
      if (c instanceof MiniEl) {
        const match =
          sel === 'button' ? c.localName === 'button'
          : sel === 'li' ? c.localName === 'li'
          : sel === '[role="dialog"]' ? c.getAttribute('role') === 'dialog'
          : sel === '[role="alert"]' ? c.getAttribute('role') === 'alert'
          : sel === '.ui-chip' ? c.className.split(/\s+/).includes('ui-chip')
          : sel.startsWith('button:not(:disabled)') ? c.localName === 'button' && !c.disabled
          : false
        if (match) out.push(c)
      }
      visit(c)
    }
  }
  visit(root)
  return out
}

it('renders チャンネル管理者 in the メンバー tab, hides controls without can_manage_managers, confirms or cancels via Dialog, disables controls while pending, refreshes after 204, and shows Japanese refusals', async () => {
  const keys = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'Text', 'Comment', 'DocumentFragment'] as const
  const saved = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const doc = new MiniDoc()
  const win = new MiniNode(9, '#window', doc)
  const patches: Record<string, unknown> = {
    window: win, document: doc, Node: MiniNode, Element: MiniEl, HTMLElement: MiniEl, HTMLButtonElement: MiniEl, Text: MiniText, Comment: MiniComment, DocumentFragment: MiniNode,
  }
  for (const [k, v] of Object.entries(patches)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })

  try {
    const initialMembers: api.ChannelMember[] = [
      { id: 'self', name: '山田 太郎', role: 'owner', manager: true },
      { id: 'm2', name: '佐藤 花子', role: 'member', manager: false },
    ]
    const deps = {
      listChannelMembers: vi.fn<typeof api.listChannelMembers>().mockResolvedValue({ ok: true, data: { members: initialMembers } }),
      addChannelMember: vi.fn<typeof api.addChannelMember>().mockResolvedValue({ ok: true, data: undefined }),
      removeChannelMember: vi.fn<typeof api.removeChannelMember>().mockResolvedValue({ ok: true, data: undefined }),
      changeChannelManager: vi.fn<typeof api.changeChannelManager>().mockResolvedValue({ ok: true, data: undefined }),
    }
    const controller = createChannelMembers('org-1', 'ch-1', vi.fn(), deps)
    await controller.load()
    const model = channelMembersAdapter(controller)

    const makeChannel = (canManageManagers: boolean): api.Channel => ({
      id: 'ch-1',
      name: 'secret',
      visibility: 'private',
      capabilities: {
        can_add_members: { allowed: false },
        can_remove_members: { allowed: false },
        can_manage_managers: { allowed: canManageManagers },
        can_leave: { allowed: true },
      },
    })

    // 1. Without can_manage_managers: チャンネル管理者 is shown for holders, but grant/revoke controls are hidden
    const hostHidden = doc.createElement('div')
    doc.body.appendChild(hostHidden)
    const instHidden = mount(ChannelMembers, {
      target: hostHidden as unknown as Element,
      props: { model, channel: makeChannel(false), self: 'self', candidates: [] },
    })
    flushSync()
    const rowsHidden = hostHidden.querySelectorAll('li')
    expect(rowsHidden).toHaveLength(2)
    expect(rowsHidden[0].textContent).toContain('山田 太郎')
    expect(rowsHidden[0].textContent).toContain('チャンネル管理者')
    expect(rowsHidden[1].textContent).toContain('佐藤 花子')
    expect(rowsHidden[1].textContent).not.toContain('チャンネル管理者')
    expect(hostHidden.querySelectorAll('button').map(b => b.textContent.trim())).toEqual(['退出する'])
    await unmount(instHidden)
    hostHidden.remove()

    // 2. With can_manage_managers: grant/revoke buttons appear; cancel sends nothing; confirm sends PATCH and refreshes
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    const inst = mount(ChannelMembers, {
      target: host as unknown as Element,
      props: { model, channel: makeChannel(true), self: 'self', candidates: [] },
    })
    flushSync()

    const findButton = (text: string) => host.querySelectorAll('button').find(b => b.textContent.trim() === text)
    expect(findButton('チャンネル管理者を解除する')).toBeDefined()
    expect(findButton('チャンネル管理者にする')).toBeDefined()

    // Click grant on 佐藤 花子 -> opens confirm Dialog, then click キャンセル -> sends nothing
    findButton('チャンネル管理者にする')!.click()
    flushSync()
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('チャンネル管理者を付与しますか？')
    findButton('キャンセル')!.click()
    flushSync()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(deps.changeChannelManager).not.toHaveBeenCalled()

    // Click grant on 佐藤 花子 again -> confirm in Dialog -> holds pending (disables buttons against double click) -> resolves 204 -> refreshes list
    let resolvePatch!: (r: api.Result<undefined>) => void
    deps.changeChannelManager.mockImplementationOnce(() => new Promise(r => { resolvePatch = r }))
    deps.listChannelMembers.mockResolvedValueOnce({
      ok: true,
      data: {
        members: [
          { id: 'self', name: '山田 太郎', role: 'owner', manager: true },
          { id: 'm2', name: '佐藤 花子', role: 'member', manager: true },
        ],
      },
    })

    findButton('チャンネル管理者にする')!.click()
    flushSync()
    findButton('付与する')!.click()
    flushSync()

    expect(deps.changeChannelManager).toHaveBeenCalledTimes(1)
    expect(deps.changeChannelManager).toHaveBeenCalledWith('org-1', 'ch-1', 'm2', { manager: true })
    // While pending, action buttons are disabled so a double click is prevented
    expect(findButton('チャンネル管理者にする')?.disabled).toBe(true)
    findButton('チャンネル管理者にする')?.click()
    expect(deps.changeChannelManager).toHaveBeenCalledTimes(1)

    resolvePatch({ ok: true, data: undefined })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    flushSync()

    expect(deps.listChannelMembers).toHaveBeenCalledTimes(2)
    const rowsAfterGrant = host.querySelectorAll('li')
    expect(rowsAfterGrant[1].textContent).toContain('チャンネル管理者')

    // 3. Each refusal shows its Japanese copy in the alert banner
    const refusals: Array<[number, string, string]> = [
      [409, 'last_channel_manager', '最後のチャンネル管理者は外せません。先に別のチャンネル管理者を設定してください。'],
      [400, 'channel_manager_private_only', 'パブリックチャンネルではチャンネル管理者を設定できません。'],
      [400, 'channel_manager_guest', 'ゲストにはチャンネル管理者を設定できません。'],
      [403, 'forbidden', 'この操作の権限がありません。'],
      [404, 'member_not_found', '対象のメンバーが見つかりません。一覧を更新してからもう一度お試しください。'],
      [404, 'channel_grant_not_found', 'このメンバーはチャンネルに参加していません。一覧を更新してからもう一度お試しください。'],
      [404, 'channel not found', 'このチャンネルは利用できません。チャンネル一覧から選び直してください。'],
    ]
    for (const [status, error, copy] of refusals) {
      deps.changeChannelManager.mockResolvedValueOnce({ ok: false, kind: 'http', status, error })
      host.querySelectorAll('button').find(b => b.textContent.trim() === 'チャンネル管理者を解除する')!.click()
      flushSync()
      findButton('解除する')!.click()
      for (let i = 0; i < 8; i++) await Promise.resolve()
      flushSync()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(copy)
    }

    await unmount(inst)
  } finally {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc)
      else Reflect.deleteProperty(globalThis, k)
    }
  }
})
