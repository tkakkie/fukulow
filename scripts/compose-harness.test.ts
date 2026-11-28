import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { poll, pollHealth, psql } from './compose-harness.ts'

const harness = new URL('./compose-harness.ts', import.meta.url)
const stdoutSecret = 'FAKE_DB_PASSWORD=stdout-fixture'
const stderrSecret = 'FAKE_DB_PASSWORD=stderr-fixture'
const childSource = `
  console.log(${JSON.stringify(stdoutSecret)})
  console.error(${JSON.stringify(stderrSecret)})
`
const failingChildSource = `${childSource}\nprocess.exitCode = 7`

function invokeRun(args: string[], options?: { failureOutput?: 'stderr' | 'both'; maxBuffer?: number }) {
  const source = `
    import { run } from ${JSON.stringify(harness.href)}
    const options = process.argv[2] === undefined ? undefined : JSON.parse(process.argv[2])
    process.stdout.write(JSON.stringify(run(process.execPath, JSON.parse(process.argv[1]), options)))
  `
  const invocation = ['--input-type=module', '--eval', source, JSON.stringify(args)]
  if (options) invocation.push(JSON.stringify(options))
  return spawnSync(process.execPath, invocation, { encoding: 'utf8' })
}

test('run suppresses both failed streams by default', () => {
  const result = invokeRun(['--eval', failingChildSource])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Command exited with status 7/)
  assert.ok(!result.stderr.includes(stdoutSecret))
  assert.ok(!result.stderr.includes(stderrSecret))
})

test('run only forwards failure output explicitly selected by the caller', () => {
  const stderr = invokeRun(['--eval', failingChildSource], { failureOutput: 'stderr' })
  assert.equal(stderr.status, 1)
  assert.equal(stderr.stdout, '')
  assert.ok(stderr.stderr.startsWith(`${stderrSecret}\n`))
  assert.ok(!stderr.stderr.includes(stdoutSecret))

  const both = invokeRun(['--eval', failingChildSource], { failureOutput: 'both' })
  assert.equal(both.status, 1)
  assert.equal(both.stdout, `${stdoutSecret}\n`)
  assert.ok(both.stderr.startsWith(`${stderrSecret}\n`))
})

test('run returns successful streams without printing them', () => {
  const result = invokeRun(['--eval', childSource])
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { stdout: `${stdoutSecret}\n`, stderr: `${stderrSecret}\n` })
})

test('run hides argument validation errors and partial output from a failed capture', () => {
  const invalidArg = invokeRun([`\0${stdoutSecret}`])
  assert.equal(invalidArg.status, 1)
  assert.equal(invalidArg.stdout, '')
  assert.match(invalidArg.stderr, /Command could not be started/)
  assert.ok(!invalidArg.stderr.includes(stdoutSecret))

  const output = JSON.stringify(stdoutSecret)
  for (const overflow of [
    invokeRun(['--eval', `process.stdout.write(${output})`], { maxBuffer: 16 }),
    invokeRun(['--eval', `process.stdout.write(${output}.repeat(100_000))`]),
  ]) {
    assert.equal(overflow.status, 1)
    assert.equal(overflow.stdout, '')
    assert.match(overflow.stderr, /Command failed to complete/)
    assert.ok(!overflow.stderr.includes(stdoutSecret))
  }
})

test('psql disables startup files and stops on the first SQL error', () => {
  const query = 'SELECT 1;'
  const invocation = psql(args => args, ['compose', 'exec', '-T', 'db'], ['-U', 'fukulow', '-d', 'fukulow', '-Atc', query])
  assert.deepEqual(invocation, ['compose', 'exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'fukulow', '-d', 'fukulow', '-Atc', query])
})

test('health polling requires HTTP 200 and an ok body', async () => {
  const observations = [undefined, { status: 503, body: 'ok' }, { status: 200, body: 'starting' }, { status: 200, body: 'ok' }]
  await pollHealth('app health', async path => {
    assert.equal(path, '/api/v1/health')
    return observations.shift()
  }, 2000)
  assert.equal(observations.length, 0)
})

test('poll stops at the deadline without making another observation', async () => {
  await assert.rejects(poll('expired', () => assert.fail('unexpected observation'), Boolean, 0), /did not converge/)
})

test('nodeImage requires the Dockerfile web stage to pin the Node tag and digest', t => {
  const root = mkdtempSync(join(tmpdir(), 'fukulow-compose-harness-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  const module = join(root, 'scripts', 'compose-harness.ts')
  copyFileSync(harness, module)
  const pin = `node:26.13.1-slim@sha256:${'a'.repeat(64)}`
  const readImage = (dockerfile: string) => {
    writeFileSync(join(root, 'Dockerfile'), dockerfile)
    return spawnSync(process.execPath, ['--input-type=module', '--eval',
      'const { nodeImage } = await import(process.argv[1]); console.log(nodeImage)', module], { encoding: 'utf8' })
  }
  const pinned = readImage(`FROM node:latest AS builder\nFROM ${pin} AS web\n`)
  assert.equal(pinned.status, 0)
  assert.equal(pinned.stdout, `${pin}\n`)
  for (const invalid of [`FROM ${pin} AS builder\n`, 'FROM node:26.13.1-slim AS web\n', `FROM ${pin.replace('26.13.1', '26')} AS web\n`]) {
    const rejected = readImage(invalid)
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /reuse the pinned Node toolchain image/)
  }
})
