import type { MoveChainRequest, MoveChainResponse, Result } from './api'
import type { Replies } from './replies'
import type { createSync } from './sync'

export type MoveDestination = { topicId: string; topicName?: never } | { topicName: string; topicId?: never }
export type MoveResult =
  | { kind: 'moved'; receipt: MoveChainResponse }
  | { kind: 'unknown'; retry: () => Promise<MoveResult>; retryAfterMs?: number }
  | { kind: 'conflict'; error: 'version_conflict' | 'operation_conflict' }
  | { kind: 'too_large' | 'denied' | 'not_found' | 'snapshot_expired' | 'history_generation_changed' | 'baseline_unavailable' | 'superseded' }
  | { kind: 'failed'; status: number; error?: string }

export type MoveChainApi = (channel: string, anchor: string, body: MoveChainRequest) => Promise<Result<MoveChainResponse>>

export function createMoveChain(sync: Pick<ReturnType<typeof createSync>, 'observeHistoryGeneration'>,
  replies: Pick<Replies, 'moveBaseline'>, options: { api: MoveChainApi; newId?: () => string; requestTimeoutMs?: number }) {
  const newId = options.newId ?? (() => crypto.randomUUID())
  return async function moveChain(channel: string, anchor: string, destination: MoveDestination): Promise<MoveResult> {
    const baseline = replies.moveBaseline(channel, anchor)
    if (!baseline) return { kind: 'baseline_unavailable' }
    const { isCurrent, refresh } = baseline
    const body: MoveChainRequest = {
      operation_id: newId(), expected_version: baseline.chain_version, history_generation: baseline.history_generation,
      ...(destination.topicId !== undefined ? { topic_id: destination.topicId } : { topic_name: destination.topicName }),
    }
    let pending: Promise<MoveResult> | undefined
    let terminal: MoveResult | undefined

    function attempt(): Promise<MoveResult> {
      if (terminal) return Promise.resolve(terminal)
      if (pending) return pending
      if (!isCurrent()) return Promise.resolve({ kind: 'superseded' })
      pending = run().then(result => {
        pending = undefined
        if (result.kind !== 'unknown') terminal = result
        return result
      })
      return pending
    }

    async function run(): Promise<MoveResult> {
      let timer: ReturnType<typeof setTimeout> | undefined
      const operation = Promise.resolve().then((): ReturnType<MoveChainApi> | Result<MoveChainResponse> =>
        isCurrent() ? options.api(channel, anchor, body) : { ok: false, kind: 'network' })
        .catch((): Result<MoveChainResponse> => ({ ok: false, kind: 'network' }))
      const result = await Promise.race([operation, new Promise<Result<MoveChainResponse>>(resolve => {
        timer = setTimeout(() => resolve({ ok: false, kind: 'network' }), options.requestTimeoutMs ?? 30_000)
      })]).finally(() => clearTimeout(timer))
      if (result.ok) {
        if (!isCurrent() || !sync.observeHistoryGeneration(result.data.history_generation)) return { kind: 'superseded' }
        return { kind: 'moved', receipt: result.data }
      }
      if (result.kind === 'network' || result.status === 408 || result.status >= 500) {
        return isCurrent() ? { kind: 'unknown', retry: attempt, retryAfterMs: result.retryAfterMs } : { kind: 'superseded' }
      }
      if (result.status === 404) return { kind: 'not_found' }
      if (result.status === 403) return { kind: 'denied' }
      if (result.status === 409) {
        switch (result.error) {
          case 'version_conflict':
          case 'operation_conflict':
            await refresh()
            return { kind: 'conflict', error: result.error }
          case 'chain_too_large': return { kind: 'too_large' }
          case 'snapshot_expired': return { kind: 'snapshot_expired' }
          case 'history_generation_changed':
            if (isCurrent()) sync.observeHistoryGeneration()
            return { kind: 'history_generation_changed' }
        }
      }
      return { kind: 'failed', status: result.status, error: result.error }
    }
    return attempt()
  }
}
