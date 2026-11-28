import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
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

test('run suppresses timeout diagnostics and forwards partial output only by opt-in', () => {
  const arg = 'FAKE_DB_PASSWORD=timeout-arg'
  const input = 'FAKE_DB_PASSWORD=timeout-input'
  const envValue = 'FAKE_DB_PASSWORD=timeout-env'
  const child = `
    const { readFileSync, writeSync } = require('node:fs')
    writeSync(1, [process.argv[1], readFileSync(0, 'utf8'), process.env.TEST_PASSWORD, ${JSON.stringify(stdoutSecret)}].join('\\n'))
    writeSync(2, ${JSON.stringify(stderrSecret)})
    setTimeout(() => {}, 2000)
  `
  const parent = `
    import { writeSync } from 'node:fs'
    import { inspect } from 'node:util'
    import { run } from ${JSON.stringify(harness.href)}
    const [args, options] = JSON.parse(process.argv[1])
    try {
      run(process.execPath, args, options)
    } catch (error) {
      writeSync(3, inspect(error, { showHidden: true, depth: null }))
      process.exitCode = 1
    }
  `
  for (const failureOutput of [undefined, 'stderr', 'both']) {
    const args = ['--eval', child, arg]
    const options = { timeout: 1000, input, env: { TEST_PASSWORD: envValue }, failureOutput }
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', parent, JSON.stringify([args, options])],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 5000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    const thrown = result.output[3]
    assert.ok(thrown !== null)
    assert.match(thrown, /^Error: Command failed to complete\n/)
    for (const secret of [arg, input, envValue, stdoutSecret, stderrSecret]) {
      assert.ok(!thrown.includes(secret), 'the thrown error exposes a secret')
    }
    assert.equal(result.stdout, failureOutput === 'both' ? [arg, input, envValue, stdoutSecret].join('\n') : '')
    assert.equal(result.stderr, failureOutput === undefined ? '' : stderrSecret)
  }
})

function fakeDocker(t: TestContext, source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-compose-docker-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'docker'), `#!/usr/bin/env node\n${source}`, { mode: 0o700 })
  return { PATH: [directory, dirname(process.execPath)].join(delimiter) }
}

test('psql disables startup files and stops on the first SQL error', t => {
  const query = 'SELECT 1;'
  const env = fakeDocker(t, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const { stdout } = psql(['compose', 'exec', '-T', 'db'], ['-U', 'fukulow', '-d', 'fukulow', '-Atc', query], { env })
  const invocation = JSON.parse(stdout)
  assert.deepEqual(invocation, ['compose', 'exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'fukulow', '-d', 'fukulow', '-Atc', query])
})

test('check-db-roles suppresses failed Docker and psql output', t => {
  const script = fileURLToPath(new URL('./check-db-roles.ts', import.meta.url))
  for (const failedCommand of ['compose', 'psql']) {
    const env = fakeDocker(t, `
      const args = process.argv.slice(2)
      if (args[0] === ${JSON.stringify(failedCommand)} || args[2] === ${JSON.stringify(failedCommand)}) {
        console.log(${JSON.stringify(stdoutSecret)})
        console.error(${JSON.stringify(stderrSecret)})
        process.exitCode = 42
      } else if (args[0] === 'compose' && args.includes('config')) {
        console.log(JSON.stringify({ services: { db: { image: 'fixture', command: ['postgres'] } } }))
      } else if (!['network', 'run', 'rm'].includes(args[0]) && args[2] !== 'pg_isready') {
        process.exitCode = 99
      }
    `)
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Error: Command exited with status 42/)
    assert.equal(result.stdout, '')
    for (const secret of [stdoutSecret, stderrSecret]) assert.ok(!result.stderr.includes(secret))
  }
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
