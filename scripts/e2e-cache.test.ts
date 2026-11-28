import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Comment lines removed, so the structure checks see only YAML.
const read = (file: string) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')
  .replace(/^ *#.*\n/gm, '')
const steps = (workflow: string) => [...workflow.matchAll(/^ {6}- (?:uses|run): (\S+(?: \S+)*?)(?:\s+#.*)?$/gm)]
  .map(match => match[1])
// rust-cache keys on the job id and on CARGO*/RUST*/CC* environment variables (Swatinem/rust-cache v2).
const cacheEnv = (workflow: string) => [...workflow.matchAll(/^ {6}((?:CARGO|RUST|CC|CFLAGS|CXX|CMAKE)\w*): (.+)$/gm)]
  .map(match => `${match[1]}=${match[2]}`)

test('main saves the smoke rust-cache with the same job id, env and build steps as the PR smoke (#926)', () => {
  const smoke = read('e2e.yml')
  const cache = read('e2e-cache.yml')
  assert.match(smoke, /^on:\n  pull_request:\n/m)
  assert.match(cache, /^on:\n  push:\n    branches: \[main\]\npermissions:\n  contents: read\njobs:\n  smoke:\n/m)
  assert.match(smoke, /^jobs:\n  smoke:\n/m)
  assert.deepEqual(cacheEnv(cache), cacheEnv(smoke))
  const build = steps(smoke)
  const end = build.indexOf('cargo build --locked')
  assert.ok(end > 0)
  assert.deepEqual(steps(cache), build.slice(0, end + 1))
  // PR smoke runs never save: their entries help only reruns of that PR.
  assert.match(smoke, /Swatinem\/rust-cache@v2\n(?: {8}#.*\n)? {8}with: \{ save-if: false \}/)
  assert.match(cache, /Swatinem\/rust-cache@v2\n {8}with: \{ save-if: "\$\{\{ github\.ref == 'refs\/heads\/main' \}\}" \}/)
  assert.doesNotMatch(cache, /playwright|DATABASE_URL|secrets\.|ACTIONS_/i)
})
