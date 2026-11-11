import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { FullResult, Reporter, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter'

// Raw Playwright reports include config/env, request data, fill values and source.
// Publish only this projection; keep payloads, subtitles, stacks and output private.
const actions = new Set(['Click', 'Fill', 'Press', 'Select', 'Navigate', 'Reload', 'GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'Expect'])
function stepTitle(step: TestStep) {
  const action = step.title.split(/[\s"(]/, 1)[0]
  return actions.has(action) ? action : step.category
}

function location(value: TestError['location']) {
  return value && { file: relative(process.cwd(), value.file), line: value.line, column: value.column }
}

function errorSummary(error: TestError) {
  // Even assertion first lines can contain payloads; dot keeps full CI log errors.
  const message = error.message ?? ''
  const timeout = /(?:Test timeout of|Timeout) (\d+)ms exceeded/.exec(message)
  return {
    message: timeout ? `Timeout after ${timeout[1]}ms` : message.includes('expect(') ? 'Assertion failed' : 'Error (details omitted)',
    location: location(error.location),
  }
}

function stepSummary(step: TestStep): object {
  return {
    title: stepTitle(step), category: step.category, location: location(step.location),
    startTime: step.startTime.toISOString(), duration: step.duration,
    error: step.error && errorSummary(step.error), steps: step.steps.map(stepSummary),
  }
}

export function snapshotOnly(context: string): string {
  // error-context.md also contains errors and a ~200-line test source excerpt.
  const snapshot = /# Page snapshot\r?\n\r?\n```yaml\r?\n([\s\S]*?)\r?\n```/.exec(context)?.[1]
  if (!snapshot) return '# Page snapshot\n\nSnapshot unavailable.\n'
  const lines: string[] = []
  let hiddenBelow: number | undefined
  for (const line of snapshot.split('\n')) {
    const indent = line.search(/\S/)
    if (hiddenBelow !== undefined && (indent > hiddenBelow || indent === -1)) continue
    hiddenBelow = undefined
    // Invite links are readonly textboxes; setup tokens are also form values.
    const field = /^(\s*)- ((?:textbox|searchbox|combobox)(?: "(?:\\.|[^"\\])*")?(?: \[[^\]]*\])*)(?::|$)/.exec(line)
    if (field) {
      lines.push(`${field[1]}- ${field[2]}: [value omitted]`)
      hiddenBelow = indent
    } else if (/^\s*- ["']?(?:textbox|searchbox|combobox)\b/.test(line) || /^\s*- \/(?:url|placeholder):/.test(line)) {
      lines.push(`${' '.repeat(indent)}- [value omitted]`)
      hiddenBelow = indent
    } else {
      lines.push(line)
    }
  }
  return `# Page snapshot\n\n\`\`\`yaml\n${lines.join('\n')}\n\`\`\`\n`
}

export default class E2EReporter implements Reporter {
  private tests: object[] = []
  private errors: object[] = []
  private outputDir: string

  constructor(options: { outputDir?: string } = {}) {
    this.outputDir = options.outputDir ?? 'test-results/ci-diagnostics'
  }

  printsToStdio() { return false }

  onError(error: TestError) { this.errors.push(errorSummary(error)) }

  async onTestEnd(test: TestCase, result: TestResult) {
    const index = this.tests.length
    this.tests.push({
      title: test.title, location: location(test.location), status: result.status,
      startTime: result.startTime.toISOString(), duration: result.duration,
      errors: result.errors.map(errorSummary), steps: result.steps.map(stepSummary),
    })
    if (result.status === test.expectedStatus) return
    const context = result.attachments.find(a => a.name === 'error-context' && a.path)
    if (!context?.path) return
    const destination = join(this.outputDir, `test-${index}`, 'error-context.md')
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, snapshotOnly(await readFile(context.path, 'utf8')))
  }

  async onEnd(result: FullResult) {
    await mkdir(this.outputDir, { recursive: true })
    await writeFile(join(this.outputDir, 'report.json'), JSON.stringify({
      status: result.status, startTime: result.startTime.toISOString(), duration: result.duration,
      tests: this.tests, errors: this.errors,
    }, null, 2))
  }
}
