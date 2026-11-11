export type DraftTarget = { organizationId: string; channelId: string; topicId?: string | null; replyRootId?: string | null }

/** Account Session memory only; independent of Organization/controller lifetimes. */
export function createDraftStore() {
  const drafts = new Map<string, string>()
  const key = (target: DraftTarget) => JSON.stringify([target.organizationId, target.channelId, target.topicId ?? null, target.replyRootId ?? null])
  return {
    get: (target: DraftTarget) => drafts.get(key(target)) ?? '',
    set(target: DraftTarget, text: string) { if (text) drafts.set(key(target), text); else drafts.delete(key(target)) },
    hasDrafts: () => drafts.size > 0,
    clear: () => drafts.clear(),
  }
}
export type DraftStore = ReturnType<typeof createDraftStore>
