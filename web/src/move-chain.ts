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
type MoveAttempt = (target: MoveTarget) => Promise<MoveResult>

export function createMoveChain(sync: Pick<ReturnType<typeof createSync>, 'get' | 'observeHistoryGeneration'>,
  replies: Pick<Replies, 'moveTarget'>, options: { api: MoveChainApi; newId?: () => string; requestTimeoutMs?: number }) {
  const newId = options.newId ?? (() => crypto.randomUUID())
  const unresolved = new Map<string, { generation: string; attempts: Map<string, MoveAttempt> }>()
  return function moveChain(channel: string, anchor: string, destination: MoveDestination): Promise<MoveResult> {
    const target = replies.moveTarget(channel, anchor)
    if (!target) return Promise.resolve({ kind: 'baseline_unavailable' })
    const { baseline } = target
    const generation = baseline?.history_generation ?? sync.get().historyGeneration
    const chainKey = JSON.stringify([channel, target.rootId])
    const saved = unresolved.get(chainKey)
    const sameGeneration = saved?.generation === generation ? saved?.attempts : undefined
    const { topicId, topicName } = destination
    // The receipt matches names case-insensitively for ASCII and binds the original anchor.
    const key = JSON.stringify([topicId, topicName?.replace(/[A-Z]/g, c => c.toLowerCase())])
    const existing = sameGeneration?.get(key)
    if (existing) return existing(target)
    if (!baseline) return Promise.resolve({ kind: 'baseline_unavailable' })
    const attempts = sameGeneration ?? new Map<string, MoveAttempt>()
    if (!sameGeneration) {
      saved?.attempts.clear()
      unresolved.set(chainKey, { generation: baseline.history_generation, attempts })
    }
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
      if (attempts.get(key) !== attempt) return Promise.resolve({ kind: 'superseded' })
      pending = run(target).then(result => {
        pending = undefined
        if (result.kind !== 'unknown') {
          terminal = result
          // Once a Move is confirmed, earlier unknown outcomes can no longer stand in for new intents.
          if (result.kind === 'moved') attempts.clear()
          else if (attempts.get(key) === attempt) attempts.delete(key)
          if (!attempts.size && unresolved.get(chainKey)?.attempts === attempts) unresolved.delete(chainKey)
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
        if (result.data.topic_id !== result.data.destination_topic_id) {
          return { kind: 'conflict', error: 'version_conflict', refreshed: await target.refresh() }
        }
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
    attempts.set(key, attempt)
    return attempt(target)
  }
}
