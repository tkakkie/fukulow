import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import type { FullResult, Reporter, Suite, TestCase, TestError, TestResult, TestStep } from '@playwright/test/reporter'

const actions = new Set(['Click', 'Fill', 'Press', 'Select', 'Navigate', 'Reload', 'GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'Expect'])
const categories = new Set(['hook', 'expect', 'pw:api', 'test.step', 'fixture', 'test.attach'])
const testStatuses = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted'])
const runStatuses = new Set(['passed', 'failed', 'timedout', 'interrupted'])

// Titles and paths come only from public repository source, never runtime titles
// (which may interpolate credentials). Dynamic declarations get a fixed title.
const sources = new Map(['e2e', 'e2e-compose'].flatMap(directory => {
  const e2eDir = resolve(import.meta.dirname, '..', directory)
  return readdirSync(e2eDir, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts') && !/(?:^|\/)\.env(?:\.|\/|$)/.test(file)).map(file => {
    const path = join(e2eDir, file)
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const { titles, titlePaths } = sourceTitles(source)
    return [path, { file: `${directory}/${file}`, lines: source.getLineStarts().length, titles, titlePaths }] as const
  })
}))

export function sourceTitles(source: ts.SourceFile) {
  const titles = new Map<number, string[]>()
  const titlePaths = new Map<number, string[][]>()
  function visit(node: ts.Node, parents: string[] = []) {
    let path = parents
    const members: string[] = []
    let callee = ts.isCallExpression(node) ? node.expression : undefined
    while (callee && ts.isPropertyAccessExpression(callee)) {
      members.unshift(callee.name.text)
      callee = callee.expression
    }
    const declaration = ts.isCallExpression(node) && callee && ts.isIdentifier(callee) && callee.text === 'test'
    if (declaration && members.includes('describe')) {
      const title = node.arguments[0]
      path = [...parents, title && ts.isStringLiteralLike(title) ? title.text : 'Parameterized suite']
    }
    if (declaration && !members.includes('describe')) {
      const title = node.arguments[0]
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      if (members.length === 0) titles.set(line, [...(titles.get(line) ?? []),
        title && ts.isStringLiteralLike(title) ? title.text : 'Parameterized test'])
      if (title && ts.isStringLiteralLike(title)) titlePaths.set(line, [...(titlePaths.get(line) ?? []), [...parents, title.text]])
    }
    ts.forEachChild(node, child => visit(child, path))
  }
  visit(source)
  return { titles, titlePaths }
}

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
  private finalTests = new Map<TestCase, object>()
  private errors: object[] = []
  private outputDir: string

  constructor(options: { outputDir?: string } = {}) {
    this.outputDir = options.outputDir ?? 'test-results/ci-diagnostics'
  }

  printsToStdio() { return false }

  onError(error: TestError) { this.errors.push(errorSummary(error)) }

  onTestEnd(test: TestCase, result: TestResult) {
    const source = sources.get(resolve(test.location.file))
    const candidates = source?.titlePaths.get(test.location.line) ?? []
    const path = [test.title]
    for (let suite: Suite | undefined = test.parent; suite?.type === 'describe'; suite = suite.parent) path.unshift(suite.title)
    // Compare runtime identity to public source before publishing any title. Never
    // turn an unknown runtime title into an apparently passing source title.
    const matches = candidates.filter(expected => JSON.stringify(expected) === JSON.stringify(path))
    const titlePath = matches.length === 1 ? matches[0] : null
    const titles = source?.titles.get(test.location.line) ?? []
    this.finalTests.set(test, {
      file: source ? `web/${source.file}` : null, titlePath,
      status: testStatuses.has(result.status) ? result.status : 'unknown',
      expectedStatusPassed: test.expectedStatus === 'passed',
      annotations: [...test.annotations, ...result.annotations].map(annotation => ({
        type: ['skip', 'fixme', 'fail', 'slow'].includes(annotation.type) ? annotation.type : 'other',
      })),
    })
    this.tests.push({
      title: titles.length === 1 ? titles[0] : titlePath?.at(-1) ?? 'Test',
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
    // One entry per TestCase, updated after each attempt: a retried final pass counts.
    await writeFile(join(this.outputDir, 'invariants.json'), JSON.stringify({
      version: 1, tests: [...this.finalTests.values()],
    }, null, 2))
  }
}
