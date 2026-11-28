import { DetachedSendDisposition, WasmDetachedSends } from '../wasm/fukulow_client_core'
import type { Result } from './api'

export const canRestoreDraft = WasmDetachedSends.canRestoreDraft

export function createDetachedSends() {
  const core = new WasmDetachedSends()
  const slots = new Map<string, number>()
  const callbacks = new Map<number, { id: string; channel: string; restore: () => void }>()
  let nextSlot = 0

  function release(slot: number) {
    const callback = callbacks.get(slot)
    if (callback) {
      slots.delete(callback.id)
      callbacks.delete(slot)
    }
    return callback
  }

  return {
    trackSubmitted(id: string, channel: string, restore: () => void): void {
      const slot = slots.get(id) ?? nextSlot++
      core.track(slot)
      slots.set(id, slot)
      callbacks.set(slot, { id, channel, restore })
    },

    dropSubmitted(id: string): void {
      const slot = slots.get(id)
      if (slot === undefined) return
      core.forget(slot)
      release(slot)
    },

    detachSubmitted(shouldDetach: (channel: string, id: string) => boolean): void {
      for (const slot of core.attached()) {
        const callback = callbacks.get(slot)
        if (callback && shouldDetach(callback.channel, callback.id)) core.detach(slot)
      }
    },

    observeSendResult(id: string, result: Result<unknown>): void {
      const slot = slots.get(id)
      if (slot === undefined) return
      const status = !result.ok && result.kind === 'http'
        ? typeof result.status === 'number' ? result.status : NaN
        : undefined
      const decision = core.observe(slot, result.ok, status)
      switch (decision) {
        case DetachedSendDisposition.Keep: break
        case DetachedSendDisposition.Drop: release(slot); break
        case DetachedSendDisposition.Restore: release(slot)?.restore(); break
        default: throw new Error(`Unknown detached send disposition: ${decision}`)
      }
    },

    reset() {
      for (const slot of core.reset()) release(slot)
    },
  }
}
