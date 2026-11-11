import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import type { FullResult, Reporter, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter'

const actions = new Set(['Click', 'Fill', 'Press', 'Select', 'Navigate', 'Reload', 'GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'Expect'])
const categories = new Set(['hook', 'expect', 'pw:api', 'test.step', 'fixture', 'test.attach'])
const testStatuses = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted'])
const runStatuses = new Set(['passed', 'failed', 'timedout', 'interrupted'])

// Titles and paths come only from public repository source, never runtime titles
// (which may interpolate credentials). Dynamic declarations get a fixed title.
const sources = new Map(['e2e', 'e2e-compose'].flatMap(directory => {
  const e2eDir = resolve(import.meta.dirname, '..', directory)
  return readdirSync(e2eDir).filter(file => file.endsWith('.ts')).map(file => {
    const path = join(e2eDir, file)
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const titles = new Map<number, string>()
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
        const title = node.arguments[0]
        titles.set(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          title && ts.isStringLiteralLike(title) ? title.text : 'Parameterized test')
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return [path, { file: `${directory}/${file}`, lines: source.getLineStarts().length, titles }] as const
  })
}))

function location(value: TestError['location']) {
  if (!value) return undefined
  const source = sources.get(resolve(value.file))
  return source && Number.isSafeInteger(value.line) && value.line > 0 && value.line <= source.lines
    ? { file: source.file, line: value.line } : undefined
}

function duration(value: number) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
function startTime(value: Date) { return new Date(duration(Date.prototype.getTime.call(value))).toISOString() }

function errorSummary(error: TestError) {
  const message = error.message ?? ''
  return {
    classification: /(?:Test timeout of|Timeout) \d+ms exceeded/.test(message) ? 'timeout'
      : message.includes('expect(') ? 'assertion' : 'error',
    location: location(error.location),
  }
}

function stepSummary(step: TestStep): object {
  const action = step.title.split(/[\s"(]/, 1)[0]
  return {
    title: actions.has(action) ? action : 'Step',
    category: categories.has(step.category) ? step.category : 'other',
    location: location(step.location), startTime: startTime(step.startTime), duration: duration(step.duration),
    error: step.error && errorSummary(step.error), steps: step.steps.map(stepSummary),
  }
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

  onTestEnd(test: TestCase, result: TestResult) {
    this.tests.push({
      title: sources.get(resolve(test.location.file))?.titles.get(test.location.line) ?? 'Test',
      location: location(test.location), status: testStatuses.has(result.status) ? result.status : 'unknown',
      startTime: startTime(result.startTime), duration: duration(result.duration),
      errors: result.errors.map(errorSummary), steps: result.steps.map(stepSummary),
    })
  }

  async onEnd(result: FullResult) {
    await mkdir(this.outputDir, { recursive: true })
    await writeFile(join(this.outputDir, 'report.json'), JSON.stringify({
      status: runStatuses.has(result.status) ? result.status : 'unknown',
      startTime: startTime(result.startTime), duration: duration(result.duration),
      tests: this.tests, errors: this.errors,
    }, null, 2))
  }
}
