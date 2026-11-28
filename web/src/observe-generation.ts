import { normalizedFailure, readHistoryGeneration, type Result } from './api'
import { isGenerationConflict } from './core-wasm'
import type { createSync } from './sync'

type GenerationObserver = Pick<ReturnType<typeof createSync>, 'observeHistoryGeneration'>
// A wrapped undefined forwards one argument. An absent observation skips the call.
type GenerationObservation = { generation: Parameters<GenerationObserver['observeHistoryGeneration']>[0] }

export function observeGeneration<T>(
  sync: GenerationObserver,
  result: Result<T>,
  readGeneration: (data: T) => GenerationObservation | undefined = readHistoryGeneration,
): 'accepted' | 'stale' | 'not-a-generation-result' {
  if (result.ok) {
    const observation = readGeneration(result.data)
    if (!observation) return 'not-a-generation-result'
    return sync.observeHistoryGeneration(observation.generation) ? 'accepted' : 'stale'
  }
  if (isGenerationConflict(normalizedFailure(result))) {
    sync.observeHistoryGeneration()
    return 'stale'
  }
  return 'not-a-generation-result'
}
