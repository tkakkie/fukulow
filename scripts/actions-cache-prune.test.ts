import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { blobIdle, rustIdle, selectPrunable, type CacheEntry } from './actions-cache-prune.ts'

const now = Date.parse('2026-11-24T12:00:00Z')
const ago = (ms: number) => new Date(now - ms).toISOString()
const hour = 3_600_000
let id = 0
const entry = (key: string, created: number, accessed: number, ref = 'refs/heads/main'): CacheEntry =>
  ({ id: ++id, key, ref, size_in_bytes: 1, created_at: ago(created), last_accessed_at: ago(accessed) })
const keys = (list: CacheEntry[]) => list.map(item => item.key).sort()

test('deletes a superseded rust-cache key only once no run restored it for a day', () => {
  const old = entry('v0-rust-lint-Linux-x64-e8cccbc8-1e211b3d', 48 * hour, rustIdle + hour)
  const current = entry('v0-rust-lint-Linux-x64-e8cccbc8-8973a522', 30 * hour, 40 * hour)
  const oldEnv = entry('v0-rust-checks-Linux-x64-aaaaaaaa-8973a522', 48 * hour, rustIdle + hour)
  const checks = entry('v0-rust-checks-Linux-x64-bbbbbbbb-8973a522', 2 * hour, hour)
  const stillRead = entry('v0-rust-server-tests-Linux-x64-e8cccbc8-1e211b3d', 48 * hour, rustIdle - hour)
  const serverTests = entry('v0-rust-server-tests-Linux-x64-e8cccbc8-8973a522', 2 * hour, hour)
  assert.deepEqual(keys(selectPrunable([old, current, oldEnv, checks, stillRead, serverTests], now)),
    [oldEnv.key, old.key].sort())
})

test('keeps the newest key of every job even when idle, and never touches other refs', () => {
  const lone = entry('v0-rust-smoke-Linux-x64-e8cccbc8-8973a522', 300 * hour, 300 * hour)
  const prOld = entry('v0-rust-smoke-Linux-x64-e8cccbc8-1e211b3d', 300 * hour, 300 * hour, 'refs/pull/9/merge')
  const prNew = entry('v0-rust-smoke-Linux-x64-e8cccbc8-8973a522', 200 * hour, 200 * hour, 'refs/pull/9/merge')
  const prBlob = entry('buildkit-blob-1-sha256:aa', 300 * hour, 300 * hour, 'refs/pull/9/merge')
  const index = entry('index-docker-1-f921bd05#1', 1, 1, 'refs/pull/9/merge')
  assert.deepEqual(selectPrunable([lone, prOld, prNew, prBlob, index], now), [])
})

test('deletes layer blobs no build read for four days, never indexes or blobs of an export in progress', () => {
  const index = entry('index-docker-1-f921bd05#1082', 2 * hour, hour)
  const oldIndex = entry('index-docker-1-f921bd05#900', 200 * hour, 200 * hour)
  const idle = entry('buildkit-blob-1-sha256:01', 200 * hour, blobIdle + hour)
  const read = entry('buildkit-blob-1-sha256:02', 200 * hour, blobIdle - hour)
  // Written after the newest index: the next export may still reference it.
  const inFlight = entry('buildkit-blob-1-sha256:03', hour, blobIdle + hour)
  const others = ['node-cache-Linux-x64-npm-1', 'gitleaks-cache-8.24.3', 'v0-rust-lint-other']
    .map(key => entry(key, 300 * hour, 300 * hour))
  assert.deepEqual(keys(selectPrunable([index, oldIndex, idle, read, inFlight, ...others], now)), [idle.key])
})

test('an unreadable timestamp keeps the entry', () => {
  const blob = { ...entry('buildkit-blob-1-sha256:04', 200 * hour, 200 * hour), last_accessed_at: '' }
  const index = entry('index-docker-1-f921bd05#1', hour, hour)
  assert.deepEqual(selectPrunable([blob, index], now), [])
})

test('only the prune job holds actions: write, and it runs no untrusted code', () => {
  const read = (file: string) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')
  for (const file of readdirSync(new URL('../.github/workflows/', import.meta.url))) {
    if (file !== 'cache-prune.yml') assert.doesNotMatch(read(file), /actions:\s*write|write-all/, file)
  }
  const workflow = read('cache-prune.yml')
  const triggers = workflow.match(/^on:\n((?: {2}.*\n)+)/m)?.[1] ?? ''
  assert.deepEqual([...triggers.matchAll(/^ {2}(\w+):/gm)].map(match => match[1]), ['schedule', 'workflow_dispatch'],
    'no pull_request, push or workflow_run trigger may reach the write token')
  assert.deepEqual([...workflow.matchAll(/^ {6}- uses: (\S+)/gm)].map(match => match[1]),
    ['actions/checkout@v7', 'actions/setup-node@v7'])
  assert.match(workflow, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m, 'only main code may hold the write token')
  assert.match(workflow, /checkout@v7\n {8}with: \{ persist-credentials: false \}/)
  assert.deepEqual([...workflow.matchAll(/^ {8}run: (.+)$/gm)].map(match => match[1]),
    ['node scripts/actions-cache-prune.ts --apply'])
  assert.equal([...workflow.matchAll(/github\.token|secrets\./g)].length, 1, 'the token reaches only the prune step')
  assert.doesNotMatch(workflow, /npm|npx|ref:/)
})
