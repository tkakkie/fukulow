import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, record, settle } from './adapter-test-helpers.svelte'
import type { SearchPresentation } from './search-anchor.svelte'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { buttonsByText, installMiniDom } from './svelte-dom-test-helpers'
import Timeline from './Timeline.svelte'
import TopicView from './TopicView.svelte'
import { topicsAdapter, type TopicsAdapter } from './topics.svelte'
import { unreadAdapter } from './unread.svelte'
import { deferred } from './unread-test-helpers'

const dom = installMiniDom()

describe('Timeline and TopicView controller regressions (#842)', () => {
  it.each(['Timeline', 'TopicView'] as const)(
    '%s does not rerun the visibility effect into unread.visibility(true) on Unread updates while unselected',
    async (view) => {
      const net = fakeNetwork()
      const message = { ...record(1, 'A'), topic_id: view === 'TopicView' ? 'T' : null }
      net.pages.A = ok({
        history_generation: message.history_generation,
        as_of_seq: 1,
        messages: [message],
        has_more: false,
      })
      const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
      net.lists[0].resolve(ok({ history_generation: message.history_generation, channels: [channel('A')] }))
      const host = dom.doc.createElement('div')
      dom.doc.body.appendChild(host)
      try {
        net.socket.onReady()
        await settle()
        net.subscribed('A', 1)
        const ch = syncAdapter(session.sync).channel('A')
        const unread = unreadAdapter(session.unread, 'A')
        const visibilitySpy = vi.spyOn(unread, 'visibility')
        const target = host as unknown as Element
        const instance =
          view === 'Timeline'
            ? mount(Timeline, {
                target,
                props: { channel: ch, channelId: 'A', selfId: 'me', unread, viewSelected: false },
              })
            : mount(TopicView, {
                target,
                props: {
                  channel: ch,
                  topics: topicsAdapter(session.topics, 'A'),
                  channelId: 'A',
                  topicId: 'T',
                  topicName: 'T',
                  selfId: 'me',
                  unread,
                  viewSelected: false,
                },
              })
        try {
          await settle()
          visibilitySpy.mockClear()

          // Trigger a reactive Unread state change while viewSelected is false.
          net.event({
            type: 'message',
            seq: 2,
            kind: 'create',
            message: { ...record(2, 'A'), sender: 'other', topic_id: view === 'TopicView' ? 'T' : null },
          })
          flushSync()
          await settle()

          expect(visibilitySpy).not.toHaveBeenCalled()
        } finally {
          await unmount(instance)
        }
      } finally {
        session.close()
      }
    },
  )

  it('Timeline jumpToBottom preserves merge-base await ordering without an extra microtask before tick()', async () => {
    const net = fakeNetwork()
    const message = { ...record(1, 'A'), topic_id: null }
    net.pages.A = ok({
      history_generation: message.history_generation,
      as_of_seq: 1,
      messages: [message],
      has_more: false,
    })
    const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
    net.lists[0].resolve(ok({ history_generation: message.history_generation, channels: [channel('A')] }))
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    try {
      net.socket.onReady()
      await settle()
      net.subscribed('A', 1)

      const ch = syncAdapter(session.sync).channel('A')
      const baseTopics = topicsAdapter(session.topics, 'A')
      const loadDeferred = deferred<undefined>()
      const loadMainLatest = vi.fn(() => loadDeferred.promise)
      const topics: TopicsAdapter = {
        get state() {
          return baseTopics.state
        },
        loadMain: baseTopics.loadMain,
        loadMainLatest,
        loadTopic: baseTopics.loadTopic,
        loadTopicLatest: baseTopics.loadTopicLatest,
        loadList: baseTopics.loadList,
        loadSummary: baseTopics.loadSummary,
        ensureSummary: baseTopics.ensureSummary,
        retrySummary: baseTopics.retrySummary,
        setMainPinned: baseTopics.setMainPinned,
        setTopicPinned: baseTopics.setTopicPinned,
        releaseTopic: baseTopics.releaseTopic,
      }

      const makeSearch = (latest: () => void): SearchPresentation => {
        const target = { channelId: 'A', topicId: null, messageId: message.id, createdSeq: message.created_seq }
        return {
          target,
          view: {
            target,
            visit: Symbol('search'),
            status: 'ready',
            lines: [{ kind: 'message', message }],
            messages: [message],
            reply: undefined,
            hasOlder: false,
            hasNewer: true,
            detached: true,
            paging: false,
            pageError: undefined,
            asOfSeq: 1,
          },
          loadOlder: async () => {},
          loadNewer: async () => {},
          retry: async () => {},
          latest,
        }
      }

      const props = $state({
        channel: ch,
        topics,
        channelId: 'A',
        selfId: 'me',
        search: undefined as SearchPresentation | undefined,
      })
      props.search = makeSearch(() => {
        props.search = undefined
      })

      const instance = mount(Timeline, { target: host as unknown as Element, props })
      try {
        await settle()
        const scrollEl = host.querySelector('.timeline-scroll') as unknown as {
          scrollTop: number
          scrollHeight: number
        }
        expect(scrollEl).not.toBeNull()
        const [latestButton] = buttonsByText(host, '最新のメッセージへ')
        expect(latestButton).toBeDefined()
        latestButton.click()
        await tick()
        expect(loadMainLatest).toHaveBeenCalledTimes(1)

        // Reset scrollTop while loadMainLatest is in flight so only jumpToBottom's final scroll moves it.
        scrollEl.scrollTop = 0
        scrollEl.scrollHeight = 800

        // Resolve loadMainLatest and reopen Search on a tick() chained directly on loadMainLatest.
        // Without an extra async wrapper, Timeline schedules its tick() before ours, so
        // jumpToBottom finishes scrolling before Search reopens.
        const reopened = makeSearch(() => {})
        void loadDeferred.promise.then(() => {
          void tick().then(() => {
            props.search = reopened
            flushSync()
          })
        })
        loadDeferred.resolve(undefined)
        await settle()

        expect(scrollEl.scrollTop).toBe(800)
      } finally {
        await unmount(instance)
      }
    } finally {
      session.close()
    }
  })
})
