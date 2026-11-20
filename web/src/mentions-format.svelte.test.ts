import { flushSync, mount, unmount } from 'svelte'
import { expect, it, vi } from 'vitest'
import { createAuthors, senderName } from './authors'
import { authorsAdapter } from './authors.svelte'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import Composer from './Composer.svelte'
import { rememberIdentityResponse } from './identity-order'
import { createNavigation, type NavigationBrowser } from './navigation'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import Timeline from './Timeline.svelte'
import { topicsAdapter } from './topics.svelte'
import MessageRow from './ui/MessageRow.svelte'
import { unreadAdapter } from './unread.svelte'
import Workspace from './Workspace.svelte'
import { installMiniDom, MiniDomEvent, MiniElement, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

it('Mention components render accepted tokens highlight the reader and follow authorized non-author renames without resolving rejected tokens', async () => {
  const id = '123e4567-e89b-12d3-a456-426614174000', unknown = '123e4567-e89b-12d3-a456-426614174001'
  const body = `@{member:${id}} @{member:${id}} @{member:${unknown}} <script>`
  const props = $state({ mentions: [{ member_id: id, name: '送信時の名前' }], pending: false })
  rememberIdentityResponse(props.mentions)
  const authors = createAuthors('org', vi.fn(), vi.fn()), adapter = authorsAdapter(authors)
  const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
  const instance = mount(MessageRow, { target: host as unknown as Element, props: {
    body, selfId: id, get mentions() { return props.mentions },
    get pendingStatus() { return props.pending ? 'sending' : undefined },
    resolveMentionName: adapter.mentionName,
  } })
  await settle()
  expect(host.querySelector('.body')?.textContent).toBe(`@送信時の名前 @送信時の名前 @{member:${unknown}} <script>`)
  expect(host.querySelectorAll('script')).toHaveLength(0)
  expect(host.querySelectorAll('.ui-message-row--mentioned')).toHaveLength(1)
  authors.replaceMembers([{ id, name: '新しい名前', role: 'member' }, { id: unknown, name: '後で参加', role: 'member' }])
  await settle()
  expect(host.querySelector('.body')?.textContent).toBe(`@新しい名前 @新しい名前 @{member:${unknown}} <script>`)
  props.mentions = [{ member_id: id, name: '無効化後の名前' }]; rememberIdentityResponse(props.mentions)
  await settle()
  expect(host.querySelector('.body')?.textContent).toContain('@無効化後の名前')
  props.mentions = []; await settle()
  expect(host.querySelector('.body')?.textContent).toBe(body)
  expect(host.querySelectorAll('.ui-message-row--mentioned')).toHaveLength(0)
  props.mentions = [{ member_id: id, name: '未確定' }]; props.pending = true; await settle()
  expect(host.querySelector('.body')?.textContent).toBe(body)
  expect(host.querySelectorAll('.ui-message-row--mentioned')).toHaveLength(0)
  await unmount(instance); authors.close()
})

it('MessageRow and MessageBody render formatted blocks, safe autolinks, Mention atoms inside code, and update renames without reparsing names as formatting or URLs (#628)', async () => {
  const id = '123e4567-e89b-12d3-a456-426614174000', rejected = '123e4567-e89b-12d3-a456-426614174001'
  const body = [
    `**bold ~~strike~~** \`code @{member:${id}} https://no-link.example\` https://example.com/ok?a=1`,
    `javascript:alert(1) <script>alert(1)</script> @{member:${id}} @{member:${rejected}}`,
    '> quoted **line**',
    '> second quote line',
    '```',
    `fenced @{member:${id}} **raw**`,
    '```',
  ].join('\n')
  const props = $state({
    mentions: [{ member_id: id, name: '**https://evil.example**' }],
    pending: false,
  })
  rememberIdentityResponse(props.mentions)
  const authors = createAuthors('org', vi.fn(), vi.fn()), adapter = authorsAdapter(authors)
  const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
  const instance = mount(MessageRow, { target: host as unknown as Element, props: {
    body, selfId: id, get mentions() { return props.mentions },
    get pendingStatus() { return props.pending ? 'sending' : undefined },
    resolveMentionName: adapter.mentionName,
  } })
  await settle()

  // Escaped markup never creates DOM script tags
  expect(host.querySelectorAll('script')).toHaveLength(0)

  // Only https://example.com/ok?a=1 is linked; resolved name with https://evil.example and code URL are NOT linked
  const links = host.querySelectorAll('a')
  expect(links).toHaveLength(1)
  expect(links[0].getAttribute('href')).toBe('https://example.com/ok?a=1')
  expect(links[0].textContent).toBe('https://example.com/ok?a=1')
  expect(links[0].getAttribute('target')).toBe('_blank')
  expect(links[0].getAttribute('rel')).toBe('noopener noreferrer')

  // Resolved name containing **https://evil.example** is rendered literally as a mention span, never reparsed as bold or link
  const mentionSpans = host.querySelectorAll('.ui-message-body__mention')
  expect(mentionSpans.map(el => el.textContent)).toEqual([
    '@**https://evil.example**',
    '@**https://evil.example**',
    '@**https://evil.example**',
  ])
  expect(host.querySelectorAll('strong').map(el => el.textContent)).toEqual(['bold strike', 'line'])
  expect(host.querySelectorAll('del').map(el => el.textContent)).toEqual(['strike'])
  expect(host.querySelector('blockquote')?.textContent).toBe('quoted line\nsecond quote line')
  expect(host.querySelector('pre code')?.textContent).toBe('fenced @**https://evil.example** **raw**')

  // Rename updates cached Message without re-tokenizing
  authors.replaceMembers([{ id, name: '改名後の名前', role: 'member' }])
  await settle()
  expect(host.querySelectorAll('.ui-message-body__mention').map(el => el.textContent)).toEqual([
    '@改名後の名前',
    '@改名後の名前',
    '@改名後の名前',
  ])
  expect(host.querySelector('pre code')?.textContent).toBe('fenced @改名後の名前 **raw**')

  // Pending message renders formatting and autolinks with no accepted Mentions
  props.pending = true
  await settle()
  expect(host.querySelectorAll('.ui-message-body__mention')).toHaveLength(0)
  expect(host.querySelector('pre code')?.textContent).toBe(`fenced @{member:${id}} **raw**`)
  expect(host.querySelectorAll('a')).toHaveLength(1)

  await unmount(instance); authors.close()
})

it('MessageBody preserves authored empty lines at quote and code fence boundaries (#628)', async () => {
  const props = $state({
    body: '> first\n\n> second',
  })
  const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
  const instance = mount(MessageRow, { target: host as unknown as Element, props: {
    get body() { return props.body },
  } })
  await settle()

  const bodyEl = () => host.querySelector('.ui-message-body')!
  const nonCommentChildren = () =>
    bodyEl().childNodes
      .filter(node => node.nodeType !== 8 && (node instanceof MiniElement || node.textContent !== ''))
      .map(node =>
        node instanceof MiniElement ? `${node.localName}:${node.textContent}` : `text:${JSON.stringify(node.textContent)}`,
      )

  // Blank line between two block quotes
  expect(host.querySelectorAll('blockquote').map(el => el.textContent)).toEqual(['first', 'second'])
  expect(bodyEl().textContent).toBe('first\nsecond')
  expect(nonCommentChildren()).toEqual(['blockquote:first', 'text:"\\n"', 'blockquote:second'])

  // Blank line between two fenced code blocks, and leading/trailing blank lines at fence/quote boundaries
  props.body = '\n```\na\n```\n\n```\nb\n```\n\n> after\n'
  await settle()
  expect(host.querySelectorAll('pre code').map(el => el.textContent)).toEqual(['a', 'b'])
  expect(nonCommentChildren()).toEqual([
    'text:"\\n"',
    'pre:a',
    'text:"\\n"',
    'pre:b',
    'text:"\\n"',
    'blockquote:after',
    'text:"\\n"',
  ])

  await unmount(instance)
})

it('MessageBody links follow the roving tabindex of their MessageRow across confirmed and pending rows (#628)', async () => {
  const net = fakeNetwork()
  const session = createSession({ selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...net.options('me') })
  const adapter = syncAdapter(session.sync)
  net.socket.onReady()

  const m1 = { ...record(1, 'c1'), body: '1件目 https://example.com/one' }
  const m2 = { ...record(2, 'c1'), body: '2件目 https://example.com/two' }
  net.timelines.c1 = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 2,
    has_more: false,
    items: [
      { kind: 'message', message: m1 },
      { kind: 'message', message: m2 },
    ],
  })
  net.lists[0].resolve(ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    channels: [channel('c1', 'general')],
  }))
  await settle()
  net.subscribed('c1', 2)
  // Also queue a pending send containing a link (non-roving pending rows stay in Tab order: tabindex="0")
  void adapter.channel('c1').send('送信中 https://example.com/pending')
  await settle()

  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const instance = mount(Timeline, {
    target: host as unknown as Element,
    props: {
      channel: adapter.channel('c1'),
      topics: topicsAdapter(session.topics, 'c1'),
      channelId: 'c1',
      selfId: 'me',
    },
  })
  await settle()
  flushSync()

  const focusableRows = () => queryAll(host, '.ui-message-row[data-focusable="true"]')
  const links = () => host.querySelectorAll('a.ui-message-body__link')

  expect(focusableRows()).toHaveLength(2)
  expect(links()).toHaveLength(3)
  // Latest confirmed row (m2) is the default roving row; m1 (inactive) stays -1; pending row link stays 0
  expect(focusableRows().map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0'])
  expect(links().map((a) => [a.getAttribute('href'), a.getAttribute('tabindex')])).toEqual([
    ['https://example.com/one', '-1'],
    ['https://example.com/two', '0'],
    ['https://example.com/pending', '0'],
  ])

  // ArrowUp moves roving focus to m1: m1's link becomes tabindex="0", m2's becomes "-1", pending stays "0"
  focusableRows()[1].focus()
  const up = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
  up.key = 'ArrowUp'
  focusableRows()[1].dispatchEvent(up)
  flushSync()

  expect(focusableRows().map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1'])
  expect(links().map((a) => [a.getAttribute('href'), a.getAttribute('tabindex')])).toEqual([
    ['https://example.com/one', '0'],
    ['https://example.com/two', '-1'],
    ['https://example.com/pending', '0'],
  ])

  // ArrowDown moves roving focus back to m2: m2's link becomes tabindex="0", m1's becomes "-1", pending stays "0"
  const down = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
  down.key = 'ArrowDown'
  focusableRows()[0].dispatchEvent(down)
  flushSync()

  expect(focusableRows().map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0'])
  expect(links().map((a) => [a.getAttribute('href'), a.getAttribute('tabindex')])).toEqual([
    ['https://example.com/one', '-1'],
    ['https://example.com/two', '0'],
    ['https://example.com/pending', '0'],
  ])

  // Failed pending row (e.g. after Channel access loss / targetUnavailable) also keeps its link in the Tab order
  const failedHost = dom.doc.createElement('div')
  dom.doc.body.appendChild(failedHost)
  const failedRow = mount(MessageRow, {
    target: failedHost as unknown as Element,
    props: {
      body: 'See https://example.com/help',
      pendingStatus: 'failed',
      targetUnavailable: true,
      ondiscard: () => {},
    },
  })
  flushSync()
  const failedLink = failedHost.querySelector('a.ui-message-body__link')
  expect(failedLink?.getAttribute('href')).toBe('https://example.com/help')
  expect(failedLink?.getAttribute('tabindex')).toBe('0')
  await unmount(failedRow)

  await unmount(instance)
  session.close()
})

it('Mention autocomplete uses only directory candidates with keyboard selection literal tokens IME and Escape safety', async () => {
  const id = '123e4567-e89b-12d3-a456-426614174000', second = '123e4567-e89b-12d3-a456-426614174001'
  const props = $state({ body: '', members: [{ id, name: '田中', role: 'member' as const }, { id: second, name: '鈴木', role: 'member' as const }] })
  const submit = vi.fn(async () => true), request = vi.fn()
  const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
  const instance = mount(Composer, { target: host as unknown as Element, props: {
    get value() { return props.body }, get members() { return props.members },
    oninput: body => { props.body = body }, onmentionrequest: request, onsubmit: submit,
  } })
  await settle()
  const textarea = host.querySelector('textarea')!
  function type(text: string) { textarea.value = text; textarea.selectionStart = text.length; textarea.selectionEnd = text.length; textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true })) }
  function key(key: string, composing = false, shift = false) {
    const e = new MiniDomEvent('keydown', { bubbles: true, cancelable: true }); e.key = key; e.isComposing = composing; e.shiftKey = shift
    textarea.dispatchEvent(e); return e
  }
  type('@'); await settle()
  expect(request).toHaveBeenCalledTimes(1)
  const list = host.querySelector('[role="listbox"]')!
  expect(list.getAttribute('aria-label')).toBe('メンションするメンバー')
  expect(textarea.getAttribute('aria-controls')).toBe(list.id)
  expect(host.querySelectorAll('[role="option"]').map(el => el.textContent)).toEqual(['田中', '鈴木'])
  key('ArrowDown'); await settle()
  expect(host.querySelectorAll('[role="option"]')[1].getAttribute('aria-selected')).toBe('true')
  expect(key('Enter', true).defaultPrevented).toBe(false); await settle()
  expect(props.body).toBe('@'); expect(submit).not.toHaveBeenCalled()
  key('Enter'); await settle()
  expect(props.body).toBe(`@{member:${second}} `)
  expect(textarea.selectionStart).toBe(props.body.length)
  expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(0)
  expect(submit).not.toHaveBeenCalled()
  type('@田'); await settle()
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1)
  expect(key('Escape').defaultPrevented).toBe(true); await settle()
  expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(0)
  type('@'); await settle(); props.members = []; await settle()
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)
  props.members = [{ id, name: '田中', role: 'member' }]; type('@田'); await settle()
  expect(key('Enter', false, true).defaultPrevented).toBe(false)
  expect(submit).not.toHaveBeenCalled()
  await unmount(instance)
})

it('DM lists show shared Mention badges beside Unread and DM timelines render accepted Mention highlights', async () => {
  const { default: DmList } = await import('./DmList.svelte')
  const { dm } = await import('./dm-test-helpers')
  const id = '123e4567-e89b-12d3-a456-426614174000'
  const denied = '123e4567-e89b-12d3-a456-426614174001'
  const baseline = dm('D', { mention_unread_count: 2 })
  const props = $state({ count: 2 })
  const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
  const list = mount(DmList, { target: host as unknown as Element, props: {
    rows: [{ identity: baseline, baseline, access: 1, used: 1 }], selectedId: 'D', more: false,
    unread: () => 3, mentions: () => props.count, onselect() {}, onmore() {}, onretry() {},
  } })
  await settle()
  expect(host.querySelector('.ui-badge--mention')?.getAttribute('aria-label')).toBe('メンション 2件')
  expect(host.querySelector('.ui-badge--unread')?.getAttribute('aria-label')).toBe('未読 3件')
  props.count = 0; await settle()
  expect(host.querySelectorAll('.ui-badge--mention')).toHaveLength(0)
  await unmount(list)
  const c = fakeNetwork()
  c.pages.D = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([{ ...record(1, 'D'), body: `@{member:${id}} @{member:${denied}}`, mentions: [{ member_id: id, name: '参加者' }] }]).at(-1)?.created_seq ?? 0,  messages: [{ ...record(1, 'D'), body: `@{member:${id}} @{member:${denied}}`, mentions: [{ member_id: id, name: '参加者' }] }], has_more: false })
  const sync = createSession({ selfId: id, organizationId: 'org', onEnded() {},
    channelsApi: { listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }), createChannel: async () => ({ ok: false, kind: 'network' }) },
    dmsApi: { changes: async () => ok({ dms: [], next_cursor: 'cursor', caught_up: true }), list: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', dms: [], next_cursor: null }), open: async () => ok(baseline) },
    ...c.options(id),
  })
  c.socket.onReady(); sync.sync.watch('D'); await settle(); c.subscribed('D', 1)
  const adapter = syncAdapter(sync.sync)
  const timeline = mount(Timeline, { target: host as unknown as Element, props: { channel: adapter.channel('D'), channelId: 'D', selfId: id } })
  await settle()
  expect(host.querySelectorAll('.ui-message-row--mentioned')).toHaveLength(1)
  expect(host.textContent).toContain(`@参加者 @{member:${denied}}`)
  await unmount(timeline); sync.close()
})

it('DM badges preserve unresolved controller counts until valid counts return and use baselines only without callbacks', async () => {
  const { default: DmList } = await import('./DmList.svelte')
  const { dm } = await import('./dm-test-helpers')
  const baseline = dm('D', { unread_count: 8, mention_unread_count: 2 })
  const counts = $state<{ unread: number | null; mentions: number | null }>({ unread: 3, mentions: 1 })
  const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
  const props = { rows: [{ identity: baseline, baseline, access: 1, used: 1 }], selectedId: 'D', onselect() {}, onmore() {}, onretry() {} }
  const list = mount(DmList, { target: host as unknown as Element, props: {
    ...props, unread: () => counts.unread, mentions: () => counts.mentions,
  } })
  const badge = (kind: string) => host.querySelector(`.ui-badge--${kind}`)?.getAttribute('aria-label')
  await settle()
  expect(badge('unread')).toBe('未読 3件'); expect(badge('mention')).toBe('メンションあり')
  expect(host.textContent).not.toContain('未読を確認中')
  counts.mentions = null; await settle()
  expect(badge('mention')).toBeUndefined(); expect(badge('unread')).toBe('未読 3件')
  expect(host.textContent).toContain('未読を確認中')
  counts.unread = null; counts.mentions = 2; await settle()
  expect(badge('unread')).toBeUndefined(); expect(badge('mention')).toBe('メンション 2件')
  expect(host.textContent).toContain('未読を確認中')
  counts.mentions = null; await settle()
  expect(badge('unread')).toBeUndefined(); expect(badge('mention')).toBeUndefined()
  counts.unread = 5; counts.mentions = 2; await settle()
  expect(badge('unread')).toBe('未読 5件'); expect(badge('mention')).toBe('メンション 2件')
  expect(host.textContent).not.toContain('未読を確認中')
  counts.unread = 0; counts.mentions = 0; await settle()
  expect(badge('unread')).toBeUndefined(); expect(badge('mention')).toBeUndefined()
  expect(host.textContent).not.toContain('未読を確認中')
  await unmount(list)
  const fallback = mount(DmList, { target: host as unknown as Element, props })
  await settle()
  expect(badge('unread')).toBe('未読 8件'); expect(badge('mention')).toBe('メンション 2件')
  expect(host.textContent).not.toContain('未読を確認中')
  await unmount(fallback)
  const unknown = mount(DmList, { target: host as unknown as Element, props: {
    ...props, rows: [{ identity: baseline, access: 1, used: 1 }],
  } })
  await settle()
  expect(badge('unread')).toBeUndefined(); expect(badge('mention')).toBeUndefined()
  expect(host.textContent).toContain('未読を確認中')
  await unmount(unknown)
})

it('DM access loss hides both retained baseline badges until a renewed controller baseline arrives', async () => {
  vi.useFakeTimers()
  const { default: DmList } = await import('./DmList.svelte')
  const { dm } = await import('./dm-test-helpers')
  const { dmsAdapter } = await import('./dms.svelte')
  let baseline = dm('D', { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 1, read_seq: 0, unread_count: 1, main_unread_count: 1, mention_unread_count: 1 })
  const net = fakeNetwork()
  net.pages.D = ok({ history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: ([{ ...record(1, 'D'), sender: 'peer', mentions: [{ member_id: 'me', name: 'Me' }] }]).at(-1)?.created_seq ?? 0,  messages: [{ ...record(1, 'D'), sender: 'peer', mentions: [{ member_id: 'me', name: 'Me' }] }], has_more: false })
  const options = net.options()
  const session = createSession({ ...options, selfId: 'me', organizationId: 'org', onEnded() {},
    channelsApi: { listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }), createChannel: async () => ({ ok: false, kind: 'network' }) },
    unreadApi: { ...options.unreadApi!, listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }) },
    dmsApi: {
      changes: async ({ lane }) => ok({ dms: [baseline], next_cursor: lane, caught_up: true }),
      list: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', dms: [baseline], next_cursor: null }), open: async () => ok(baseline),
    },
  })
  net.socket.onReady(); net.event({ type: 'activity_ready' }); await vi.advanceTimersByTimeAsync(1000)
  session.dms.select('D'); await settle(); net.subscribed('D', 1); await settle()
  await vi.advanceTimersByTimeAsync(1000)
  const dms = dmsAdapter(session.dms), unread = unreadAdapter(session.unread, 'D')
  const host = dom.doc.createElement('div'); dom.doc.body.appendChild(host)
  const list = mount(DmList, { target: host as unknown as Element, props: {
    get rows() { return dms.state.rows }, selectedId: 'D',
    unread: () => unread.state.unreadCount, mentions: () => unread.state.mentionUnreadCount,
    onselect() {}, onmore() {}, onretry() {},
  } })
  const badge = (kind: string) => host.querySelector(`.ui-badge--${kind}`)?.getAttribute('aria-label')
  try {
    await settle()
    expect(badge('unread')).toBe('未読 1件'); expect(badge('mention')).toBe('メンションあり')
    net.event({ type: 'channel_access_lost', channel_id: 'D' }); await settle()
    expect(session.unread.get('D').unreadCount).toBeNull()
    expect(session.unread.get('D').mentionUnreadCount).toBeNull()
    expect(session.dms.get().rows[0]?.baseline?.unread_count).toBe(1)
    expect(session.dms.get().rows[0]?.baseline?.mention_unread_count).toBe(1)
    expect(badge('unread')).toBeUndefined(); expect(badge('mention')).toBeUndefined()
    expect(host.textContent).toContain('未読を確認中')
    baseline = dm('D', { history_generation: '00000000-0000-4000-8000-000000000515', as_of_seq: 3, read_seq: 1, unread_count: 2, main_unread_count: 2, mention_unread_count: 2 })
    net.event({ type: 'channel_access_gained', channel_id: 'D' }); await vi.advanceTimersByTimeAsync(16_000)
    await settle()
    expect(session.unread.get('D').unreadCount).toBeNull()
    expect(session.unread.get('D').mentionUnreadCount).toBeNull()
    expect(badge('unread')).toBeUndefined(); expect(badge('mention')).toBeUndefined()
    session.dms.select('D'); await settle(); net.subscribed('D', 3)
    session.dms.refresh(); await vi.advanceTimersByTimeAsync(16_000)
    await settle()
    expect(badge('unread')).toBe('未読 2件'); expect(badge('mention')).toBe('メンション 2件')
    expect(host.textContent).not.toContain('未読を確認中')
  } finally { await unmount(list); session.close() }
})

