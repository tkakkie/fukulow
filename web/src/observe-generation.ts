import type { Result } from './api'
import type { createSync } from './sync'

type GenerationObserver = Pick<ReturnType<typeof createSync>, 'observeHistoryGeneration'>
// A wrapped undefined forwards one argument. An absent observation skips the call.
type GenerationObservation = { generation: Parameters<GenerationObserver['observeHistoryGeneration']>[0] }

function readStringGeneration(data: unknown): GenerationObservation | undefined {
  if (data && typeof data === 'object' && 'history_generation' in data) {
    const generation = data.history_generation
    if (typeof generation === 'string') return { generation }
  }
}

export function observeGeneration<T>(
  sync: GenerationObserver,
  result: Result<T>,
  readGeneration: (data: T) => GenerationObservation | undefined = readStringGeneration,
): 'accepted' | 'stale' | 'not-a-generation-result' {
  if (result.ok) {
    const observation = readGeneration(result.data)
    if (!observation) return 'not-a-generation-result'
    return sync.observeHistoryGeneration(observation.generation) ? 'accepted' : 'stale'
  }
  if (result.kind === 'http' && result.status === 409 && result.error === 'history_generation_changed') {
    sync.observeHistoryGeneration()
    return 'stale'
  }
  return 'not-a-generation-result'
}
