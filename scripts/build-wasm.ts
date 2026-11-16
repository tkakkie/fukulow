import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
// The TS rollback must build without the wasm toolchain (tests still compare both, so they keep building it).
if (process.argv.includes('--unless-ts') && process.env.SYNC_CORE === 'ts') {
  console.log('SYNC_CORE=ts: wasm build skipped')
  process.exit(0)
}
const version = readFileSync(new URL('../client-core/Cargo.toml', import.meta.url), 'utf8').match(/wasm-bindgen = \{ version = "=([^"]+)"/)?.[1]
function run(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${cmd} failed (${result.status})`)
  return result.stdout.trim()
}
if (run('wasm-bindgen', ['--version']) !== `wasm-bindgen ${version}`) throw new Error(`Install wasm-bindgen-cli ${version} with --locked`)
run('cargo', ['build', '--locked', '--release', '-p', 'fukulow-client-core', '--features', 'wasm', '--target', 'wasm32-unknown-unknown'])
run('wasm-bindgen', ['--target', 'web', '--out-dir', 'web/wasm', 'target/wasm32-unknown-unknown/release/fukulow_client_core.wasm'])
console.log(`Built wasm core (wasm-bindgen ${version})`)
