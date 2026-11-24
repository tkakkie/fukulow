// Run after the CI smoke suite: node web/scripts/check-e2e-invariants.ts
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseInvariants } from './check-invariants.ts'

const statuses = new Set(['passed', 'failed', 'skipped', 'interrupted', 'timedOut'])
type Entry = { file: string | null; titlePath: string[] | null; status: string; expectedStatusPassed: boolean; annotations: { type: string }[] }

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Entry
  return (entry.file === null || typeof entry.file === 'string')
    && (entry.titlePath === null || (Array.isArray(entry.titlePath) && entry.titlePath.length > 0
      && entry.titlePath.every(title => typeof title === 'string')))
    && typeof entry.expectedStatusPassed === 'boolean'
    && statuses.has(entry.status) && Array.isArray(entry.annotations)
    && entry.annotations.every(annotation => annotation && typeof annotation.type === 'string')
}

/** Uses the static check's row parser and its file::leaf-title identity (suite
 * titles are retained in the report; multiple matches are deliberately refused).
 * A final pass after retry counts, but skip/fixme/fail annotations and expected failures never do.
 */
export function checkE2EInvariants(root: string, reportPath = join(root, 'web/test-results/ci-diagnostics/invariants.json')): string[] {
  const refs: { at: string; name: string }[] = []
  const errors: string[] = []
  const directory = join(root, 'docs/invariants')
  for (const file of readdirSync(directory).filter(file => file.endsWith('.md')).sort()) {
    const parsed = parseInvariants(readFileSync(join(directory, file), 'utf8'))
    errors.push(...parsed.errors.map(error => `docs/invariants/${file}: ${error}`))
    for (const row of parsed.rows) for (const name of row.names)
      if (name.startsWith('web/e2e/')) refs.push({ at: `docs/invariants/${file}:${row.line} (${row.rule})`, name })
  }
  let tests: Entry[]
  try {
    const report: unknown = JSON.parse(readFileSync(reportPath, 'utf8'))
    if (!report || typeof report !== 'object' || !('version' in report) || report.version !== 1
      || !('tests' in report) || !Array.isArray(report.tests) || !report.tests.every(isEntry)) throw new Error('invalid report')
    tests = report.tests
  } catch {
    const reason = 'missing or malformed E2E invariants report'
    return [...errors, reason, ...refs.map(ref => `${ref.at}: ${ref.name}: ${reason}`)]
  }
  for (const { at, name } of refs) {
    const matches = tests.filter(test => test.file !== null && test.titlePath !== null
      && `${test.file}::${test.titlePath.at(-1)}` === name)
    const reason = matches.length === 0 ? 'missing from E2E report'
      : matches.length !== 1 ? `duplicated title (${matches.length} report entries)`
      : matches[0].status !== 'passed' ? `final status ${matches[0].status}`
      : !matches[0].expectedStatusPassed ? 'expected status is not passed'
      : matches[0].annotations.some(annotation => ['skip', 'fixme', 'fail'].includes(annotation.type)) ? 'skip/fixme/fail annotation'
      : undefined
    if (reason) errors.push(`${at}: ${name}: ${reason}`)
  }
  return errors
}

if (import.meta.main) {
  const errors = checkE2EInvariants(resolve(import.meta.dirname, '../..'), process.argv[2])
  for (const error of errors) console.error(error)
  if (errors.length) process.exit(1)
}
