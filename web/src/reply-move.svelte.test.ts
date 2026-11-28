import { flushSync, mount, tick, unmount } from 'svelte'
import { expect, it, vi } from 'vitest'
import * as api from './api'
import type { MoveChainResponse, ReplyChainPage, Result, TopicSummary } from './api'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import { createDraftStore } from './drafts'
import type { MoveChainApi } from './move-chain'
import { createNavigation, type NavigationBrowser } from './navigation'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { repliesAdapter } from './replies.svelte'
import ReplyPanel from './ReplyPanel.svelte'
import { replyClient, root } from './reply-test-helpers'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter, type TopicsAdapter } from './topics.svelte'
import Workspace from './Workspace.svelte'
import { deferred, replyPage, summary } from './topic-test-helpers'
import { buttonsByText, installMiniDom, MiniDomEvent, MiniElement, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

it('ReplyPanel トピックに移動 disables submit until chainVersion is ready, moves to existing or new Topic, retries unknown outcomes, and renders every Japanese failure message', async () => {
  const net = fakeNetwork()
  const moveChainApi = vi.fn()
  const rawSession = createSession({
    selfId: 'me',
    organizationId: 'org-1',
    onEnded: () => {},
    moveChainApi,
    ...net.options('me'),
  })
  net.socket.onReady()
  const rootMsg = { ...record(1, 'A'), id: 'id1', body: 'ルート' }
  const topicT = summary('topic-existing', 5, 2)
  net.timelines.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 5,
    has_more: false,
    items: [{ kind: 'message', message: rootMsg }, { kind: 'topic', topic: topicT }],
  })
  net.topicLists.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 5,
    topics: [topicT],
    has_more: false,
  })
  // First open with chain_version omitted (0) so chainVersion is undefined
  net.replyChains[`A:${rootMsg.id}`] = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 1,
    root_id: rootMsg.id,
    chain_version: 0,
    messages: [rootMsg],
    has_more: false,
  })
  net.lists[0].resolve(ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    channels: [channel('A', 'general')],
  }))
  await settle()
  net.subscribed('A', 5)
  await settle()

  await rawSession.topics.loadList('A')
  await rawSession.replies.open('A', rootMsg)
  expect(rawSession.replies.get('A').chainVersion).toBeUndefined()

  const moveChain = vi.fn()
  const announced: string[] = []
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const channelAdapter = syncAdapter(rawSession.sync).channel('A')
  const replies = repliesAdapter(rawSession.replies, 'A', rawSession.replyCounts, moveChain)
  const topics = topicsAdapter(rawSession.topics, 'A')

  const instance = mount(ReplyPanel, {
    target: host as unknown as Element,
    props: {
      channel: channelAdapter,
      replies,
      topics,
      moveChain,
      onannounce: (m: string) => announced.push(m),
      channelId: 'A',
      anchorMessageId: rootMsg.id,
      resolvedAnchor: rootMsg,
    },
  })

  try {
    await settle()
    flushSync()

    // Open Move dialog while chainVersion is not ready: submit button is disabled
    const openBtn = buttonsByText(host, 'トピックに移動')[0]
    expect(openBtn).toBeDefined()
    openBtn.click()
    flushSync()
    await settle()
    flushSync()

    const dialog = host.querySelector('dialog:modal')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('返信のつながりを読み込んでいます…')
    const submitBtn = () => buttonsByText(dialog, 'トピックに移動')[0]
    expect(submitBtn().disabled).toBe(true)

    // Refresh chain so chainVersion becomes ready
    net.replyChains[`A:${rootMsg.id}`] = ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 5,
      root_id: rootMsg.id,
      chain_version: 5,
      messages: [rootMsg],
      has_more: false,
    })
    await rawSession.replies.loadOlder('A')
    await settle()
    flushSync()

    expect(rawSession.replies.get('A').chainVersion).toBe(5)
    expect(dialog.textContent).not.toContain('返信のつながりを読み込んでいます…')
    expect(submitBtn().disabled).toBe(false)

    // 1. Existing Topic destination -> check each failure outcome and Japanese message
    const failureCases: Array<[ Awaited<ReturnType<typeof replies.move>>, string ]> = [
      [{ kind: 'conflict', error: 'version_conflict', refreshed: true }, '返信のつながりが更新されました。最新の状態を読み込みましたので、もう一度お試しください。'],
      [{ kind: 'too_large' }, 'メッセージが1,000件を超える返信のつながりは移動できません。'],
      [{ kind: 'denied' }, 'この返信のつながりをトピックに移動する権限がありません。'],
      [{ kind: 'not_found' }, '移動対象の返信のつながりまたは移動先のトピックが見つかりません。'],
      [{ kind: 'snapshot_expired' }, '表示していた情報が古くなりました。もう一度お試しください。'],
      [{ kind: 'history_generation_changed' }, '履歴が更新されました。読み込み直してから、もう一度お試しください。'],
      [{ kind: 'baseline_unavailable' }, '返信のつながりを読み込んでから、もう一度お試しください。'],
      [{ kind: 'superseded' }, '移動対象が変更されたため、移動を中断しました。もう一度お試しください。'],
      [{ kind: 'failed', status: 400, error: 'invalid_input' }, 'トピックに移動できませんでした。入力内容を確認して、もう一度お試しください。'],
    ]

    for (const [outcome, expectedMessage] of failureCases) {
      moveChain.mockResolvedValueOnce(outcome)
      submitBtn().click()
      await settle()
      flushSync()
      expect(moveChain).toHaveBeenLastCalledWith('A', rootMsg.id, { topicId: 'topic-existing' })
      const alertEl = dialog.querySelector('[role="alert"]')
      expect(alertEl?.textContent).toBe(expectedMessage)
      expect(buttonsByText(dialog, '再試行')).toHaveLength(0)
    }

    // 2. Unknown outcome offers 再試行 that calls retry(), and moved closes dialog and announces
    const receipt = {
      history_generation: '00000000-0000-4000-8000-000000000515',
      move_seq: 6,
      operation_id: 'op-1',
      root_id: rootMsg.id,
      destination_topic_id: 'topic-existing',
      chain_version: 6,
      operation_version: 6,
      topic_id: 'topic-existing',
    }
    const retryFn = vi.fn().mockResolvedValueOnce({ kind: 'moved' as const, receipt })
    moveChain.mockResolvedValueOnce({ kind: 'unknown' as const, retry: retryFn })
    submitBtn().click()
    await settle()
    flushSync()

    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      '移動を確認できませんでした。通信状況を確認して、もう一度お試しください。',
    )
    const retryBtn = buttonsByText(dialog, '再試行')[0]
    expect(retryBtn).toBeDefined()
    retryBtn.click()
    await settle()
    flushSync()

    expect(retryFn).toHaveBeenCalledTimes(1)
    expect(host.querySelector('dialog:modal')).toBeNull()
    expect(host.textContent).toContain('トピックに移動しました。')
    expect(announced).toEqual(['トピックに移動しました。'])

    // 3. Reopen dialog, switch to new Topic name, validate Topic name and submit { topicName }
    openBtn.click()
    flushSync()
    await settle()
    flushSync()

    const dialog2 = host.querySelector('dialog:modal')!
    const newRadio = queryAll(dialog2, 'input[type="radio"]').find((r) => r.getAttribute('value') === 'new')!
    newRadio.checked = true
    newRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    flushSync()

    const nameInput = dialog2.querySelector('input[name="move_topic_name"]')!
    expect(buttonsByText(dialog2, 'トピックに移動')[0].disabled).toBe(true)

    // Invalid surrounding whitespace shows topicNameError without calling moveChain
    const callsBefore = moveChain.mock.calls.length
    nameInput.value = ' 前後空白 '
    nameInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    buttonsByText(dialog2, 'トピックに移動')[0].click()
    await settle()
    flushSync()
    expect(moveChain).toHaveBeenCalledTimes(callsBefore)
    expect(dialog2.querySelector('[role="alert"]')?.textContent).toBe(
      'トピック名の前後に空白を入れず、1〜60文字にしてください。',
    )

    // Valid new Topic name calls moveChain with { topicName }
    nameInput.value = '新規移動トピック'
    nameInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    moveChain.mockResolvedValueOnce({ kind: 'moved' as const, receipt })
    buttonsByText(dialog2, 'トピックに移動')[0].click()
    await settle()
    flushSync()

    expect(moveChain).toHaveBeenLastCalledWith('A', rootMsg.id, { topicName: '新規移動トピック' })
    expect(host.querySelector('dialog:modal')).toBeNull()
  } finally {
    await unmount(instance)
    rawSession.close()
  }
})

it('ReplyPanel reuses the saved Move POST on form resubmit after a timeout', async () => {
  vi.useFakeTimers()
  const firstPost = deferred<Result<MoveChainResponse>>()
  const moveChainApi = vi.fn().mockReturnValueOnce(firstPost.promise)
  const net = fakeNetwork()
  const baseOptions = net.options('me')
  const delayedChainReads: Array<Promise<Result<ReplyChainPage>>> = []
  let opSeq = 0
  const rawSession = createSession({
    selfId: 'me',
    organizationId: 'org-1',
    onEnded: () => {},
    moveChainApi,
    ...baseOptions,
    repliesApi: {
      listReplyChain: (channel, anchor, query) =>
        delayedChainReads.shift() ?? baseOptions.repliesApi!.listReplyChain(channel, anchor, query),
    },
    sync: {
      ...baseOptions.sync,
      newId: () => `op-${++opSeq}`,
      requestTimeoutMs: 20,
    },
  })
  net.socket.onReady()
  const rootMsg = { ...record(1, 'A'), id: 'id1', body: 'ルート', version: 10 }
  net.timelines.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 10,
    has_more: false,
    items: [{ kind: 'message', message: rootMsg }],
  })
  net.topicLists.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 10,
    topics: [],
    has_more: false,
  })
  net.replyChains[`A:${rootMsg.id}`] = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 10,
    root_id: rootMsg.id,
    chain_version: 10,
    messages: [rootMsg],
    has_more: false,
  })
  net.lists[0].resolve(ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    channels: [channel('A', 'general')],
  }))
  await settle()
  net.subscribed('A', 10)
  await settle()

  await rawSession.topics.loadList('A')
  await rawSession.replies.open('A', rootMsg)

  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const channelAdapter = syncAdapter(rawSession.sync).channel('A')
  const replies = repliesAdapter(rawSession.replies, 'A', rawSession.replyCounts, rawSession.moveChain)
  const topics = topicsAdapter(rawSession.topics, 'A')

  const receipt: MoveChainResponse = {
    history_generation: '00000000-0000-4000-8000-000000000515',
    move_seq: 26,
    operation_id: 'op-1',
    root_id: rootMsg.id,
    destination_topic_id: 'topic-release',
    chain_version: 26,
    operation_version: 26,
    topic_id: 'topic-release',
  }

  const instance = mount(ReplyPanel, {
    target: host as unknown as Element,
    props: {
      channel: channelAdapter,
      replies,
      topics,
      moveChain: rawSession.moveChain,
      channelId: 'A',
      anchorMessageId: rootMsg.id,
      resolvedAnchor: rootMsg,
    },
  })

  try {
    await settle()
    flushSync()

    buttonsByText(host, 'トピックに移動')[0].click()
    flushSync()
    await settle()
    flushSync()

    const dialog = host.querySelector('dialog:modal')!
    const nameInput = dialog.querySelector('input[name="move_topic_name"]')!
    nameInput.value = 'リリース'
    nameInput.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    // First submit times out -> unknown outcome
    buttonsByText(dialog, 'トピックに移動')[0].click()
    await vi.advanceTimersByTimeAsync(25)
    await settle()
    flushSync()

    expect(moveChainApi).toHaveBeenCalledTimes(1)
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      '移動を確認できませんでした。通信状況を確認して、もう一度お試しください。',
    )

    // Even if the chain is temporarily invalidated (chainVersion undefined), submit stays enabled to reuse the saved POST
    const delayedRead = deferred<Result<ReplyChainPage>>()
    delayedChainReads.push(delayedRead.promise)
    net.event({
      type: 'message',
      kind: 'move',
      seq: 20,
      version: 20,
      channel_id: 'A',
      history_generation: '00000000-0000-4000-8000-000000000515',
      operation_id: '00000000-0000-4000-8000-000000000777',
      root_id: rootMsg.id,
      source_topic_id: null,
      destination_topic_id: 'topic-other',
    })
    await settle()
    flushSync()
    expect(rawSession.replies.get('A').chainVersion).toBeUndefined()
    expect(buttonsByText(dialog, 'トピックに移動')[0].disabled).toBe(false)

    // Resubmit form (button or Enter) reuses the saved POST with identical operation_id and expected_version
    moveChainApi.mockResolvedValueOnce(ok(receipt))
    buttonsByText(dialog, 'トピックに移動')[0].click()
    await settle()
    flushSync()

    expect(moveChainApi).toHaveBeenCalledTimes(2)
    expect(moveChainApi.mock.calls[0][2]).toEqual({
      history_generation: '00000000-0000-4000-8000-000000000515',
      operation_id: 'op-1',
      expected_version: 10,
      topic_name: 'リリース',
    })
    expect(moveChainApi.mock.calls[1][2]).toEqual(moveChainApi.mock.calls[0][2])
    expect(host.querySelector('dialog:modal')).toBeNull()
  } finally {
    await unmount(instance)
    rawSession.close()
  }
})

it('ReplyPanel hides retained rows and the source Topic label and shows loading while moveInvalidated is set', async () => {
  const net = fakeNetwork()
  const baseOptions = net.options('me')
  const delayedChainReads: Array<Promise<Result<ReplyChainPage>>> = []
  const rawSession = createSession({
    selfId: 'me',
    organizationId: 'org-1',
    onEnded: () => {},
    ...baseOptions,
    repliesApi: {
      listReplyChain: (channel, anchor, query) =>
        delayedChainReads.shift() ?? baseOptions.repliesApi!.listReplyChain(channel, anchor, query),
    },
  })
  net.socket.onReady()
  const topicA = summary('topic-a', 10, 2)
  const topicB = summary('topic-b', 11, 2)
  const rootMsg = { ...record(1, 'A'), id: 'id1', topic_id: 'topic-a', body: 'トピックAのルート', version: 10 }
  const replyMsg = { ...record(2, 'A'), id: 'id2', reply_to: 'id1', reply_root_id: 'id1', topic_id: 'topic-a', body: 'トピックAの返信', version: 10 }
  net.timelines.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 10,
    has_more: false,
    items: [{ kind: 'topic', topic: topicA }],
  })
  net.topicLists.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 10,
    topics: [topicA, topicB],
    has_more: false,
  })
  net.replyChains[`A:${replyMsg.id}`] = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 10,
    root_id: rootMsg.id,
    chain_version: 10,
    messages: [rootMsg, replyMsg],
    has_more: false,
  })
  net.lists[0].resolve(ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    channels: [channel('A', 'general')],
  }))
  await settle()
  net.subscribed('A', 10)
  await settle()

  await rawSession.topics.loadList('A')
  await rawSession.replies.open('A', replyMsg)

  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const channelAdapter = syncAdapter(rawSession.sync).channel('A')
  const replies = repliesAdapter(rawSession.replies, 'A', rawSession.replyCounts, rawSession.moveChain)
  const topics = topicsAdapter(rawSession.topics, 'A')

  const instance = mount(ReplyPanel, {
    target: host as unknown as Element,
    props: {
      channel: channelAdapter,
      replies,
      topics,
      channelId: 'A',
      anchorMessageId: replyMsg.id,
      resolvedAnchor: replyMsg,
    },
  })

  try {
    await settle()
    flushSync()

    expect(host.textContent).toContain('トピック: Topic topic-a')
    expect(host.textContent).toContain('トピックAのルート')
    expect(host.textContent).toContain('トピックAの返信')

    // Delay the covering chain read on Move
    const delayedChain = deferred<Result<ReplyChainPage>>()
    delayedChainReads.push(delayedChain.promise)
    net.topicLists.A = ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 11,
      topics: [topicA, topicB],
      has_more: false,
    })
    net.timelines.A = ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 11,
      has_more: false,
      items: [{ kind: 'topic', topic: topicB }],
    })
    net.event({
      type: 'message',
      kind: 'move',
      seq: 11,
      version: 11,
      channel_id: 'A',
      history_generation: '00000000-0000-4000-8000-000000000515',
      operation_id: '00000000-0000-4000-8000-000000000999',
      root_id: rootMsg.id,
      source_topic_id: 'topic-a',
      destination_topic_id: 'topic-b',
    })
    await settle()
    flushSync()

    expect(replies.state.moveInvalidated).toBe(true)
    expect(host.textContent).not.toContain('トピック: Topic topic-a')
    expect(host.textContent).not.toContain('トピックAのルート')
    expect(host.textContent).not.toContain('トピックAの返信')
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()

    // Resolve covering chain read -> renders Topic B and moved rows
    const movedRoot = { ...rootMsg, topic_id: 'topic-b', version: 11 }
    const movedReply = { ...replyMsg, topic_id: 'topic-b', version: 11 }
    delayedChain.resolve(ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 11,
      root_id: rootMsg.id,
      chain_version: 11,
      messages: [movedRoot, movedReply],
      has_more: false,
    }))
    await settle()
    flushSync()

    expect(replies.state.moveInvalidated).toBe(false)
    expect(host.textContent).toContain('トピック: Topic topic-b')
    expect(host.textContent).toContain('トピックAのルート')
    expect(host.textContent).toContain('トピックAの返信')
  } finally {
    await unmount(instance)
    rawSession.close()
  }
})

it('ReplyPanel migrates the Composer draft when an open chain with a descendant anchor moves from Topic A to Topic B', async () => {
  const net = fakeNetwork()
  const rawSession = createSession({
    selfId: 'me',
    organizationId: 'org-1',
    onEnded: () => {},
    ...net.options('me'),
  })
  net.socket.onReady()
  const topicA = summary('topic-a', 10, 2)
  const topicB = summary('topic-b', 11, 2)
  const rootMsg = { ...record(1, 'A'), id: 'id1', topic_id: 'topic-a', body: 'ルート', version: 10 }
  const descAnchor = { ...record(2, 'A'), id: 'id2', reply_to: 'id1', reply_root_id: 'id1', topic_id: 'topic-a', body: '子孫アンカー', version: 10 }
  net.timelines.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 10,
    has_more: false,
    items: [{ kind: 'topic', topic: topicA }],
  })
  net.topicLists.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 10,
    topics: [topicA, topicB],
    has_more: false,
  })
  net.replyChains[`A:${descAnchor.id}`] = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 10,
    root_id: rootMsg.id,
    chain_version: 10,
    messages: [rootMsg, descAnchor],
    has_more: false,
  })
  net.lists[0].resolve(ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    channels: [channel('A', 'general')],
  }))
  await settle()
  net.subscribed('A', 10)
  await settle()

  await rawSession.topics.loadList('A')
  await rawSession.replies.open('A', descAnchor)

  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const channelAdapter = syncAdapter(rawSession.sync).channel('A')
  const replies = repliesAdapter(rawSession.replies, 'A', rawSession.replyCounts, rawSession.moveChain)
  const topics = topicsAdapter(rawSession.topics, 'A')

  const instance = mount(ReplyPanel, {
    target: host as unknown as Element,
    props: {
      channel: channelAdapter,
      replies,
      topics,
      channelId: 'A',
      anchorMessageId: descAnchor.id,
      resolvedAnchor: descAnchor,
    },
  })

  try {
    await settle()
    flushSync()

    const textarea = host.querySelector('textarea')!
    textarea.value = '移動前の下書きテキスト'
    textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()
    expect(channelAdapter.reply(rootMsg.id, 'topic-a').composer.draft).toBe('移動前の下書きテキスト')

    // Move the chain from topic-a to topic-b
    const movedRoot = { ...rootMsg, topic_id: 'topic-b', version: 11 }
    const movedDesc = { ...descAnchor, topic_id: 'topic-b', version: 11 }
    net.replyChains[`A:${descAnchor.id}`] = ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 11,
      root_id: rootMsg.id,
      chain_version: 11,
      messages: [movedRoot, movedDesc],
      has_more: false,
    })
    net.event({
      type: 'message',
      kind: 'move',
      seq: 11,
      version: 11,
      channel_id: 'A',
      history_generation: '00000000-0000-4000-8000-000000000515',
      operation_id: '00000000-0000-4000-8000-000000000998',
      root_id: rootMsg.id,
      source_topic_id: 'topic-a',
      destination_topic_id: 'topic-b',
    })
    await settle()
    flushSync()

    expect(replies.state.topicId).toBe('topic-b')
    expect(host.querySelector('textarea')?.value).toBe('移動前の下書きテキスト')
    expect(channelAdapter.reply(rootMsg.id, 'topic-b').composer.draft).toBe('移動前の下書きテキスト')
    expect(channelAdapter.reply(rootMsg.id, 'topic-a').composer.draft).toBe('')
  } finally {
    await unmount(instance)
    rawSession.close()
  }
})

it('ReplyPanel renders a refresh failure message and keyboard-reachable 再読み込み action on version_conflict with failed chain GET', async () => {
  const net = fakeNetwork()
  const moveChainApi = vi.fn().mockResolvedValueOnce({
    ok: false,
    kind: 'http',
    status: 409,
    error: 'version_conflict',
  })
  const rawSession = createSession({
    selfId: 'me',
    organizationId: 'org-1',
    onEnded: () => {},
    moveChainApi,
    ...net.options('me'),
  })
  net.socket.onReady()
  const topicT = summary('topic-existing', 5, 2)
  const rootMsg = { ...record(1, 'A'), id: 'id1', body: 'ルート', version: 5 }
  net.timelines.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 5,
    has_more: false,
    items: [{ kind: 'message', message: rootMsg }, { kind: 'topic', topic: topicT }],
  })
  net.topicLists.A = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 5,
    topics: [topicT],
    has_more: false,
  })
  net.replyChains[`A:${rootMsg.id}`] = ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    as_of_seq: 5,
    root_id: rootMsg.id,
    chain_version: 5,
    messages: [rootMsg],
    has_more: false,
  })
  net.lists[0].resolve(ok({
    history_generation: '00000000-0000-4000-8000-000000000515',
    channels: [channel('A', 'general')],
  }))
  await settle()
  net.subscribed('A', 5)
  await settle()

  await rawSession.topics.loadList('A')
  await rawSession.replies.open('A', rootMsg)

  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const channelAdapter = syncAdapter(rawSession.sync).channel('A')
  const replies = repliesAdapter(rawSession.replies, 'A', rawSession.replyCounts, rawSession.moveChain)
  const topics = topicsAdapter(rawSession.topics, 'A')
  const loadMoreSpy = vi.spyOn(replies, 'loadMore')

  const instance = mount(ReplyPanel, {
    target: host as unknown as Element,
    props: {
      channel: channelAdapter,
      replies,
      topics,
      channelId: 'A',
      anchorMessageId: rootMsg.id,
      resolvedAnchor: rootMsg,
    },
  })

  try {
    await settle()
    flushSync()

    buttonsByText(host, 'トピックに移動')[0].click()
    flushSync()
    await settle()
    flushSync()

    const dialog = host.querySelector('dialog:modal')!
    // Make the conflict refresh GET fail
    net.replyChains[`A:${rootMsg.id}`] = { ok: false, kind: 'network' }
    buttonsByText(dialog, 'トピックに移動')[0].click()
    await settle()
    flushSync()

    const alertText = dialog.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alertText).not.toContain('最新の状態を読み込みました')
    expect(alertText).toContain('最新の状態を読み込めませんでした')

    const reloadBtn = buttonsByText(dialog, '再読み込み')[0]
    expect(reloadBtn).toBeDefined()
    expect(reloadBtn.tabIndex).toBe(0)

    // Clicking 再読み込み calls replies.loadMore() and restores the baseline
    net.replyChains[`A:${rootMsg.id}`] = ok({
      history_generation: '00000000-0000-4000-8000-000000000515',
      as_of_seq: 12,
      root_id: rootMsg.id,
      chain_version: 12,
      messages: [rootMsg],
      has_more: false,
    })
    reloadBtn.click()
    await settle()
    flushSync()

    expect(loadMoreSpy).toHaveBeenCalledTimes(1)
    expect(replies.state.chainVersion).toBe(12)
    expect(buttonsByText(dialog, 'トピックに移動')[0].disabled).toBe(false)
  } finally {
    await unmount(instance)
    rawSession.close()
  }
})

async function mountReplyPanelForMove({ descendant = false, sourceTopic = null, dm = false,
  initialChainError = false, initialListError = false, topicListPage }: {
  descendant?: boolean
  sourceTopic?: string | null
  dm?: boolean
  initialChainError?: boolean
  initialListError?: boolean
  topicListPage?: api.TopicPage
} = {}) {
  const historyGeneration = '00000000-0000-4000-8000-000000000515'
  const net = fakeNetwork()
  const base = net.options('me')
  const listTopics = vi.fn(base.topicsApi!.listTopics)
  const listReplyChain = vi.fn(base.repliesApi!.listReplyChain)
  const moveChainApi = vi.fn<MoveChainApi>()
  const drafts = createDraftStore()
  const session = createSession({
    selfId: 'me', organizationId: 'org-1', onEnded: () => {}, ...base, moveChainApi,
    topicsApi: { ...base.topicsApi!, listTopics },
    repliesApi: { listReplyChain },
    sync: { ...base.sync, drafts: drafts.scope(), requestTimeoutMs: 20 },
  })
  const topicB = summary('topic-b', 9, 1)
  const topicC = summary('topic-c', 8, 1)
  const rootMessage = { ...record(1, 'A'), topic_id: sourceTopic, version: 10 }
  const anchor = descendant
    ? { ...record(2, 'A'), reply_to: rootMessage.id, reply_root_id: rootMessage.id, topic_id: sourceTopic, version: 10 }
    : rootMessage
  const messages = descendant ? [rootMessage, anchor] : [rootMessage]
  const chainPage = (chainVersion: number, topicId = sourceTopic) => ok({
    history_generation: historyGeneration, as_of_seq: chainVersion, root_id: rootMessage.id, chain_version: chainVersion,
    messages: messages.map(message => ({ ...message, topic_id: topicId, version: chainVersion })), has_more: false,
  })
  net.timelines.A = ok({
    history_generation: historyGeneration, as_of_seq: topicListPage?.as_of_seq ?? 10, has_more: false,
    items: topicListPage ? [] : [{ kind: 'topic', topic: topicC }],
  })
  net.topicLists.A = ok(topicListPage ?? {
    history_generation: historyGeneration, as_of_seq: 10, topics: [topicC, topicB], has_more: true,
  })
  net.replyChains[`A:${anchor.id}`] = chainPage(10)
  net.socket.onReady()
  net.lists[0].resolve(ok({ history_generation: historyGeneration, channels: [channel('A', 'general')] }))
  await settle()
  net.subscribed('A', 10)
  await settle()
  if (initialListError) listTopics.mockResolvedValueOnce({ ok: false, kind: 'network' })
  if (!dm) await session.topics.loadList('A')
  if (initialChainError) listReplyChain.mockResolvedValueOnce({ ok: false, kind: 'network' })
  await session.replies.open('A', anchor)

  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const channelAdapter = syncAdapter(session.sync).channel('A')
  const replies = repliesAdapter(session.replies, 'A', session.replyCounts, session.moveChain)
  const topics = topicsAdapter(session.topics, 'A')
  const mountPanel = (resolvedAnchor = anchor) => mount(ReplyPanel, {
    target: host as unknown as Element,
    props: { channel: channelAdapter, replies, topics: dm ? null : topics, channelId: 'A', anchorMessageId: resolvedAnchor.id, resolvedAnchor },
  })
  let instance: ReturnType<typeof mountPanel> | null = mountPanel()
  await settle()

  function moveEvent(rootId: string, source: string, destination: string) {
    net.event({
      type: 'message', kind: 'move', channel_id: 'A', seq: 11, version: 11,
      history_generation: historyGeneration, operation_id: '00000000-0000-4000-8000-000000000999',
      root_id: rootId, source_topic_id: source, destination_topic_id: destination,
    })
  }
  return {
    net, host, channelAdapter, replies, anchor, rootMessage, topicB, topicC, historyGeneration, moveChainApi, drafts,
    chainPage, listReplyChain, moveEvent, listTopics, topics,
    async dismiss() {
      if (instance) await unmount(instance)
      instance = null
      replies.dismiss()
    },
    async reopen(resolvedAnchor: typeof anchor) {
      await replies.open(resolvedAnchor)
      instance = mountPanel(resolvedAnchor)
      await settle()
    },
    async close() {
      if (instance) await unmount(instance)
      session.close()
      host.remove()
    },
  }
}

it('ReplyPanel keeps text typed during Move invalidation in the descendant chain Composer', async () => {
  const c = await mountReplyPanelForMove({ descendant: true, sourceTopic: 'topic-a' })
  try {
    const coveringRead = deferred<Result<ReplyChainPage>>()
    c.listReplyChain.mockReturnValueOnce(coveringRead.promise)
    c.moveEvent(c.rootMessage.id, 'topic-a', 'topic-b')
    await settle()
    expect(c.replies.state.moveInvalidated).toBe(true)

    const textarea = c.host.querySelector('textarea')!
    const text = '移動の読み込み中に入力した下書き'
    textarea.value = text
    textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    await settle()
    expect(textarea.value).toBe(text)

    coveringRead.resolve(c.chainPage(11, 'topic-b'))
    await settle()
    expect(c.replies.state).toMatchObject({ moveInvalidated: false, topicId: 'topic-b' })
    expect(c.host.querySelector('textarea')?.value).toBe(text)
    expect(c.channelAdapter.reply(c.rootMessage.id, 'topic-b').composer.draft).toBe(text)
    expect(c.channelAdapter.reply(c.rootMessage.id, 'topic-a').composer.draft).toBe('')
    expect(c.channelAdapter.reply(c.rootMessage.id, null).composer.draft).toBe('')
    expect(c.channelAdapter.reply(c.anchor.id, null).composer.draft).toBe('')
  } finally {
    await c.close()
  }
})

it('ReplyPanel recovers a Reply draft after the chain moves while the panel is closed', async () => {
  const c = await mountReplyPanelForMove({ descendant: true, sourceTopic: 'topic-a' })
  try {
    const text = '移動前の返信の下書き'
    const textarea = c.host.querySelector('textarea')!
    textarea.value = text
    textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    const anotherOrganization = {
      organizationId: 'org-2', channelId: 'A', replyRootId: c.rootMessage.id, topicId: 'topic-a',
    }
    c.drafts.set(anotherOrganization, '別の組織の下書き')
    await c.dismiss()

    c.moveEvent(c.rootMessage.id, 'topic-a', 'topic-b')
    await settle()
    c.listReplyChain.mockResolvedValueOnce(c.chainPage(11, 'topic-b'))
    await c.reopen({ ...c.anchor, topic_id: 'topic-b', version: 11 })

    expect(c.host.querySelector('textarea')?.value).toBe(text)
    expect(c.channelAdapter.reply(c.rootMessage.id, 'topic-a').composer.draft).toBe('')
    expect(c.drafts.get(anotherOrganization)).toBe('別の組織の下書き')
  } finally {
    await c.close()
  }
})

it('ReplyPanel preserves the selected Topic and its Move retry while the Topic list rebuilds', async () => {
  vi.useFakeTimers()
  const c = await mountReplyPanelForMove()
  const pendingPost = deferred<Result<MoveChainResponse>>()
  const pendingList = deferred<Result<api.TopicPage>>()
  try {
    c.moveChainApi.mockReturnValueOnce(pendingPost.promise).mockResolvedValueOnce({ ok: false, kind: 'network' })
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const submit = buttonsByText(dialog, 'トピックに移動')[0]
    expect(dialog.querySelector('select')?.value).toBe('topic-b')
    submit.click()
    await settle()

    c.listTopics.mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
      .mockReturnValueOnce(pendingList.promise)
    const refresh = c.topics.loadList()
    await settle()
    expect(c.topics.state.list.loading).toBe(true)
    expect(dialog.querySelector('select')?.value).toBe('topic-b')
    expect(submit.disabled).toBe(true)

    pendingPost.resolve({ ok: false, kind: 'network' })
    await settle()
    expect(dialog.querySelector('select')?.value).toBe('topic-b')
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    pendingList.resolve(ok({
      history_generation: c.historyGeneration, as_of_seq: 11, topics: [c.topicC, c.topicB], has_more: false,
    }))
    await refresh
    await settle()
    expect(dialog.querySelector('select')?.value).toBe('topic-b')
    buttonsByText(dialog, '再試行')[0].click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(2)
    expect(c.moveChainApi.mock.calls[1]).toEqual(c.moveChainApi.mock.calls[0])
  } finally {
    await c.close()
  }
})

it('ReplyPanel omits the Move action when the Channel has no Topic support', async () => {
  const c = await mountReplyPanelForMove({ dm: true })
  try {
    expect(c.host.querySelector('textarea')).not.toBeNull()
    expect(buttonsByText(c.host, 'トピックに移動')).toHaveLength(0)
  } finally {
    await c.close()
  }
})

it.each(['initial chain read', 'conflict refresh followed by a destination edit'])(
  'ReplyPanel offers chain recovery in the Move dialog after a failed %s',
  async failure => {
    const initialChainError = failure === 'initial chain read'
    const c = await mountReplyPanelForMove({ initialChainError })
    try {
      buttonsByText(c.host, 'トピックに移動')[0].click()
      await settle()
      const dialog = c.host.querySelector('dialog:modal')!
      const submit = buttonsByText(dialog, 'トピックに移動')[0]
      if (!initialChainError) {
        c.moveChainApi.mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'version_conflict' })
        c.listReplyChain.mockResolvedValueOnce({ ok: false, kind: 'network' })
        submit.click()
        await settle()
        const select = dialog.querySelector('select')!
        select.value = 'topic-c'
        select.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
        await settle()
      }
      expect(c.replies.state).toMatchObject({ loading: false, error: true, chainVersion: undefined })
      expect(submit.disabled).toBe(true)
      expect(dialog.textContent).not.toContain('返信のつながりを読み込んでいます…')
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('読み込めませんでした')
      buttonsByText(dialog, '再読み込み')[0].click()
      await settle()
      expect(submit.disabled).toBe(false)
      expect(buttonsByText(dialog, '再読み込み')).toHaveLength(0)
    } finally {
      await c.close()
    }
  },
)

it('ReplyPanel retries a failed Topic list after reopening the Move dialog', async () => {
  const c = await mountReplyPanelForMove({ initialListError: true })
  try {
    const open = buttonsByText(c.host, 'トピックに移動')[0]
    open.click()
    await settle()
    buttonsByText(c.host.querySelector('dialog:modal')!, 'キャンセル')[0].click()
    await settle()
    open.click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    expect(dialog.querySelector('[role="alert"]')?.textContent ?? '').toContain('トピックを読み込めませんでした')
    expect(c.listTopics).toHaveBeenCalledTimes(1)

    c.moveChainApi.mockResolvedValueOnce({ ok: false, kind: 'http', status: 403, error: 'move_not_allowed' })
    buttonsByText(dialog, 'トピックに移動')[0].click()
    await settle()
    expect(queryAll(dialog, '[role="alert"]')).toHaveLength(2)

    buttonsByText(dialog, '再試行')[0].click()
    await settle()
    expect(c.listTopics).toHaveBeenCalledTimes(2)
    expect(queryAll(dialog, '[role="alert"]').map(alert => alert.textContent)).toEqual([
      'この返信のつながりをトピックに移動する権限がありません。',
    ])
    expect(queryAll(dialog, 'input[type="radio"]').map(radio => radio.value)).toContain('existing')
  } finally {
    await c.close()
  }
})

it('ReplyPanel keeps a timed-out Move destination for retry after refresh removes it, and switches only on explicit selection', async () => {
  vi.useFakeTimers()
  const c = await mountReplyPanelForMove()
  try {
    const pendingPost = deferred<Result<MoveChainResponse>>()
    c.moveChainApi
      .mockReturnValueOnce(pendingPost.promise)
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const submit = buttonsByText(dialog, 'トピックに移動')[0]
    const select = dialog.querySelector('select')!
    expect(select.value).toBe('topic-b')
    submit.click()
    await vi.advanceTimersByTimeAsync(25)
    await settle()
    expect(c.moveChainApi.mock.calls[0][2].topic_id).toBe('topic-b')
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    c.net.topicLists.A = ok({
      history_generation: c.historyGeneration, as_of_seq: 11, topics: [c.topicC], has_more: false,
    })
    c.listTopics.mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
    await c.topics.loadList()
    await settle()
    const refreshedSelect = dialog.querySelector('select')!
    expect(refreshedSelect?.options.map(option => option.value)).toEqual(['topic-c', 'topic-b'])
    expect(refreshedSelect.value).toBe('topic-b')
    expect(submit.disabled).toBe(false)

    submit.click()
    await settle()
    expect(c.moveChainApi.mock.calls[1]).toEqual(c.moveChainApi.mock.calls[0])

    refreshedSelect.value = 'topic-c'
    refreshedSelect.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    submit.click()
    await settle()
    expect(c.moveChainApi.mock.calls.map(([, , body]) => body.topic_id)).toEqual(['topic-b', 'topic-b', 'topic-c'])
  } finally {
    await c.close()
  }
})

it('ReplyPanel keeps 再読み込み available after another failed chain read in the Move dialog', async () => {
  const c = await mountReplyPanelForMove()
  try {
    c.moveChainApi.mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'version_conflict' })
    c.listReplyChain.mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce(c.chainPage(12))
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const submit = buttonsByText(dialog, 'トピックに移動')[0]
    submit.click()
    await settle()

    buttonsByText(dialog, '再読み込み')[0].click()
    await settle()
    expect(submit.disabled).toBe(true)
    expect(dialog.querySelector('[role="alert"]')?.textContent ?? '').toContain('最新の状態を読み込めませんでした')
    const reload = buttonsByText(dialog, '再読み込み')[0]
    expect(reload.tabIndex).toBe(0)

    reload.click()
    await settle()
    expect(submit.disabled).toBe(false)
    expect(buttonsByText(dialog, '再読み込み')).toHaveLength(0)
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog loads a second page after 50 Topics, keeps focus, and moves to a page-2 Topic', async () => {
  const historyGeneration = '00000000-0000-4000-8000-000000000515'
  const firstPage = Array.from({ length: 50 }, (_, i) => summary(`topic-${101 + i}`, 101 + i, 1))
  const secondPage = Array.from({ length: 50 }, (_, i) => summary(`topic-${51 + i}`, 51 + i, 1))
  const c = await mountReplyPanelForMove({
    topicListPage: { history_generation: historyGeneration, as_of_seq: 150, topics: firstPage, has_more: true },
  })
  try {
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    expect(select.options).toHaveLength(50)

    const loadMore = buttonsByText(dialog, '以前のトピックを読み込む')[0]
    expect(loadMore).toBeDefined()
    expect(loadMore.disabled).toBe(false)
    expect(loadMore.getAttribute('type')).toBe('button')

    let reached = false
    for (let i = 0; i < 10; i++) {
      if (dom.doc.activeElement === loadMore) { reached = true; break }
      const tab = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
      tab.key = 'Tab'
      dialog.dispatchEvent(tab)
    }
    expect(reached).toBe(true)

    c.listTopics.mockResolvedValueOnce(ok({
      history_generation: historyGeneration, as_of_seq: 150, topics: secondPage, has_more: false,
    }))
    loadMore.click()
    await settle()

    expect(c.listTopics).toHaveBeenCalledTimes(2)
    expect(c.listTopics.mock.calls[1][1]).toMatchObject({ as_of_seq: 150, before_position: 101 })
    expect(select.options).toHaveLength(100)
    expect(select.options.some(option => option.value === 'topic-51')).toBe(true)
    expect(buttonsByText(dialog, '以前のトピックを読み込む')).toHaveLength(0)
    expect(dom.doc.activeElement).toBe(select)

    select.value = 'topic-51'
    select.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()

    c.moveChainApi.mockResolvedValueOnce(ok({
      history_generation: historyGeneration, root_id: c.rootMessage.id, topic_id: 'topic-51',
      destination_topic_id: 'topic-51', chain_version: 11, operation_id: '00000000-0000-4000-8000-000000000643',
      operation_version: 11, move_seq: 11,
    }))
    buttonsByText(dialog, 'トピックに移動')[0].click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(1)
    expect(c.moveChainApi.mock.calls[0][2].topic_id).toBe('topic-51')
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog hides load-more when hasMore is false', async () => {
  const historyGeneration = '00000000-0000-4000-8000-000000000515'
  const c = await mountReplyPanelForMove({
    topicListPage: {
      history_generation: historyGeneration, as_of_seq: 10, topics: [summary('topic-b', 9, 1)], has_more: false,
    },
  })
  try {
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    expect(buttonsByText(dialog, '以前のトピックを読み込む')).toHaveLength(0)
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog shows Skeleton/aria-busy while loading, keeps select usable, retries errors, and restores focus', async () => {
  const c = await mountReplyPanelForMove()
  try {
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    const loadMore = buttonsByText(dialog, '以前のトピックを読み込む')[0]

    const pendingPage = deferred<Result<api.TopicPage>>()
    c.listTopics.mockReturnValueOnce(pendingPage.promise)
    loadMore.focus()
    loadMore.click()
    await settle()
    const paginationRegion = dialog.querySelector('.reply-panel__move-older')!
    expect(paginationRegion.getAttribute('aria-busy')).toBe('true')
    expect(paginationRegion.querySelector('.ui-skeleton')).not.toBeNull()
    expect(select.disabled).toBe(false)
    expect(loadMore.disabled).toBe(true)
    expect(dom.doc.activeElement).toBe(select)
    loadMore.click()
    expect(c.listTopics).toHaveBeenCalledTimes(2)

    pendingPage.resolve({ ok: false, kind: 'network' })
    await settle()
    expect(paginationRegion.getAttribute('aria-busy')).toBe('false')
    expect(paginationRegion.querySelector('.ui-skeleton')).toBeNull()
    expect(loadMore.disabled).toBe(false)
    expect(dom.doc.activeElement).toBe(select)
    expect(queryAll(dialog, '[role="alert"]').map(alert => alert.textContent)).toEqual([
      '以前のトピックを読み込めませんでした。通信状況を確認して、もう一度お試しください。',
    ])

    const topicA = summary('topic-a', 7, 1)
    c.listTopics.mockResolvedValueOnce(ok({
      history_generation: c.historyGeneration, as_of_seq: 10, topics: [topicA], has_more: true,
    }))
    const retryBtn = buttonsByText(dialog, '読み込みを再試行')[0]
    expect(retryBtn.getAttribute('aria-label')).toBe('以前のトピックの読み込みを再試行')
    retryBtn.focus()
    retryBtn.click()
    await settle()

    expect(c.listTopics).toHaveBeenCalledTimes(3)
    expect(queryAll(dialog, '[role="alert"]')).toHaveLength(0)
    expect(dialog.querySelector('select')?.options.map(option => option.value)).toEqual(['topic-b', 'topic-c', 'topic-a'])
    expect(buttonsByText(dialog, '以前のトピックを読み込む')).toHaveLength(1)
    expect(dom.doc.activeElement).toBe(select)
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog preserves selected Topic and pending Move retry after loading another Topic page', async () => {
  const c = await mountReplyPanelForMove()
  try {
    c.moveChainApi
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce(ok({
        history_generation: c.historyGeneration, root_id: c.rootMessage.id, topic_id: 'topic-c',
        destination_topic_id: 'topic-c', chain_version: 11, operation_id: '00000000-0000-4000-8000-000000000644',
        operation_version: 11, move_seq: 11,
      }))
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    select.value = 'topic-c'
    select.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()

    buttonsByText(dialog, 'トピックに移動')[0].click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(1)
    expect(c.moveChainApi.mock.calls[0][2].topic_id).toBe('topic-c')
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    const topicA = summary('topic-a', 7, 1)
    c.listTopics.mockResolvedValueOnce(ok({
      history_generation: c.historyGeneration, as_of_seq: 10, topics: [topicA], has_more: false,
    }))
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    expect(select.value).toBe('topic-c')
    expect(select.options.map(option => option.value)).toEqual(['topic-b', 'topic-c', 'topic-a'])
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    buttonsByText(dialog, '再試行')[0].click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(2)
    expect(c.moveChainApi.mock.calls[1]).toEqual(c.moveChainApi.mock.calls[0])
    expect(c.host.querySelector('dialog:modal')).toBeNull()
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog pins a page-two Topic and preserves Move retry across snapshot_expired on page three', async () => {
  const historyGeneration = '00000000-0000-4000-8000-000000000515'
  const firstPage = Array.from({ length: 50 }, (_, i) => summary(`topic-${101 + i}`, 101 + i, 1))
  const secondPage = Array.from({ length: 50 }, (_, i) => summary(`topic-${51 + i}`, 51 + i, 1))
  const freshFirstPage = Array.from({ length: 50 }, (_, i) => summary(`topic-${102 + i}`, 102 + i, 1))
  const c = await mountReplyPanelForMove({
    topicListPage: { history_generation: historyGeneration, as_of_seq: 150, topics: firstPage, has_more: true },
  })
  try {
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!

    c.listTopics.mockResolvedValueOnce(ok({
      history_generation: historyGeneration, as_of_seq: 150, topics: secondPage, has_more: true,
    }))
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()
    expect(select.options).toHaveLength(100)

    select.value = 'topic-51'
    select.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()

    c.moveChainApi
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce(ok({
        history_generation: historyGeneration, root_id: c.rootMessage.id, topic_id: 'topic-51',
        destination_topic_id: 'topic-51', chain_version: 11, operation_id: '00000000-0000-4000-8000-000000000645',
        operation_version: 11, move_seq: 11,
      }))
    buttonsByText(dialog, 'トピックに移動')[0].click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(1)
    expect(c.moveChainApi.mock.calls[0][2].topic_id).toBe('topic-51')
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    c.listTopics
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
      .mockResolvedValueOnce(ok({
        history_generation: historyGeneration, as_of_seq: 160, topics: freshFirstPage, has_more: true,
      }))
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    expect(select.value).toBe('topic-51')
    expect(select.options.some(option => option.value === 'topic-51')).toBe(true)
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    buttonsByText(dialog, '再試行')[0].click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(2)
    expect(c.moveChainApi.mock.calls[1]).toEqual(c.moveChainApi.mock.calls[0])
    expect(c.host.querySelector('dialog:modal')).toBeNull()
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog keeps focus inside dialog for Tab and Escape while pagination or retry is pending, and scopes completion focus to the same dialog opening', async () => {
  const c = await mountReplyPanelForMove()
  try {
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    let dialog = c.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    const loadMore = buttonsByText(dialog, '以前のトピックを読み込む')[0]

    const pendingPage = deferred<Result<api.TopicPage>>()
    c.listTopics.mockReturnValueOnce(pendingPage.promise)
    loadMore.focus()
    loadMore.click()
    await settle()

    expect(dom.doc.activeElement).toBe(select)
    const tab = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    tab.key = 'Tab'
    ;(dom.doc.activeElement as MiniElement).dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(dom.doc.activeElement).not.toBe(select)
    expect(dom.doc.activeElement).not.toBe(dom.doc.body)

    const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    esc.key = 'Escape'
    ;(dom.doc.activeElement as MiniElement).dispatchEvent(esc)
    await settle()
    expect(c.host.querySelector('dialog:modal')).toBeNull()

    // Reopen dialog before the previous opening's request resolves; completion must not hijack focus.
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    dialog = c.host.querySelector('dialog:modal')!
    const newRadio = queryAll(dialog, 'input[type="radio"]').find(r => r.value === 'new')!
    newRadio.focus()
    pendingPage.resolve({ ok: false, kind: 'network' })
    await settle()
    expect(dom.doc.activeElement).toBe(newRadio)

    // Retry button also transfers focus immediately before unmounting, so Tab and Escape work while pending.
    const retryBtn = buttonsByText(dialog, '読み込みを再試行')[0]
    const pendingRetry = deferred<Result<api.TopicPage>>()
    c.listTopics.mockReturnValueOnce(pendingRetry.promise)
    retryBtn.focus()
    retryBtn.click()
    await settle()

    expect(buttonsByText(dialog, '読み込みを再試行')).toHaveLength(0)
    expect(dom.doc.activeElement).toBe(dialog.querySelector('select'))
    const tab2 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    tab2.key = 'Tab'
    ;(dom.doc.activeElement as MiniElement).dispatchEvent(tab2)
    expect(tab2.defaultPrevented).toBe(true)
    expect(dom.doc.activeElement).not.toBe(dom.doc.body)

    const esc2 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    esc2.key = 'Escape'
    ;(dom.doc.activeElement as MiniElement).dispatchEvent(esc2)
    await settle()
    expect(c.host.querySelector('dialog:modal')).toBeNull()

    pendingRetry.resolve({ ok: false, kind: 'network' })
    await settle()
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog gives distinct accessible names to pagination and Move retries and disables pagination retry while Move is busy', async () => {
  const c = await mountReplyPanelForMove()
  try {
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!

    c.listTopics.mockResolvedValueOnce({ ok: false, kind: 'network' })
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    const pendingMoveRetry = deferred<Result<MoveChainResponse>>()
    c.moveChainApi
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockReturnValueOnce(pendingMoveRetry.promise)
    buttonsByText(dialog, 'トピックに移動')[0].click()
    await settle()

    const paginationRetry = buttonsByText(dialog, '読み込みを再試行')[0]
    const moveRetry = buttonsByText(dialog, '再試行')[0]
    expect(paginationRetry).toBeDefined()
    expect(moveRetry).toBeDefined()
    expect(paginationRetry.getAttribute('aria-label')).toBe('以前のトピックの読み込みを再試行')
    expect(moveRetry.getAttribute('aria-label')).toBe('移動を再試行')
    expect(paginationRetry.getAttribute('aria-label')).not.toBe(moveRetry.getAttribute('aria-label'))
    expect(paginationRetry.disabled).toBe(false)

    moveRetry.click()
    await settle()
    expect(paginationRetry.disabled).toBe(true)
    paginationRetry.click()
    expect(c.listTopics).toHaveBeenCalledTimes(2)

    pendingMoveRetry.resolve(ok({
      history_generation: c.historyGeneration, root_id: c.rootMessage.id, topic_id: 'topic-b',
      destination_topic_id: 'topic-b', chain_version: 11, operation_id: '00000000-0000-4000-8000-000000000646',
      operation_version: 11, move_seq: 11,
    }))
    await settle()
    expect(c.host.querySelector('dialog:modal')).toBeNull()
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog disables fresh Move and shows alert when selected Topic disappears from a complete list until another Topic is explicitly chosen', async () => {
  const c = await mountReplyPanelForMove()
  try {
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    const submit = buttonsByText(dialog, 'トピックに移動')[0]
    expect(select.value).toBe('topic-b')
    expect(submit.disabled).toBe(false)

    c.listTopics
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
      .mockResolvedValueOnce(ok({
        history_generation: c.historyGeneration, as_of_seq: 11, topics: [c.topicC], has_more: false,
      }))
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    expect(select.value).toBe('')
    expect(select.options.map(option => option.value)).toEqual(['', 'topic-c'])
    expect(select.options[0].disabled).toBe(true)
    expect(submit.disabled).toBe(true)
    expect(queryAll(dialog, '[role="alert"]').map(alert => alert.textContent)).toEqual([
      '選択中のトピックは利用できなくなりました。別のトピックを選択してください。',
    ])
    submit.click()
    await settle()
    expect(c.moveChainApi).not.toHaveBeenCalled()

    select.value = 'topic-c'
    select.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()

    expect(select.value).toBe('topic-c')
    expect(submit.disabled).toBe(false)
    expect(queryAll(dialog, '[role="alert"]')).toHaveLength(0)

    c.moveChainApi.mockResolvedValueOnce(ok({
      history_generation: c.historyGeneration, root_id: c.rootMessage.id, topic_id: 'topic-c',
      destination_topic_id: 'topic-c', chain_version: 11, operation_id: '00000000-0000-4000-8000-000000000647',
      operation_version: 11, move_seq: 11,
    }))
    submit.click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(1)
    expect(c.moveChainApi.mock.calls[0][2].topic_id).toBe('topic-c')
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog retries an unknown-outcome Move with the identical operation_id and destination even after the destination disappears from a complete list', async () => {
  const c = await mountReplyPanelForMove()
  try {
    c.moveChainApi
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce(ok({
        history_generation: c.historyGeneration, root_id: c.rootMessage.id, topic_id: 'topic-b',
        destination_topic_id: 'topic-b', chain_version: 11, operation_id: '00000000-0000-4000-8000-000000000648',
        operation_version: 11, move_seq: 11,
      }))
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    const submit = buttonsByText(dialog, 'トピックに移動')[0]
    expect(select.value).toBe('topic-b')

    submit.click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(1)
    expect(c.moveChainApi.mock.calls[0][2].topic_id).toBe('topic-b')
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    c.listTopics
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
      .mockResolvedValueOnce(ok({
        history_generation: c.historyGeneration, as_of_seq: 11, topics: [c.topicC], has_more: false,
      }))
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    expect(select.value).toBe('topic-b')
    expect(submit.disabled).toBe(false)
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    buttonsByText(dialog, '再試行')[0].click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(2)
    expect(c.moveChainApi.mock.calls[1]).toEqual(c.moveChainApi.mock.calls[0])
    expect(c.host.querySelector('dialog:modal')).toBeNull()
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog keeps selected Topic and allows fresh Move when it is missing from a partial first page after snapshot_expired', async () => {
  const historyGeneration = '00000000-0000-4000-8000-000000000515'
  const firstPage = Array.from({ length: 50 }, (_, i) => summary(`topic-${101 + i}`, 101 + i, 1))
  const secondPage = Array.from({ length: 50 }, (_, i) => summary(`topic-${51 + i}`, 51 + i, 1))
  const freshFirstPage = Array.from({ length: 50 }, (_, i) => summary(`topic-${102 + i}`, 102 + i, 1))
  const c = await mountReplyPanelForMove({
    topicListPage: { history_generation: historyGeneration, as_of_seq: 150, topics: firstPage, has_more: true },
  })
  try {
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    const submit = buttonsByText(dialog, 'トピックに移動')[0]

    c.listTopics.mockResolvedValueOnce(ok({
      history_generation: historyGeneration, as_of_seq: 150, topics: secondPage, has_more: true,
    }))
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    select.value = 'topic-51'
    select.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()

    c.listTopics
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
      .mockResolvedValueOnce(ok({
        history_generation: historyGeneration, as_of_seq: 160, topics: freshFirstPage, has_more: true,
      }))
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    expect(select.value).toBe('topic-51')
    expect(select.options.some(option => option.value === 'topic-51')).toBe(true)
    expect(submit.disabled).toBe(false)
    expect(queryAll(dialog, '[role="alert"]')).toHaveLength(0)

    c.moveChainApi.mockResolvedValueOnce(ok({
      history_generation: historyGeneration, root_id: c.rootMessage.id, topic_id: 'topic-51',
      destination_topic_id: 'topic-51', chain_version: 11, operation_id: '00000000-0000-4000-8000-000000000649',
      operation_version: 11, move_seq: 11,
    }))
    submit.click()
    await settle()
    expect(c.moveChainApi).toHaveBeenCalledTimes(1)
    expect(c.moveChainApi.mock.calls[0][2].topic_id).toBe('topic-51')
    expect(c.host.querySelector('dialog:modal')).toBeNull()
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog keeps focus inside dialog for Tab and Escape during first-page retry in both existing-Topic and new-Topic modes', async () => {
  // New-Topic mode: initial list load fails and user is in new-Topic mode.
  const cNew = await mountReplyPanelForMove({ initialListError: true })
  try {
    buttonsByText(cNew.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = cNew.host.querySelector('dialog:modal')!
    const newRadio = queryAll(dialog, 'input[type="radio"]').find(r => r.value === 'new')!
    newRadio.checked = true
    newRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    const nameInput = dialog.querySelector('input[name="move_topic_name"]')!
    expect(nameInput).not.toBeNull()
    const retryBtn = buttonsByText(dialog, '再試行')[0]
    expect(retryBtn.getAttribute('aria-label')).toBe('トピック一覧の読み込みを再試行')

    const pendingNewRetry = deferred<Result<api.TopicPage>>()
    cNew.listTopics.mockReturnValueOnce(pendingNewRetry.promise)
    retryBtn.focus()
    retryBtn.click()
    await settle()

    expect(buttonsByText(dialog, '再試行')).toHaveLength(0)
    expect(dom.doc.activeElement).toBe(nameInput)
    const tab = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    tab.key = 'Tab'
    ;(dom.doc.activeElement as MiniElement).dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(dom.doc.activeElement).not.toBe(nameInput)
    expect(dom.doc.activeElement).not.toBe(dom.doc.body)

    const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    esc.key = 'Escape'
    ;(dom.doc.activeElement as MiniElement).dispatchEvent(esc)
    await settle()
    expect(cNew.host.querySelector('dialog:modal')).toBeNull()

    pendingNewRetry.resolve({ ok: false, kind: 'network' })
    await settle()
  } finally {
    await cNew.close()
  }

  // Existing-Topic mode: snapshot_expired reload fails on the fresh first page, showing first-page retry while select stays mounted.
  const cExisting = await mountReplyPanelForMove()
  try {
    buttonsByText(cExisting.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = cExisting.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!

    cExisting.listTopics
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    const retryBtn = buttonsByText(dialog, '再試行')[0]
    expect(retryBtn.getAttribute('aria-label')).toBe('トピック一覧の読み込みを再試行')
    const pendingExistingRetry = deferred<Result<api.TopicPage>>()
    cExisting.listTopics.mockReturnValueOnce(pendingExistingRetry.promise)
    retryBtn.focus()
    retryBtn.click()
    await settle()

    expect(buttonsByText(dialog, '再試行')).toHaveLength(0)
    expect(dom.doc.activeElement).toBe(select)
    const tab = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    tab.key = 'Tab'
    ;(dom.doc.activeElement as MiniElement).dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(dom.doc.activeElement).not.toBe(select)
    expect(dom.doc.activeElement).not.toBe(dom.doc.body)

    const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    esc.key = 'Escape'
    ;(dom.doc.activeElement as MiniElement).dispatchEvent(esc)
    await settle()
    expect(cExisting.host.querySelector('dialog:modal')).toBeNull()

    pendingExistingRetry.resolve({ ok: false, kind: 'network' })
    await settle()
  } finally {
    await cExisting.close()
  }
})

it('ReplyPanel Move dialog does not steal focus from the still-focused select when Topic list loading completes', async () => {
  const c = await mountReplyPanelForMove()
  try {
    buttonsByText(c.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = c.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    const loadMore = buttonsByText(dialog, '以前のトピックを読み込む')[0]

    const pendingPage = deferred<Result<api.TopicPage>>()
    c.listTopics.mockReturnValueOnce(pendingPage.promise)
    loadMore.focus()
    loadMore.click()
    await settle()
    expect(dom.doc.activeElement).toBe(select)

    pendingPage.resolve(ok({
      history_generation: c.historyGeneration, as_of_seq: 10, topics: [summary('topic-a', 7, 1)], has_more: true,
    }))
    await settle()

    expect(buttonsByText(dialog, '以前のトピックを読み込む')).toHaveLength(1)
    expect(buttonsByText(dialog, '以前のトピックを読み込む')[0].disabled).toBe(false)
    expect(dom.doc.activeElement).toBe(select)
  } finally {
    await c.close()
  }
})

it('ReplyPanel Move dialog treats a Topic missing from a partial list as unavailable once confirmed notFound for fresh Move, while keeping exact retry for pending unknown-outcome Move', async () => {
  // Fresh Move: missing from a replaced partial page remains selectable until confirmed notFound via 404 topic_not_found.
  const cFresh = await mountReplyPanelForMove()
  try {
    buttonsByText(cFresh.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = cFresh.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    const submit = buttonsByText(dialog, 'トピックに移動')[0]
    expect(select.value).toBe('topic-b')
    expect(submit.disabled).toBe(false)

    cFresh.listTopics
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
      .mockResolvedValueOnce(ok({
        history_generation: cFresh.historyGeneration, as_of_seq: 11, topics: [cFresh.topicC], has_more: true,
      }))
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    expect(cFresh.topics.state.list.hasMore).toBe(true)
    expect(select.value).toBe('topic-b')
    expect(select.options.map(option => option.value)).toEqual(['topic-c', 'topic-b'])
    expect(submit.disabled).toBe(false)
    expect(queryAll(dialog, '[role="alert"]')).toHaveLength(0)

    cFresh.net.topicSummaries['A:topic-b'] = { ok: false, kind: 'http', status: 404, error: 'topic_not_found' }
    await cFresh.topics.loadSummary('topic-b')
    await settle()

    expect(cFresh.topics.state.list.hasMore).toBe(true)
    expect(cFresh.topics.state.topic('topic-b').notFound).toBe(true)
    expect(select.value).toBe('')
    expect(select.options.map(option => option.value)).toEqual(['', 'topic-c'])
    expect(select.options[0].disabled).toBe(true)
    expect(submit.disabled).toBe(true)
    expect(queryAll(dialog, '[role="alert"]').map(alert => alert.textContent)).toEqual([
      '選択中のトピックは利用できなくなりました。別のトピックを選択してください。',
    ])
    submit.click()
    await settle()
    expect(cFresh.moveChainApi).not.toHaveBeenCalled()

    select.value = 'topic-c'
    select.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()

    expect(select.value).toBe('topic-c')
    expect(submit.disabled).toBe(false)
    expect(queryAll(dialog, '[role="alert"]')).toHaveLength(0)

    cFresh.moveChainApi.mockResolvedValueOnce(ok({
      history_generation: cFresh.historyGeneration, root_id: cFresh.rootMessage.id, topic_id: 'topic-c',
      destination_topic_id: 'topic-c', chain_version: 11, operation_id: '00000000-0000-4000-8000-000000000650',
      operation_version: 11, move_seq: 11,
    }))
    submit.click()
    await settle()
    expect(cFresh.moveChainApi).toHaveBeenCalledTimes(1)
    expect(cFresh.moveChainApi.mock.calls[0][2].topic_id).toBe('topic-c')
    expect(cFresh.host.querySelector('dialog:modal')).toBeNull()
  } finally {
    await cFresh.close()
  }

  // Pending unknown-outcome Move: same confirmed-gone state on a partial page keeps the exact retry (same operation_id and destination).
  const cRetry = await mountReplyPanelForMove()
  try {
    cRetry.moveChainApi
      .mockResolvedValueOnce({ ok: false, kind: 'network' })
      .mockResolvedValueOnce(ok({
        history_generation: cRetry.historyGeneration, root_id: cRetry.rootMessage.id, topic_id: 'topic-b',
        destination_topic_id: 'topic-b', chain_version: 11, operation_id: '00000000-0000-4000-8000-000000000651',
        operation_version: 11, move_seq: 11,
      }))
    buttonsByText(cRetry.host, 'トピックに移動')[0].click()
    await settle()
    const dialog = cRetry.host.querySelector('dialog:modal')!
    const select = dialog.querySelector('select')!
    const submit = buttonsByText(dialog, 'トピックに移動')[0]
    expect(select.value).toBe('topic-b')

    submit.click()
    await settle()
    expect(cRetry.moveChainApi).toHaveBeenCalledTimes(1)
    expect(cRetry.moveChainApi.mock.calls[0][2].topic_id).toBe('topic-b')
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    cRetry.listTopics
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 409, error: 'snapshot_expired' })
      .mockResolvedValueOnce(ok({
        history_generation: cRetry.historyGeneration, as_of_seq: 11, topics: [cRetry.topicC], has_more: true,
      }))
    buttonsByText(dialog, '以前のトピックを読み込む')[0].click()
    await settle()

    cRetry.net.topicSummaries['A:topic-b'] = { ok: false, kind: 'http', status: 404, error: 'topic_not_found' }
    await cRetry.topics.loadSummary('topic-b')
    await settle()

    expect(cRetry.topics.state.list.hasMore).toBe(true)
    expect(cRetry.topics.state.topic('topic-b').notFound).toBe(true)
    expect(select.value).toBe('topic-b')
    expect(select.options.map(option => option.value)).toEqual(['topic-c', 'topic-b'])
    expect(submit.disabled).toBe(false)
    expect(queryAll(dialog, '[role="alert"]').map(alert => alert.textContent)).not.toContain(
      '選択中のトピックは利用できなくなりました。別のトピックを選択してください。',
    )
    expect(buttonsByText(dialog, '再試行')).toHaveLength(1)

    buttonsByText(dialog, '再試行')[0].click()
    await settle()
    expect(cRetry.moveChainApi).toHaveBeenCalledTimes(2)
    expect(cRetry.moveChainApi.mock.calls[1]).toEqual(cRetry.moveChainApi.mock.calls[0])
    expect(cRetry.host.querySelector('dialog:modal')).toBeNull()
  } finally {
    await cRetry.close()
  }
})
