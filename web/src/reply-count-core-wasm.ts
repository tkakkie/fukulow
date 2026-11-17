import { WasmReplyCounts } from '../wasm/fukulow_client_core'
import type { CountCore } from './reply-count-core'
export function createReplyCountCore(): CountCore {
  const core = new WasmReplyCounts()
  return { step: input => JSON.parse(core.step(JSON.stringify(input))), free: () => core.free() }
}
