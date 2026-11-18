import type { MoveChainRequest, MoveChainResponse, Result } from './api'
import type { Replies } from './replies'
import type { createSync } from './sync'

export type MoveDestination = { topicId: string; topicName?: never } | { topicName: string; topicId?: never }
export type MoveResult =
  | { kind: 'moved'; receipt: MoveChainResponse }
  | { kind: 'unknown'; retry: () => Promise<MoveResult>; retryAfterMs?: number }
  | { kind: 'conflict'; error: 'version_conflict' | 'operation_conflict'; refreshed: boolean }
  | { kind: 'too_large' | 'denied' | 'not_found' | 'snapshot_expired' | 'history_generation_changed' | 'baseline_unavailable' | 'superseded' }
  | { kind: 'failed'; status: number; error?: string }

export type MoveChainApi = (channel: string, anchor: string, body: MoveChainRequest) => Promise<Result<MoveChainResponse>>
type MoveTarget = NonNullable<ReturnType<Replies['moveTarget']>>

export function createMoveChain(sync: Pick<ReturnType<typeof createSync>, 'observeHistoryGeneration'>,
  replies: Pick<Replies, 'moveTarget'>, options: { api: MoveChainApi; newId?: () => string; requestTimeoutMs?: number }) {
  const newId = options.newId ?? (() => crypto.randomUUID())
  const unresolved = new Map<string, (target: MoveTarget) => Promise<MoveResult>>()
  return function moveChain(channel: string, anchor: string, destination: MoveDestination): Promise<MoveResult> {
    const target = replies.moveTarget(channel, anchor)
    if (!target) return Promise.resolve({ kind: 'baseline_unavailable' })
    const { topicId, topicName } = destination
    // The receipt matches names case-insensitively for ASCII and binds the original anchor.
    const key = JSON.stringify([channel, target.rootId, topicId, topicName?.replace(/[A-Z]/g, c => c.toLowerCase())])
    const existing = unresolved.get(key)
    if (existing) return existing(target)
    const { baseline } = target
    if (!baseline) return Promise.resolve({ kind: 'baseline_unavailable' })
    const body: MoveChainRequest = {
      operation_id: newId(), expected_version: baseline.chain_version, history_generation: baseline.history_generation,
      ...(topicId !== undefined ? { topic_id: topicId } : { topic_name: topicName }),
    }
    let pending: Promise<MoveResult> | undefined
    let terminal: MoveResult | undefined
    let dispatched = false

    function attempt(target: MoveTarget): Promise<MoveResult> {
      if (terminal) return Promise.resolve(terminal)
      if (pending) return pending
      pending = run(target).then(result => {
        pending = undefined
        if (result.kind !== 'unknown') {
          terminal = result
          unresolved.delete(key)
        }
        return result
      })
      return pending
    }

    function unknown(target: MoveTarget, retryAfterMs?: number): MoveResult {
      return { kind: 'unknown', retry: () => attempt(target), retryAfterMs }
    }

    async function run(target: MoveTarget): Promise<MoveResult> {
      let timer: ReturnType<typeof setTimeout> | undefined
      const operation = Promise.resolve().then(() => {
        if (!target.isCurrent()) return
        dispatched = true
        return options.api(channel, anchor, body)
      }).catch((): Result<MoveChainResponse> => ({ ok: false, kind: 'network' }))
      const result = await Promise.race([operation, new Promise<Result<MoveChainResponse>>(resolve => {
        timer = setTimeout(() => resolve({ ok: false, kind: 'network' }), options.requestTimeoutMs ?? 30_000)
      })]).finally(() => clearTimeout(timer))
      if (!result) return dispatched ? unknown(target) : { kind: 'superseded' }
      if (result.ok) {
        if (target.isCurrent()) sync.observeHistoryGeneration(result.data.history_generation)
        return { kind: 'moved', receipt: result.data }
      }
      if (result.kind === 'network' || result.status === 408 || result.status >= 500) {
        return unknown(target, result.retryAfterMs)
      }
      if (result.status === 404) return { kind: 'not_found' }
      if (result.status === 403) return { kind: 'denied' }
      if (result.status === 409) {
        switch (result.error) {
          case 'version_conflict':
          case 'operation_conflict':
            return { kind: 'conflict', error: result.error, refreshed: await target.refresh() }
          case 'chain_too_large': return { kind: 'too_large' }
          case 'snapshot_expired': return { kind: 'snapshot_expired' }
          case 'history_generation_changed':
            if (target.isCurrent()) sync.observeHistoryGeneration()
            return { kind: 'history_generation_changed' }
        }
      }
      return { kind: 'failed', status: result.status, error: result.error }
    }
    unresolved.set(key, attempt)
    return attempt(target)
  }
}
