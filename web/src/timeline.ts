/** Transitional entry points for the existing components; sync owns all state and decisions. */
export { createSync } from './sync'
export type { TimelineApi, TimelineState } from './sync'
import { createSync } from './sync'
export type Timeline = ReturnType<ReturnType<typeof createSync>['getTimeline']>
export const sendErrorMessage = (retryable: boolean) =>
  retryable ? '送信できませんでした。再送できます。' : '送信できませんでした。内容を確認してください。'
