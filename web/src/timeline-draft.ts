import {
  confirmReplaceDraftWithFailedSend,
  decideEditAndResend,
  discardAndFocusComposer,
  focusTarget,
  type FocusableTarget,
} from './focus-management'

export type TimelineDraftControllerOptions = {
  getDraft: () => string
  setDraft: (draft: string) => void
  getTopicDraft?: () => string
  setTopicDraft?: (topicDraft: string) => void
  discard: (clientMessageId: string) => void
  restore: (clientMessageId: string) => boolean
  canRestore: (clientMessageId: string) => boolean
  getComposerRef: () => FocusableTarget | null | undefined
  getConfirmReplaceId: () => string | null
  setConfirmReplaceId: (id: string | null) => void
  afterUpdate: () => Promise<void>
}

/**
 * Layer-3 controller coordinating failed-send discard, edit-and-resend restore and
 * draft-replacement confirmation across Timeline, TopicView and ReplyPanel (`docs/ui.md` §5, §6).
 */
export function createTimelineDraftController(options: TimelineDraftControllerOptions) {
  function handleDiscard(clientMessageId: string): void {
    discardAndFocusComposer(clientMessageId, options.discard, options.getComposerRef())
  }

  function handleRestoreRequest(clientMessageId: string): void {
    const decision = decideEditAndResend(
      clientMessageId,
      options.getDraft(),
      options.getTopicDraft?.() ?? '',
    )
    if (decision.action === 'restore_now') {
      if (options.restore(clientMessageId)) {
        focusTarget(options.getComposerRef())
      }
      return
    }
    options.setConfirmReplaceId(decision.clientMessageId)
  }

  function handleConfirmReplace(): void {
    const id = options.getConfirmReplaceId()
    options.setConfirmReplaceId(null)
    if (!id) return
    const topicDraftOptions =
      options.getTopicDraft && options.setTopicDraft
        ? {
            currentTopicDraft: options.getTopicDraft(),
            setTopicDraft: options.setTopicDraft,
          }
        : undefined
    if (
      confirmReplaceDraftWithFailedSend(
        id,
        options.getDraft(),
        options.canRestore(id),
        options.setDraft,
        options.restore,
        null,
        topicDraftOptions,
      )
    ) {
      void options.afterUpdate().then(() => {
        if (options.getConfirmReplaceId() === null) focusTarget(options.getComposerRef())
      })
    }
  }

  function handleCancelReplace(): void {
    options.setConfirmReplaceId(null)
  }

  return {
    handleDiscard,
    handleRestoreRequest,
    handleConfirmReplace,
    handleCancelReplace,
  }
}

export type TimelineDraftController = ReturnType<typeof createTimelineDraftController>
