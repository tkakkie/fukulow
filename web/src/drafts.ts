export type DraftTarget = { organizationId: string; channelId: string; topicId?: string | null; replyRootId?: string | null }

/** Account Session memory only; independent of Organization/controller lifetimes. */
export function createDraftStore() {
  const drafts = new Map<string, { text: string; topicDraft: string }>()
  const revisions = new Map<string, number>()
  const listeners = new Set<(target: DraftTarget) => void>()
  let epoch = 0
  const key = (target: DraftTarget) => JSON.stringify([target.organizationId, target.channelId, target.topicId ?? null, target.replyRootId ?? null])
  const store = {
    get: (target: DraftTarget) => drafts.get(key(target))?.text ?? '',
    getTopicDraft: (target: DraftTarget) => drafts.get(key(target))?.topicDraft ?? '',
    // Body and optional Topic name form one draft: notify and advance its revision atomically.
    set(target: DraftTarget, text: string, topicDraft = '') {
      const id = key(target)
      revisions.set(id, (revisions.get(id) ?? 0) + 1)
      if (text || topicDraft) drafts.set(id, { text, topicDraft }); else drafts.delete(id)
      listeners.forEach(listener => listener(target))
    },
    subscribe(listener: (target: DraftTarget) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    revision: (target: DraftTarget) => revisions.get(key(target)) ?? 0,
    hasDrafts: () => drafts.size > 0,
  }
  return {
    ...store,
    clear() { epoch++; drafts.clear(); revisions.clear(); listeners.clear() },
    scope() {
      const mine = epoch
      return {
        get: (target: DraftTarget) => mine === epoch ? store.get(target) : '',
        getTopicDraft: (target: DraftTarget) => mine === epoch ? store.getTopicDraft(target) : '',
        set(target: DraftTarget, text: string, topicDraft = '') {
          if (mine === epoch) store.set(target, text, topicDraft)
        },
        revision: (target: DraftTarget) => mine === epoch ? store.revision(target) : -1,
        subscribe: (listener: (target: DraftTarget) => void) => mine === epoch ? store.subscribe(listener) : () => {},
        hasDrafts: () => mine === epoch && drafts.size > 0,
      }
    },
  }
}
export type DraftStore = ReturnType<ReturnType<typeof createDraftStore>['scope']>
