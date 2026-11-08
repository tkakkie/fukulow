// Verifies that every test named in docs/invariants.md is a real test definition.
// Run: node web/scripts/check-invariants.ts   (from the repository root)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

/** Replace comments, string and char literals with spaces (newlines kept). */
export function blankRustCommentsAndStrings(src: string): string {
  const out: string[] = []
  const n = src.length
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(src[k] === '\n' ? '\n' : ' ')
  }
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (c === '/' && src[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') (depth++, (j += 2))
        else if (src[j] === '*' && src[j + 1] === '/') (depth--, (j += 2))
        else j++
      }
      blank(i, j)
      i = j
    } else if ((c === 'r' || c === 'b') && /^b?r#*"/.test(src.slice(i, i + 40)) && !/\w/.test(src[i - 1] ?? '')) {
      // raw (byte) string: r"..", r#".."#, br#".."#
      const m = /^b?r(#*)"/.exec(src.slice(i, i + 40))!
      const close = '"' + m[1]
      const end = src.indexOf(close, i + m[0].length)
      const j = end === -1 ? n : end + close.length
      blank(i, j)
      i = j
    } else if (c === '"' || (c === 'b' && src[i + 1] === '"' && !/\w/.test(src[i - 1] ?? ''))) {
      let j = c === '"' ? i + 1 : i + 2
      while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      j = Math.min(j + 1, n)
      blank(i, j)
      i = j
    } else if (c === "'") {
      // char literal ('a', '\n', '\u{..}') vs lifetime ('a)
      const m = /^'(?:\\[^']+|[^\\'])'/.exec(src.slice(i, i + 14))
      if (m) {
        blank(i, i + m[0].length)
        i += m[0].length
      } else {
        out.push(c)
        i++
      }
    } else {
      out.push(c)
      i++
    }
  }
  return out.join('')
}

const TEST_ATTR = /^#\[\s*(?:test|tokio::test|sqlx::test)\b/
const ATTRS_THEN_FN = /((?:#\[(?:[^[\]]|\[[^\]]*\])*\]\s*)+)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/g

/** Names of Rust functions carrying #[test], #[tokio::test] or #[sqlx::test]. */
export function rustTestNames(src: string): string[] {
  const code = blankRustCommentsAndStrings(src)
  const names: string[] = []
  for (const m of code.matchAll(ATTRS_THEN_FN)) {
    const attrs = m[1].match(/#\[(?:[^[\]]|\[[^\]]*\])*\]/g) ?? []
    if (attrs.some((a) => TEST_ATTR.test(a))) names.push(m[2])
  }
  return names
}

const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'fails', 'concurrent', 'sequential', 'todo'])

/** Titles of test(...) / it(...) calls (vitest, Playwright), found in the TypeScript AST. */
export function tsTestTitles(src: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true)
  const titles: string[] = []
  const isTestCallee = (e: ts.Expression): boolean =>
    (ts.isIdentifier(e) && (e.text === 'test' || e.text === 'it')) ||
    (ts.isPropertyAccessExpression(e) && TEST_MODIFIERS.has(e.name.text) && isTestCallee(e.expression))
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isTestCallee(node.expression)) {
      const a = node.arguments[0]
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) titles.push(a.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return titles
}

export type Row = { line: number; rule: string; names: string[]; todo: boolean }

/** Parses the table in docs/invariants.md. Returns rows, or errors for malformed ones. */
export function parseInvariants(md: string): { rows: Row[]; errors: string[] } {
  const rows: Row[] = []
  const errors: string[] = []
  md.split('\n').forEach((text, idx) => {
    const line = idx + 1
    if (!text.startsWith('|')) return
    const cells = text.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim())
    if (cells[0] === 'Rule' || /^-+$/.test(cells[0])) return
    const cell = cells[1] ?? ''
    const names = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
    const todo = /\(todo\)/.test(cell)
    if (cells.length !== 2) errors.push(`line ${line}: expected 2 columns (Rule | Test): ${cells[0]}`)
    else if (names.length === 0 && !todo) errors.push(`line ${line}: Test column names no test and is not (todo): ${cells[0]}`)
    else rows.push({ line, rule: cells[0], names, todo })
  })
  return { rows, errors }
}

/** Returns one error message per unknown test name (with row and name). */
export function checkRows(rows: Row[], known: Set<string>): string[] {
  const errors: string[] = []
  for (const r of rows)
    for (const name of r.names)
      if (!known.has(name)) errors.push(`line ${r.line}: \`${name}\` is not a test definition (rule: ${r.rule})`)
  return errors
}

function walk(dir: string, skip: Set<string>, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (skip.has(e)) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, skip, out)
    else out.push(p)
  }
  return out
}

/** Collects every real test name in the repository. */
export function collectKnownTests(root: string): Set<string> {
  const known = new Set<string>()
  const skip = new Set(['node_modules', 'target', 'dist', '.git'])
  for (const f of walk(join(root, 'server'), skip))
    if (f.endsWith('.rs')) for (const n of rustTestNames(readFileSync(f, 'utf8'))) known.add(n)
  for (const f of walk(join(root, 'web'), skip))
    if (/\.(test|spec)\.ts$/.test(f)) for (const n of tsTestTitles(readFileSync(f, 'utf8'), f)) known.add(n)
  return known
}

export function checkInvariants(root: string): string[] {
  const { rows, errors } = parseInvariants(readFileSync(join(root, 'docs/invariants.md'), 'utf8'))
  if (rows.length === 0) errors.push('docs/invariants.md: no rows found')
  return [...errors, ...checkRows(rows, collectKnownTests(root))]
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '../..')
  const errors = checkInvariants(root)
  for (const e of errors) console.error(`${relative(process.cwd(), join(root, 'docs/invariants.md'))}: ${e}`)
  if (errors.length > 0) process.exit(1)
  console.log('invariants: every named test exists')
}
