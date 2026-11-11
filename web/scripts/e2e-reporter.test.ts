import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FullResult, TestCase, TestResult, TestStep } from '@playwright/test/reporter'
import { describe, expect, it, vi } from 'vitest'
import E2EReporter, { snapshotOnly } from './e2e-reporter.ts'

describe('restricted E2E diagnostics', () => {
  it('keeps only the ARIA snapshot, omitting field values, descendants, URLs, errors and source', () => {
    const context = `# Error details
password-in-error
# Page snapshot

\`\`\`yaml
- heading "Channel" [level=2]
- textbox "セットアップトークン": setup-secret
- textbox "メッセージ" [disabled]: |
    multiline-secret
    another-secret
- textbox "招待リンク":
  - text: invite-secret
- 'textbox "label: special"': quoted-field-secret
- link "メッセージへ移動":
  - /url: |
      url-secret
  - text: メッセージへ移動
- alert: このチャンネルは利用できません。
\`\`\`
# Test source
cookie-in-source
`
    const snapshot = snapshotOnly(context)
    expect(snapshot).toContain('- heading "Channel" [level=2]')
    expect(snapshot).toContain('- textbox "メッセージ" [disabled]: [value omitted]')
    expect(snapshot).toContain('- alert: このチャンネルは利用できません。')
    expect(snapshot).not.toMatch(/secret|password-in-error|cookie-in-source|Test source|Error details/)
    expect(snapshotOnly('# Error details\nsecret')).toBe('# Page snapshot\n\nSnapshot unavailable.\n')
  })

  it('writes timing, action and error summaries without serializing credentials or arbitrary attachments/output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e2e-reporter-'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const rawContext = join(directory, 'raw-context.md')
      await writeFile(rawContext, '# Page snapshot\n\n```yaml\n- textbox "招待リンク": invite-secret\n```\n# Test source\nsource-secret')
      const outputDir = join(directory, 'published')
      const reporter = new E2EReporter({ outputDir })
      const location = { file: join(process.cwd(), 'e2e/example.spec.ts'), line: 12, column: 3 }
      const step = {
        title: 'Fill "password-secret"', subtitle: 'cookie-secret', category: 'pw:api', location,
        startTime: new Date(0), duration: 47, steps: [],
        error: { message: 'locator.fill: Test timeout of 30000ms exceeded. token-secret', location, stack: 'stack-secret' },
      } as unknown as TestStep
      const test = { title: 'static test title', expectedStatus: 'passed', location } as TestCase
      const result = {
        status: 'timedOut', startTime: new Date(0), duration: 30000,
        errors: [step.error, { message: 'expect(locator).toBeVisible() received token-secret', snippet: 'snippet-secret' }],
        steps: [step], stdout: ['stdout-secret'], stderr: ['stderr-secret'],
        attachments: [
          { name: 'error-context', path: rawContext, contentType: 'text/markdown' },
          { name: 'trace', path: 'trace-secret', body: Buffer.from('body-secret') },
        ],
      } as unknown as TestResult
      reporter.onError({ message: 'global-secret', stack: 'global-stack-secret', location })
      await reporter.onTestEnd(test, result)
      await reporter.onEnd({ status: 'failed', startTime: new Date(0), duration: 30001 } as FullResult)
      const json = await readFile(join(outputDir, 'report.json'), 'utf8')
      const snapshot = await readFile(join(outputDir, 'test-0/error-context.md'), 'utf8')
      expect(json + snapshot + JSON.stringify(log.mock.calls)).not.toContain('secret')
      const report = JSON.parse(json)
      expect(report.tests[0].steps[0]).toMatchObject({ title: 'Fill', duration: 47, error: { message: 'Timeout after 30000ms', location: { line: 12 } } })
      expect(report.tests[0].errors[1].message).toBe('Assertion failed')
      expect(report.errors[0].message).toBe('Error (details omitted)')
      // A passing test gets a report entry but no copied failure snapshot.
      await reporter.onTestEnd(test, { ...result, status: 'passed' })
      await expect(readFile(join(outputDir, 'test-1/error-context.md'))).rejects.toThrow()
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('leaves CI output to the built-in dot reporter', () => {
    const reporter = new E2EReporter()
    expect(reporter.printsToStdio()).toBe(false)
    expect(reporter).not.toHaveProperty('onStdOut')
    expect(reporter).not.toHaveProperty('onStdErr')
  })
})
