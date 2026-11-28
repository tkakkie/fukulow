import type { Message } from './api'
import type { Navigation } from './navigation'
import type { createNavigationTargets } from './navigation-targets'
import type { Replies } from './replies'
import type { SearchAnchorView } from './search-anchor-view'
import type { TimelineState } from './sync'
import { resolveReplyAnchor } from './workspace-routing'

type ReplyState = Pick<ReturnType<Replies['get']>, 'anchor' | 'rootId' | 'unavailable'>
type NavigationTargets = ReturnType<ReturnType<typeof createNavigationTargets>['get']>
type RouteReply = Pick<NavigationTargets['reply'], 'status' | 'anchor' | 'targetId'>

export function resolveWorkspaceReplyAnchor(
  searchReply: boolean,
  searchAnchor: () => Message | undefined,
  inMemoryAnchor: () => Message | null,
  routeAnchor: () => Message | undefined,
): Message | null {
  return (searchReply ? searchAnchor() : inMemoryAnchor() ?? routeAnchor()) ?? null
}

export function resolveReplyTarget(
  searchReply: boolean,
  searchView: () => SearchAnchorView | undefined,
  routeReply: () => RouteReply | undefined,
  activeReplyMessageId: () => string | null,
): Pick<RouteReply, 'status' | 'anchor'> {
  if (searchReply) {
    const view = searchView()
    return { status: view?.status === 'missing' ? 'unavailable' : view?.status ?? 'loading', anchor: view?.reply }
  }
  const reply = routeReply()
  return reply && (!reply.targetId || reply.targetId === activeReplyMessageId()) ? reply : { status: 'idle' }
}

export function createWorkspaceReplies(anchor: { get(): Message | null; set(message: Message): void }) {
  // A cold descendant URL can resolve to its root before its own body is paged in.
  let openedReplyTarget = ''
  return {
    resolveInMemory(input: Omit<Parameters<typeof resolveReplyAnchor>[0], 'lastOpenedAnchor'>) {
      return resolveReplyAnchor({ ...input, lastOpenedAnchor: anchor.get })
    },
    sync(input: {
      replies: { open(message: Message): unknown; dismiss(): unknown } | null
      selected: () => { id: string } | undefined
      activeReplyMessageId: () => string | null
      state: () => ReplyState | null
      organizationUnavailable: () => boolean
      timelineStatus: () => TimelineState['status'] | undefined
      resolvedAnchor: () => Message | null
    }) {
      const { replies } = input
      if (!replies) return
      const selected = input.selected()
      if (!selected) return
      const messageId = input.activeReplyMessageId()
      if (!messageId) {
        openedReplyTarget = ''
        if (input.state()?.anchor) replies.dismiss()
        return
      }
      // Track timeline status so a Reply can open once its Channel is watched.
      if (input.organizationUnavailable() || input.timelineStatus() === 'unavailable' || input.state()?.unavailable) return

      const message = input.resolvedAnchor()
      if (!message || message.channel_id !== selected.id) return
      const targetRootId = message.reply_root_id ?? message.id
      const targetKey = `${selected.id}:${messageId}`
      const state = input.state()
      if (state?.anchor && state.rootId === targetRootId && openedReplyTarget === targetKey) return
      openedReplyTarget = targetKey
      void replies.open(message)
    },
    open(message: Message, openChain: (message: Message) => unknown, navigate: Navigation['navigate'], opener?: HTMLElement | null) {
      anchor.set(message)
      openedReplyTarget = `${message.channel_id}:${message.id}`
      void openChain(message)
      navigate({ type: 'reply', messageId: message.id }, opener)
    },
  }
}
