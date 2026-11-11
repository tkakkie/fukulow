import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FullResult, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter'
import { describe, expect, it, vi } from 'vitest'
import E2EReporter from './e2e-reporter.ts'
import { secretSafe } from '../e2e/helpers.ts'

const secrets = [
  'https://example.invalid/#invite=sentinel-invite-token',
  'Cookie: fukulow_session=sentinel-cookie-token',
  'Set-Cookie: __Host-fukulow_session=sentinel-set-cookie-token; HttpOnly',
  'Bearer sentinel-session-token',
  'sentinel-setup-token',
  'sentinel-password',
  'Message body sentinel-message-body',
]
const started = new Date(0)
const completed = { status: 'failed', startTime: started, duration: 30001 } as FullResult
const location = { file: resolve(import.meta.dirname, '../e2e/smoke.spec.ts'), line: 4, column: 3 }
const publishedLocation = { file: 'e2e/smoke.spec.ts', line: 4 }

async function withReporter(run: (reporter: E2EReporter, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-reporter-'))
  const output = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'debug').mockImplementation(() => {}),
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
  ]
  try {
    const reporter = new E2EReporter({ outputDir: directory })
    await run(reporter, directory)
    for (const spy of output) expect(spy).not.toHaveBeenCalled()
  } finally {
    for (const spy of output) spy.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
}

function failure(secret: string, message = secret): TestError {
  return {
    message, name: secret, value: secret, stack: secret, snippet: secret, errorContext: secret,
    location, cause: { message: secret, location: { ...location, file: secret } },
  } as TestError
}

function result(secret: string): TestResult {
  const step = {
    title: `Fill "${secret}"`, category: 'pw:api', location, subtitle: secret,
    startTime: started, duration: 47, error: failure(secret, `Timeout 30000ms exceeded. ${secret}`),
    steps: [{ title: secret, category: secret, location: { ...location, file: secret },
      startTime: started, duration: 3, steps: [], error: failure(secret, `expect(locator) ${secret}`) }],
  } as unknown as TestStep
  return {
    status: 'timedOut', startTime: started, duration: 30000,
    errors: [failure(secret, `expect(locator) ${secret}`), failure(secret)], steps: [step],
    stdout: [secret, Buffer.from(secret)], stderr: [secret, Buffer.from(secret)],
    attachments: [
      { name: 'error-context', path: secret, contentType: 'text/markdown', body: Buffer.from(secret) },
      { name: secret, path: secret, contentType: secret, body: Buffer.from(secret) },
    ],
    annotations: [{ type: secret, description: secret }],
  } as unknown as TestResult
}

function testCase(secret: string): TestCase {
  return { title: secret, location, id: secret, tags: [secret], annotations: [{ type: secret, description: secret }] } as TestCase
}

describe('restricted E2E diagnostics', () => {
  it.each(secrets)('omits sentinel payload %s from every runtime input and emits no output', async secret => {
    await withReporter(async (reporter, directory) => {
      reporter.onError(failure(secret))
      reporter.onTestEnd(testCase(secret), result(secret))
      await reporter.onEnd(completed)
      const json = await readFile(join(directory, 'report.json'), 'utf8')
      expect(json).not.toContain(secret)
      expect(json).not.toContain('sentinel-')
      expect(await readdir(directory)).toEqual(['report.json'])
      // Exact shape prevents newly serialized payload fields escaping the sentinel checks.
      expect(JSON.parse(json)).toEqual({
        status: 'failed', startTime: started.toISOString(), duration: 30001,
        tests: [{
          title: 'built app is served by the server', location: publishedLocation, status: 'timedOut',
          startTime: started.toISOString(), duration: 30000,
          errors: [
            { classification: 'assertion', location: publishedLocation },
            { classification: 'error', location: publishedLocation },
          ],
          steps: [{
            title: 'Fill', category: 'pw:api', location: publishedLocation,
            startTime: started.toISOString(), duration: 47,
            error: { classification: 'timeout', location: publishedLocation },
            steps: [{
              title: 'Step', category: 'other', startTime: started.toISOString(), duration: 3,
              error: { classification: 'assertion', location: publishedLocation }, steps: [],
            }],
          }],
        }],
        errors: [{ classification: 'error', location: publishedLocation }],
      })
    })
  })

  it('fails closed for unknown paths, statuses, categories, titles and nonnumeric timings', async () => {
    const secret = secrets.join('\n')
    await withReporter(async (reporter, directory) => {
      const entry = result(secret)
      entry.status = secret as TestResult['status']
      entry.duration = secret as unknown as number
      entry.steps[0].duration = secret as unknown as number
      entry.steps[0].category = secret
      entry.steps[0].title = secret
      const test = testCase(secret)
      test.location = { ...location, file: secret }
      reporter.onTestEnd(test, entry)
      reporter.onTestEnd({ ...test, location: { ...location, line: secret as unknown as number } } as TestCase, entry)
      await reporter.onEnd({ ...completed, status: secret, duration: secret } as unknown as FullResult)
      const json = await readFile(join(directory, 'report.json'), 'utf8')
      for (const value of secrets) expect(json).not.toContain(value)
      const report = JSON.parse(json)
      expect(report.status).toBe('unknown')
      expect(report.duration).toBe(0)
      expect(report.tests.map((entry: { title: string }) => entry.title)).toEqual(['Test', 'Test'])
      expect(report.tests[0]).toMatchObject({ status: 'unknown', duration: 0, steps: [{ title: 'Step', category: 'other', duration: 0 }] })
    })
  })

  it('leaves CI output to the built-in dot reporter and ignores all attachment/output events', () => {
    const reporter = new E2EReporter()
    expect(reporter.printsToStdio()).toBe(false)
    for (const method of ['onStdOut', 'onStdErr', 'onStepBegin', 'onStepEnd', 'onTestBegin']) {
      expect(reporter).not.toHaveProperty(method)
    }
  })

  it('keeps actual dot failure messages, call logs, source frames and artifacts free of credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-dot-'))
    const web = resolve(import.meta.dirname, '..')
    const secret = 'sentinel-runtime-cookie-token'
    try {
      await writeFile(join(directory, 'playwright.config.ts'), `
import config from ${JSON.stringify(join(web, 'playwright.config.ts'))}
export default { ...config, testDir: '.', testMatch: 'failures.spec.ts', webServer: undefined,
  outputDir: ${JSON.stringify(join(directory, 'results'))},
  reporter: [['dot'], [${JSON.stringify(join(web, 'scripts/e2e-reporter.ts'))}, { outputDir: ${JSON.stringify(join(directory, 'published'))} }]],
}
`)
      // Secrets are supplied through the environment so the source frames themselves
      // cannot expose them. No browser, database or app server is needed for this probe.
      await writeFile(join(directory, 'failures.spec.ts'), `
import { test, expect } from ${JSON.stringify(join(web, 'node_modules/@playwright/test/index.mjs'))}
import { secretSafe } from ${JSON.stringify(join(web, 'e2e/helpers.ts'))}
const secret = process.env.E2E_REPORTER_SENTINEL
test('request Cookie failure', async ({ request }) => {
  expect(process.env.PLAYWRIGHT_NO_COPY_PROMPT).toBe('1')
  const original = await request.get('http://127.0.0.1:1/', { headers: { Cookie: secret }, timeout: 100 }).catch(error => error)
  expect(original.message.includes(secret), 'Raw Playwright request diagnostics contain the Cookie value').toBe(true)
  await secretSafe(() => Promise.reject(original))
})
test('setup fill or Invite navigation failure', async () => {
  await secretSafe(() => { throw new Error(process.env.E2E_REPORTER_PAYLOADS, { cause: new Error(secret) }) })
})
test('Invite fragment assertion failure', async () => {
  await expect.poll(() => secret === 'cleared URL', { message: 'Invite fragment is removed from the URL', timeout: 1 }).toBe(true)
})
test('locator assertion ARIA context is discarded', async () => {
  const error = new Error('Synthetic locator assertion')
  error.matcherResult = { ariaSnapshot: process.env.E2E_REPORTER_PAYLOADS }
  throw error
})
`)
      const run = spawnSync(process.execPath, [join(web, 'node_modules/playwright/cli.js'), 'test', '-c', join(directory, 'playwright.config.ts')], {
        cwd: web, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, CI: '1', E2E_REPORTER_SENTINEL: secret, E2E_REPORTER_PAYLOADS: secrets.join('\n') },
      })
      expect(run.error).toBeUndefined()
      expect(run.status).toBe(1)
      const output = run.stdout + run.stderr
      expect(output).toContain('4 failed')
      expect(output).toContain('Credential-bearing operation failed (details omitted)')
      expect(output).toContain('Invite fragment is removed from the URL')
      const report = await readFile(join(directory, 'published/report.json'), 'utf8')
      const tests = JSON.parse(report).tests
      expect(tests).toHaveLength(4)
      expect(tests.slice(0, 2).map((test: { errors: object[] }) => test.errors)).toEqual([
        [{ classification: 'error', location: { file: 'e2e/helpers.ts', line: 10 } }],
        [{ classification: 'error', location: { file: 'e2e/helpers.ts', line: 10 } }],
      ])
      expect(tests[2].errors).toEqual([{ classification: 'timeout' }])
      for (const value of [secret, ...secrets]) expect((output + report).includes(value)).toBe(false)
      const files = await readdir(join(directory, 'results'), { recursive: true })
      expect(files.some(file => file.endsWith('error-context.md'))).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 30_000)
})

describe('credential-bearing E2E operations', () => {
  it.each(secrets)('replaces errors and their causes, call logs and stacks for %s', async secret => {
    const original = new Error(secret, { cause: new Error(secret) })
    const outcome = await secretSafe(() => Promise.reject(original)).catch(error => error as Error)
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome.message).toBe('Credential-bearing operation failed (details omitted)')
    expect(outcome.cause).toBeUndefined()
    expect(outcome.stack).not.toContain(secret)
  })

  it('preserves operation results and suppresses synchronous failures too', async () => {
    const value = { identity: 'unchanged' }
    expect(await secretSafe(() => value)).toBe(value)
    expect(await secretSafe(async () => value)).toBe(value)
    await expect(secretSafe(() => { throw new Error(secrets[0]) })).rejects.toThrow('Credential-bearing operation failed (details omitted)')
  })
})
