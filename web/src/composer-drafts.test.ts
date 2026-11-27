import { describe, expect, it, vi } from 'vitest'
import { createComposerDrafts } from './composer-drafts'
import { createDraftStore } from './drafts'
import type { Result } from './api'

describe('createComposerDrafts', () => {
  it('isolates Channel, Topic and Reply drafts in one keyed store and hydrates lazily from DraftStore', () => {
    const store = createDraftStore()
    store.set({ organizationId: 'o1', channelId: 'c1' }, 'ch body', 'ch topic')
    store.set({ organizationId: 'o1', channelId: 'c1', topicId: 't1' }, 'topic body')
    store.set({ organizationId: 'o1', channelId: 'c1', topicId: 't1', replyRootId: 'r1' }, 'reply body')

    const drafts = createComposerDrafts({ organizationId: 'o1', drafts: store.scope() })

    expect(drafts.getChannel('c1')).toEqual({ draft: 'ch body', topicDraft: 'ch topic', composerError: null })
    expect(drafts.getScoped({ channelId: 'c1', topicId: 't1' })).toEqual({ draft: 'topic body', composerError: null })
    expect(drafts.getScoped({ channelId: 'c1', topicId: 't1', replyRootId: 'r1' })).toEqual({
      draft: 'reply body',
      composerError: null,
    })
    // Empty targets return stable empty snapshots without allocating new entries
    expect(drafts.getChannel('c2')).toBe(drafts.getChannel('c2'))
    expect(drafts.getScoped({ channelId: 'c2', topicId: 't2' })).toBe(
      drafts.getScoped({ channelId: 'c2', topicId: 't2' }),
    )
  })

  it('notifies only subscribers for the mutated key and cleans up on unsubscribe', () => {
    const drafts = createComposerDrafts({ organizationId: 'o1' })
    const chListener = vi.fn()
    const topicListener = vi.fn()
    const replyListener = vi.fn()

    const unsubCh = drafts.subscribe({ channelId: 'c1' }, chListener)
    const unsubTopic = drafts.subscribe({ channelId: 'c1', topicId: 't1' }, topicListener)
    const unsubReply = drafts.subscribe({ channelId: 'c1', topicId: 't1', replyRootId: 'r1' }, replyListener)

    drafts.setDraft({ channelId: 'c1' }, 'hello')
    drafts.setDraft({ channelId: 'c1' }, 'hello') // no-op
    expect(chListener).toHaveBeenCalledTimes(1)
    expect(topicListener).not.toHaveBeenCalled()
    expect(replyListener).not.toHaveBeenCalled()

    drafts.setTopicDraft('c1', 'Topic A')
    expect(chListener).toHaveBeenCalledTimes(2)

    drafts.setDraft({ channelId: 'c1', topicId: 't1' }, 'topic edit')
    expect(topicListener).toHaveBeenCalledTimes(1)

    drafts.setDraft({ channelId: 'c1', topicId: 't1', replyRootId: 'r1' }, 'reply edit')
    expect(replyListener).toHaveBeenCalledTimes(1)

    unsubCh()
    unsubTopic()
    unsubReply()
    drafts.setDraft({ channelId: 'c1' }, 'after unsub')
    expect(chListener).toHaveBeenCalledTimes(2)
  })

  it('validates body and optional/required Topic name before clearing or calling send', async () => {
    const drafts = createComposerDrafts({ organizationId: 'o1' })
    const send = vi.fn(async () => true)

    // Blank body: rejected silently without composerError
    drafts.setDraft({ channelId: 'c1' }, '   ')
    expect(
      await drafts.submit({
        target: { channelId: 'c1' },
        topicName: { value: '', required: false },
        canSend: () => true,
        send,
      }),
    ).toBe(false)
    expect(drafts.getChannel('c1').composerError).toBeNull()
    expect(send).not.toHaveBeenCalled()

    // Channel with invalid non-empty topicDraft sets composerError and keeps draft
    drafts.setDraft({ channelId: 'c1' }, 'valid body')
    drafts.setTopicDraft('c1', 'bad\0topic')
    expect(
      await drafts.submit({
        target: { channelId: 'c1' },
        topicName: { value: 'bad\0topic', required: false },
        canSend: () => true,
        send,
      }),
    ).toBe(false)
    expect(drafts.getChannel('c1').composerError).not.toBeNull()
    expect(drafts.getChannel('c1').draft).toBe('valid body')
    expect(send).not.toHaveBeenCalled()

    // Same-value setTopicDraft does not clear composerError; changing value does
    drafts.setTopicDraft('c1', 'bad\0topic')
    expect(drafts.getChannel('c1').composerError).not.toBeNull()
    drafts.setTopicDraft('c1', '')
    expect(drafts.getChannel('c1').composerError).toBeNull()

    // Topic with required empty topicName sets composerError
    drafts.setDraft({ channelId: 'c1', topicId: 't1' }, 'topic body')
    expect(
      await drafts.submit({
        target: { channelId: 'c1', topicId: 't1' },
        topicName: { value: '', required: true },
        canSend: () => true,
        send,
      }),
    ).toBe(false)
    expect(drafts.getScoped({ channelId: 'c1', topicId: 't1' }).composerError).not.toBeNull()

    // Reply validates body error
    drafts.setDraft({ channelId: 'c1', topicId: null, replyRootId: 'r1' }, 'bad\0body')
    expect(
      await drafts.submit({
        target: { channelId: 'c1', topicId: null, replyRootId: 'r1' },
        canSend: () => true,
        send,
      }),
    ).toBe(false)
    expect(drafts.getScoped({ channelId: 'c1', topicId: null, replyRootId: 'r1' }).composerError).not.toBeNull()

    // canSend() === false keeps draft untouched
    drafts.setDraft({ channelId: 'c1', topicId: null, replyRootId: 'r1' }, 'ok reply')
    expect(
      await drafts.submit({
        target: { channelId: 'c1', topicId: null, replyRootId: 'r1' },
        canSend: () => false,
        send,
      }),
    ).toBe(false)
    expect(drafts.getScoped({ channelId: 'c1', topicId: null, replyRootId: 'r1' }).draft).toBe('ok reply')
    expect(send).not.toHaveBeenCalled()
  })

  it('clears atomically on submit and restores only when unchanged (revision, store revision and empty fields)', async () => {
    const store = createDraftStore()
    const drafts = createComposerDrafts({ organizationId: 'o1', drafts: store.scope() })
    const target = { channelId: 'c1' }

    // 1. Unchanged draft restores on !accepted
    drafts.setDraft(target, 'first body')
    drafts.setTopicDraft('c1', 'Topic 1')
    expect(
      await drafts.submit({
        target,
        topicName: { value: 'Topic 1', required: false },
        canSend: () => true,
        send: async (body) => {
          expect(body).toBe('first body')
          expect(drafts.getChannel('c1')).toEqual({ draft: '', topicDraft: '', composerError: null })
          return false
        },
      }),
    ).toBe(false)
    expect(drafts.getChannel('c1')).toEqual({ draft: 'first body', topicDraft: 'Topic 1', composerError: null })

    // 2. Typing and clearing while send is in flight prevents restore (local revision advanced)
    expect(
      await drafts.submit({
        target,
        topicName: { value: 'Topic 1', required: false },
        canSend: () => true,
        send: async () => {
          drafts.setDraft(target, 'new edit')
          drafts.setDraft(target, '')
          return false
        },
      }),
    ).toBe(false)
    expect(drafts.getChannel('c1')).toEqual({ draft: '', topicDraft: '', composerError: null })

    // 3. Account Session clear (#242 epoch) fences restore
    drafts.setDraft(target, 'session body')
    expect(
      await drafts.submit({
        target,
        topicName: { value: '', required: false },
        canSend: () => true,
        send: async () => {
          store.clear()
          return false
        },
      }),
    ).toBe(false)
    expect(store.hasDrafts()).toBe(false)
    expect(drafts.getChannel('c1').draft).toBe('')
  })

  it('restores detached sends only on definite refusal statuses (400/403/404/409/413/415) and never on ACK or unknown', async () => {
    const definiteCases = [400, 403, 404, 409, 413, 415] as const
    for (const status of definiteCases) {
      const store = createDraftStore()
      const drafts = createComposerDrafts({ organizationId: 'o1', drafts: store.scope() })
      const target = { channelId: 'c1' }
      drafts.setDraft(target, `refused ${status}`)
      drafts.setTopicDraft('c1', 'T')
      await drafts.submit({
        target,
        topicName: { value: 'T', required: false },
        canSend: () => true,
        send: async (_body, restore) => {
          drafts.trackSubmitted('m1', 'c1', restore)
          return true
        },
      })
      drafts.detachSubmitted(() => true)
      // Repeated detach with false must not undo prior detachment
      drafts.detachSubmitted(() => false)
      drafts.observeSendResult('m1', { ok: false, kind: 'http', status })
      expect(store.get({ organizationId: 'o1', channelId: 'c1' }), `status ${status}`).toBe(`refused ${status}`)
      expect(store.getTopicDraft({ organizationId: 'o1', channelId: 'c1' }), `status ${status}`).toBe('T')
    }

    const nonRestoreResults: readonly Result<unknown>[] = [
      { ok: true, data: {} },
      { ok: false, kind: 'network' },
      { ok: false, kind: 'http', status: 401 },
      { ok: false, kind: 'http', status: 429 },
      { ok: false, kind: 'http', status: 500 },
      { ok: false, kind: 'http', status: 503 },
    ]
    for (const result of nonRestoreResults) {
      const store = createDraftStore()
      const drafts = createComposerDrafts({ organizationId: 'o1', drafts: store.scope() })
      const target = { channelId: 'c1' }
      drafts.setDraft(target, 'body')
      await drafts.submit({
        target,
        topicName: { value: '', required: false },
        canSend: () => true,
        send: async (_body, restore) => {
          drafts.trackSubmitted('m1', 'c1', restore)
          return true
        },
      })
      drafts.detachSubmitted(() => true)
      drafts.observeSendResult('m1', result)
      expect(store.get({ organizationId: 'o1', channelId: 'c1' })).toBe('')
    }

    // ACK never touches a newer draft typed after submit
    const store = createDraftStore()
    const drafts = createComposerDrafts({ organizationId: 'o1', drafts: store.scope() })
    drafts.setDraft({ channelId: 'c1' }, 'sent')
    await drafts.submit({
      target: { channelId: 'c1' },
      topicName: { value: '', required: false },
      canSend: () => true,
      send: async (_body, restore) => {
        drafts.trackSubmitted('m-ack', 'c1', restore)
        return true
      },
    })
    drafts.setDraft({ channelId: 'c1' }, 'next draft')
    drafts.observeSendResult('m-ack', { ok: true, data: {} })
    expect(drafts.getChannel('c1').draft).toBe('next draft')
    expect(store.get({ organizationId: 'o1', channelId: 'c1' })).toBe('next draft')
  })

  it('restores failed sends into Channel (with topicDraft) and Topic/Reply composers', () => {
    const drafts = createComposerDrafts({ organizationId: 'o1' })
    drafts.setDraft({ channelId: 'c1' }, 'existing')
    drafts.restoreFailed({ channelId: 'c1' }, 'failed body', 'Original Topic')
    expect(drafts.getChannel('c1')).toEqual({
      draft: 'existing\nfailed body',
      topicDraft: 'Original Topic',
      composerError: null,
    })

    // Channel restore without topicName clears conflicting topicDraft
    drafts.setDraft({ channelId: 'c1' }, '')
    drafts.setTopicDraft('c1', 'Conflicting')
    drafts.restoreFailed({ channelId: 'c1' }, 'root body')
    expect(drafts.getChannel('c1')).toEqual({ draft: 'root body', topicDraft: '', composerError: null })

    // Topic/Reply restore keeps TopicComposerState shape without topicDraft
    drafts.restoreFailed({ channelId: 'c1', topicId: 't1' }, 'topic failed')
    expect(drafts.getScoped({ channelId: 'c1', topicId: 't1' })).toEqual({
      draft: 'topic failed',
      composerError: null,
    })
  })

  it('migrates and reconciles Reply drafts across root/topic transitions', () => {
    const store = createDraftStore()
    const drafts = createComposerDrafts({ organizationId: 'o1', drafts: store.scope() })

    drafts.setDraft({ channelId: 'c1', topicId: null, replyRootId: 'anchor' }, 'from anchor')
    drafts.setDraft({ channelId: 'c1', topicId: 't1', replyRootId: 'root' }, 'existing')
    drafts.migrateReplyDraft('c1', 'anchor', null, 'root', 't1')

    expect(drafts.getScoped({ channelId: 'c1', topicId: null, replyRootId: 'anchor' }).draft).toBe('')
    expect(drafts.getScoped({ channelId: 'c1', topicId: 't1', replyRootId: 'root' }).draft).toBe(
      'existing\nfrom anchor',
    )

    // Reconcile merges drafts stored under other topicIds for the same replyRootId
    store.set({ organizationId: 'o1', channelId: 'c1', topicId: 't2', replyRootId: 'root' }, 'from t2')
    drafts.reconcileReplyDrafts('c1', 'root', 't1')
    expect(store.get({ organizationId: 'o1', channelId: 'c1', topicId: 't2', replyRootId: 'root' })).toBe('')
    expect(drafts.getScoped({ channelId: 'c1', topicId: 't1', replyRootId: 'root' }).draft).toBe(
      'existing\nfrom anchor\nfrom t2',
    )
  })

  it('tracks hasDrafts and syncs external DraftStore updates across resetSession(start/stop)', () => {
    const store = createDraftStore()
    const drafts = createComposerDrafts({ organizationId: 'o1', drafts: store.scope() })
    const listener = vi.fn()
    drafts.subscribe({ channelId: 'c1' }, listener)

    expect(drafts.hasDrafts()).toBe(false)
    const notifyStart = drafts.resetSession('start')
    notifyStart()
    expect(listener).not.toHaveBeenCalled()

    // External write for same org notifies subscriber; other org is ignored
    store.set({ organizationId: 'o2', channelId: 'c1' }, 'other org')
    expect(listener).not.toHaveBeenCalled()

    store.set({ organizationId: 'o1', channelId: 'c1' }, 'restored text', 'Topic')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(drafts.getChannel('c1')).toEqual({ draft: 'restored text', topicDraft: 'Topic', composerError: null })
    expect(drafts.hasDrafts()).toBe(true)

    // Stop unsubscribes from DraftStore and notifies previously populated keys
    const notifyStop = drafts.resetSession('stop')
    notifyStop()
    expect(listener).toHaveBeenCalledTimes(2)

    store.set({ organizationId: 'o1', channelId: 'c1' }, 'after stop')
    expect(listener).toHaveBeenCalledTimes(2)

    // Without external DraftStore, local topicDraft-only still counts as hasDrafts
    const localOnly = createComposerDrafts({ organizationId: 'o1' })
    expect(localOnly.hasDrafts()).toBe(false)
    localOnly.setTopicDraft('c1', 'Only topic')
    expect(localOnly.hasDrafts()).toBe(true)
    localOnly.setTopicDraft('c1', '')
    expect(localOnly.hasDrafts()).toBe(false)
  })

  it('notifies Channel, then Topic, then Reply listeners on resetSession regardless of insertion order', () => {
    const drafts = createComposerDrafts({ organizationId: 'o1' })
    const order: string[] = []

    drafts.setDraft({ channelId: 'c1', topicId: 't1', replyRootId: 'r1' }, 'reply draft')
    drafts.setDraft({ channelId: 'c1', topicId: 't1' }, 'topic draft')
    drafts.setDraft({ channelId: 'c1' }, 'channel draft')

    drafts.subscribe({ channelId: 'c1', topicId: 't1', replyRootId: 'r1' }, () => order.push('reply'))
    drafts.subscribe({ channelId: 'c1', topicId: 't1' }, () => order.push('topic'))
    drafts.subscribe({ channelId: 'c1' }, () => order.push('channel'))

    drafts.resetSession('stop')()
    expect(order).toEqual(['channel', 'topic', 'reply'])
  })

  it('does not cache a newer external draft during a detached refusal on a stopped controller', async () => {
    const store = createDraftStore()
    const drafts = createComposerDrafts({ organizationId: 'o1', drafts: store.scope() })
    const target = { channelId: 'c1' }

    drafts.setDraft(target, 'first draft')
    await drafts.submit({
      target,
      topicName: { value: '', required: false },
      canSend: () => true,
      send: async (_body, restore) => {
        drafts.trackSubmitted('m1', 'c1', restore)
        return true
      },
    })
    drafts.detachSubmitted(() => true)
    drafts.resetSession('stop')()

    // Another session writes a newer draft before the detached refusal arrives, then clears it
    store.set({ organizationId: 'o1', channelId: 'c1' }, 'newer draft')
    drafts.observeSendResult('m1', { ok: false, kind: 'http', status: 403 })
    store.set({ organizationId: 'o1', channelId: 'c1' }, '')

    expect(drafts.hasDrafts()).toBe(false)
  })

  it('invokes a replacement Channel listener added when the last listener unsubscribes during notification', () => {
    const drafts = createComposerDrafts({ organizationId: 'o1' })
    const replacement = vi.fn()
    let unsubFirst = () => {}

    unsubFirst = drafts.subscribe({ channelId: 'c1' }, () => {
      unsubFirst()
      drafts.subscribe({ channelId: 'c1' }, replacement)
    })

    drafts.setDraft({ channelId: 'c1' }, 'hello')
    expect(replacement).toHaveBeenCalledTimes(1)
  })
})
