import { readFileSync } from 'node:fs'
import init from '../wasm/fukulow_client_core.js'
await init({ module_or_path: readFileSync(new URL('../wasm/fukulow_client_core_bg.wasm', import.meta.url)) })
