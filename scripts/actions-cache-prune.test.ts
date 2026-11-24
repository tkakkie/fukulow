import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { prune, rustIdle, selectPrunable, type CacheEntry } from './actions-cache-prune.ts'

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

test('keeps the newest key of every job, Docker layers, indexes and other refs', () => {
  const lone = entry('v0-rust-smoke-Linux-x64-e8cccbc8-8973a522', 300 * hour, 300 * hour)
  const prOld = entry('v0-rust-smoke-Linux-x64-e8cccbc8-1e211b3d', 300 * hour, 300 * hour, 'refs/pull/9/merge')
  const prNew = entry('v0-rust-smoke-Linux-x64-e8cccbc8-8973a522', 200 * hour, 200 * hour, 'refs/pull/9/merge')
  const others = ['buildkit-blob-1-sha256:01', 'index-docker-1-f921bd05#1', 'node-cache-Linux-x64-npm-1',
    'gitleaks-cache-8.24.3', 'v0-rust-lint-other'].map(key => entry(key, 300 * hour, 300 * hour))
  assert.deepEqual(selectPrunable([lone, prOld, prNew, ...others], now), [])
})

test('an unreadable timestamp keeps the entry; a duplicate listing is deleted once', () => {
  const unread = { ...entry('v0-rust-lint-Linux-x64-e8cccbc8-1e211b3d', 48 * hour, 0), last_accessed_at: '' }
  const unborn = { ...entry('v0-rust-lint-Linux-x64-e8cccbc8-0e211b3d', 48 * hour, 48 * hour), created_at: 'x' }
  const current = entry('v0-rust-lint-Linux-x64-e8cccbc8-8973a522', hour, hour)
  assert.deepEqual(selectPrunable([unread, unborn, current], now), [])
  const old = entry('v0-rust-checks-Linux-x64-e8cccbc8-1e211b3d', 48 * hour, 48 * hour)
  const checks = entry('v0-rust-checks-Linux-x64-e8cccbc8-8973a522', hour, hour)
  assert.deepEqual(selectPrunable([old, checks, { ...old }], now), [old])
})

test('an entry already gone does not stop the others; any other failure does', () => {
  const [a, b] = [entry('v0-rust-a-Linux-x64-00000000-00000000', 1, 1), entry('v0-rust-b-Linux-x64-00000000-00000000', 1, 1)]
  const calls: string[] = []
  const gone = Object.assign(new Error('gh failed'), { stderr: 'gh: Not Found (HTTP 404)' })
  prune(args => { calls.push(args.at(-1)!); if (calls.length === 1) throw gone; return '' }, 'o/r', [a, b], () => {})
  assert.deepEqual(calls, [`repos/o/r/actions/caches/${a.id}`, `repos/o/r/actions/caches/${b.id}`])
  const denied = Object.assign(new Error('gh failed'), { stderr: 'gh: Forbidden (HTTP 403)' })
  assert.throws(() => prune(() => { throw denied }, 'o/r', [a, b], () => {}), /gh failed/)
})

const workflows = new URL('../.github/workflows/', import.meta.url)
const read = (file: string) => readFileSync(new URL(file, workflows), 'utf8')

// Keys of the mapping under `parent` (a top-level key), at `indent`, skipping comments and blank lines.
function childKeys(workflow: string, parent: string, indent: number): string[] {
  const lines = workflow.split('\n')
  const start = lines.indexOf(`${parent}:`)
  assert.ok(start >= 0, `${parent}: must be a block mapping`)
  const keys: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!line.startsWith(' ')) break
    const key = line.match(new RegExp(`^ {${indent}}([^\\s:#]+):`))?.[1]
    if (key) keys.push(key)
  }
  return keys
}

function checkPruneWorkflow(workflow: string) {
  assert.deepEqual(workflow.split('\n').filter(line => /^[^\s#]/.test(line)).map(line => line.split(':')[0]),
    ['name', 'on', 'permissions', 'concurrency', 'jobs'])
  assert.match(workflow, /^permissions: \{\}$/m, 'the workflow grants nothing; only the job holds the token')
  assert.deepEqual(childKeys(workflow, 'on', 2), ['schedule', 'workflow_dispatch'],
    'no pull_request, push or workflow_run trigger may reach the write token')
  assert.deepEqual(childKeys(workflow, 'jobs', 2), ['prune'], 'one job holds the write token')
  assert.match(workflow, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m, 'only main code may hold the write token')
  assert.deepEqual([...workflow.matchAll(/actions:\s*write/g)].map(match => match.index),
    [workflow.indexOf('\n      actions: write\n') + 7], 'actions: write only in the job permissions')
  assert.deepEqual([...workflow.matchAll(/\buses:\s*(.+)$/gm)].map(match => match[1]), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0'], 'only SHA-pinned checkout and setup-node')
  assert.match(workflow, /checkout@\S+ # v7\.0\.1\n {8}with: \{ persist-credentials: false \}/)
  assert.deepEqual([...workflow.matchAll(/\brun:\s*(.*)$/gm)].map(match => match[1]),
    ['node scripts/actions-cache-prune.ts --apply'])
  assert.deepEqual([...workflow.matchAll(/\$\{\{([^}]*)\}\}/g)].map(match => match[1].trim()), ['github.token'],
    'the token reaches only the prune step')
  assert.doesNotMatch(workflow, /secrets\.|npm|npx|\bref:|\btoken:/)
}

test('only the prune job holds actions: write, and it runs no untrusted code', () => {
  for (const file of readdirSync(workflows).filter(file => file !== 'cache-prune.yml')) {
    assert.doesNotMatch(read(file), /actions:\s*write|write-all/, file)
  }
  const workflow = read('cache-prune.yml')
  checkPruneWorkflow(workflow)
  const step = '      - name: Delete superseded rust-cache keys\n'
  for (const [name, mutated] of [
    ['second job', `${workflow}  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`],
    ['named action step', workflow.replace(step, `      - name: Other\n        uses: other/action@v1\n${step}`)],
    ['unnamed run step', workflow.replace(step, `      - run: echo\n${step}`)],
    ['trigger after a comment', workflow.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  # note\n\n  pull_request:\n')],
    ['workflow-level grant', workflow.replace('permissions: {}', 'permissions:\n  actions: write')],
    ['tag-pinned action', workflow.replace('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7')],
    ['persisted token', workflow.replace('persist-credentials: false', 'persist-credentials: true')],
    ['any branch', workflow.replace("    if: github.ref == 'refs/heads/main'\n", '')],
  ]) assert.throws(() => checkPruneWorkflow(mutated), assert.AssertionError, name)
})
