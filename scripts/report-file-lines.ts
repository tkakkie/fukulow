// Report-only list of tracked files over the line-count guidance (#851, AGENTS.md "Tier 2, files").
// Over the guidance means "check the responsibility", not "split", so this never fails a build.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

export const GUIDANCE = { product: 600, test: 1_000 } as const
export type Kind = keyof typeof GUIDANCE
export type Row = { path: string, kind: Kind, lines: number, changed: boolean }

const SOURCE = /\.(rs|ts|svelte)$/
const TEST_DIR = /(^|\/)(tests?|e2e)\//
const TEST_NAME = /(^|[._-])tests?([._-]|$)|test_support|\.spec\./
// Matches the markers that generators write in a file's first lines (e.g. openapi-typescript).
const GENERATED = /auto-?generated|@generated|do not edit/i

export const kindOf = (path: string): Kind =>
  TEST_DIR.test(path) || TEST_NAME.test(path.slice(path.lastIndexOf('/') + 1)) ? 'test' : 'product'

export const isGenerated = (text: string) => GENERATED.test(text.split('\n', 5).join('\n'))

export const lineCount = (text: string) => text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

export function overGuidance(files: { path: string, text: string }[], changed: Set<string>): Row[] {
  return files
    .filter(f => SOURCE.test(f.path) && !isGenerated(f.text))
    .map(f => ({ path: f.path, kind: kindOf(f.path), lines: lineCount(f.text), changed: changed.has(f.path) }))
    .filter(r => r.lines > GUIDANCE[r.kind])
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))
}

export function markdown(rows: Row[], hasBase: boolean): string {
  const head = `## Files over the line-count guidance (report only)\n\nGuidance: product ${GUIDANCE.product} / tests ${GUIDANCE.test} lines (\`.rs\`, \`.ts\`, \`.svelte\`; generated files excluded). Over means "check the responsibility", not "split" (AGENTS.md "Tier 2, files").\n\n`
  if (rows.length === 0) return `${head}No file is over the guidance.\n`
  const changedNote = hasBase ? ` ${rows.filter(r => r.changed).length} changed in this PR (marked).` : ''
  const table = rows.map(r => `| \`${r.path}\` | ${r.kind} | ${r.lines} | ${GUIDANCE[r.kind]} |${hasBase ? (r.changed ? ' yes |' : ' |') : ''}`)
  const header = hasBase ? '| File | Kind | Lines | Guidance | Changed |\n|---|---|---:|---:|---|' : '| File | Kind | Lines | Guidance |\n|---|---|---:|---:|'
  return `${head}${rows.length} files over the guidance.${changedNote}\n\n${header}\n${table.join('\n')}\n`
}

function git(args: string[]): string {
  const run = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.trim()}`)
  return run.stdout
}

function main(argv: string[]) {
  const at = argv.indexOf('--base')
  const base = at >= 0 ? argv[at + 1] : undefined
  const tracked = git(['ls-files', '-z']).split('\0').filter(p => SOURCE.test(p))
  const changed = new Set(base ? git(['diff', '--name-only', '-z', base, 'HEAD']).split('\0').filter(Boolean) : [])
  const rows = overGuidance(tracked.map(path => ({ path, text: readFileSync(path, 'utf8') })), changed)
  const report = markdown(rows, base !== undefined)
  process.stdout.write(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)
}

if (import.meta.main) main(process.argv.slice(2))
