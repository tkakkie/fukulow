// Verifies that every test named in docs/invariants.md is a real test that CI actually runs.
// Run: node web/scripts/check-invariants.ts   (from the repository root)
//
// A reference is `path::test_name` (path relative to the repository root).
// What is detected (static analysis only):
//   - Rust: #[test] / #[tokio::test] / #[sqlx::test] in server/**/*.rs. Not run: #[ignore] and
//     #[ignore = "..."]. Any #[cfg(...)] other than exactly cfg(test), and cfg_attr, on the test fn is
//     treated as "cannot be verified" and refused. NOT detected: cfg on an enclosing mod/file,
//     runtime early returns, --features / env dependent behaviour.
//     NOT detected: whether the file is in the Rust module tree. Every .rs file under server/ is scanned, so a
//     test in an unreferenced file (e.g. server/src/unused_guard.rs) is accepted as runnable (see decisions.md).
//   - Vitest: web/**/*.{test,spec}.ts outside web/e2e (mirrors `test.exclude` in web/vite.config.ts).
//     Not run: .skip, .todo, .fixme, xit/xtest/xdescribe, and any test inside such a describe.
//     NOT detected: runtime skips (test.skip(cond), skipIf/runIf, ctx.skip()), and .only: it silently
//     disables other tests of its file, but vitest refuses .only when CI is set (allowOnly=false), so
//     CI fails loudly; this check does not look for it.
//   - web/e2e/** (Playwright) is not run in CI, so references to it are refused until E2E joins CI.
// A test title that is defined twice in one file counts only if no definition of it is skipped.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
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


const ATTR = /#\[(?:[^[\]]|\[[^\]]*\])*\]/g
const ATTRS_THEN_FN = /((?:#\[(?:[^[\]]|\[[^\]]*\])*\]\s*)+)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/g
const TEST_ATTR = /^#\[\s*(?:test|tokio::test|sqlx::test)\b/
const IGNORE_ATTR = /^#\[\s*ignore\b/
const PLAIN_CFG_TEST = /^#\[\s*cfg\s*\(\s*test\s*\)\s*\]$/

export type RustTest = { name: string; ignored: boolean; conditional: boolean }

/** Rust functions carrying #[test], #[tokio::test] or #[sqlx::test], with their ignore/cfg state. */
export function rustTests(src: string): RustTest[] {
  const code = blankRustCommentsAndStrings(src)
  const tests: RustTest[] = []
  for (const m of code.matchAll(ATTRS_THEN_FN)) {
    const attrs = m[1].match(ATTR) ?? []
    if (!attrs.some((a) => TEST_ATTR.test(a))) continue
    tests.push({
      name: m[2],
      ignored: attrs.some((a) => IGNORE_ATTR.test(a)),
      conditional: attrs.some((a) => (/^#\[\s*cfg(?:_attr)?\b/.test(a) && !PLAIN_CFG_TEST.test(a))),
    })
  }
  return tests
}

const SKIP_WORDS = new Set(['skip', 'fixme', 'todo'])
const MODIFIERS = new Set(['only', 'fail', 'fails', 'concurrent', 'sequential', 'describe', 'serial', 'parallel', ...SKIP_WORDS])

type Callee = { root: string; words: string[] } | null

/** `test.describe.skip` -> { root: 'test', words: ['describe', 'skip'] }; null if not a test/describe call. */
function calleeOf(e: ts.Expression): Callee {
  const words: string[] = []
  let cur = e
  while (ts.isPropertyAccessExpression(cur) && MODIFIERS.has(cur.name.text)) {
    words.unshift(cur.name.text)
    cur = cur.expression
  }
  if (!ts.isIdentifier(cur)) return null
  const root = cur.text
  if (!['test', 'it', 'describe', 'suite', 'xit', 'xtest', 'xdescribe'].includes(root)) return null
  return { root, words }
}

export type TsTest = { title: string; skipped: boolean }

/** Titles of test(...) / it(...) calls (vitest, Playwright) in the AST; skipped if the call or a parent describe is skipped. */
export function tsTests(src: string, fileName = 'x.ts'): TsTest[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true)
  const out: TsTest[] = []
  const visit = (node: ts.Node, parentSkipped: boolean) => {
    let skipped = parentSkipped
    if (ts.isCallExpression(node)) {
      const c = calleeOf(node.expression)
      if (c) {
        const own = c.root.startsWith('x') || c.words.some((w) => SKIP_WORDS.has(w))
        const isSuite = c.root === 'describe' || c.root === 'suite' || c.root === 'xdescribe' || c.words.includes('describe')
        const a = node.arguments[0]
        const literal = a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))
        if (literal && !isSuite) out.push({ title: a.text, skipped: parentSkipped || own })
        if (isSuite) skipped = parentSkipped || own
      }
    }
    ts.forEachChild(node, (child) => visit(child, skipped))
  }
  visit(sf, false)
  return out
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
    else if (todo && cell !== '(todo)') errors.push(`line ${line}: (todo) must stand alone in the Test column, not mixed with references: ${cells[0]}`)
    else rows.push({ line, rule: cells[0], names, todo })
  })
  return { rows, errors }
}

/** What CI does with a defined test: 'runs', or the reason it does not count. */
export type TestStatus = { runs: true } | { runs: false; reason: string }
export type Known = Map<string, TestStatus>

/** Returns one error message per reference that is not an executable test (with line, reference and reason). */
export function checkRows(rows: Row[], known: Known): string[] {
  const errors: string[] = []
  for (const r of rows)
    for (const ref of r.names) {
      const fail = (reason: string) => errors.push(`line ${r.line}: \`${ref}\` ${reason} (rule: ${r.rule})`)
      const cut = ref.lastIndexOf('::')
      if (cut <= 0 || cut === ref.length - 2 || !/\.(rs|ts)$/.test(ref.slice(0, cut))) {
        fail('is not in path::test_name form, e.g. server/tests/auth.rs::some_test')
        continue
      }
      const status = known.get(ref)
      if (!status) fail('is not a test definition at that path')
      else if (!status.runs) fail(`does not count: ${status.reason}`)
    }
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

function record(known: Known, ref: string, status: TestStatus) {
  const prev = known.get(ref)
  // A name defined twice in one file counts only if every definition runs.
  if (!prev || (prev.runs && !status.runs)) known.set(ref, status)
}

/** Collects every test definition in the repository, keyed by `path::name`, with whether CI runs it. */
export function collectKnownTests(root: string): Known {
  const known: Known = new Map()
  const skip = new Set(['node_modules', 'target', 'dist', '.git'])
  const rel = (f: string) => relative(root, f).split(sep).join('/')
  for (const f of walk(join(root, 'server'), skip)) {
    if (!f.endsWith('.rs')) continue
    for (const t of rustTests(readFileSync(f, 'utf8'))) {
      const status: TestStatus = t.ignored
        ? { runs: false, reason: '#[ignore] tests are not run by cargo test' }
        : t.conditional
          ? { runs: false, reason: 'conditional #[cfg(...)] / cfg_attr cannot be verified statically' }
          : { runs: true }
      record(known, `${rel(f)}::${t.name}`, status)
    }
  }
  for (const f of walk(join(root, 'web'), skip)) {
    if (!/\.(test|spec)\.ts$/.test(f)) continue
    const e2e = rel(f).startsWith('web/e2e/')
    for (const t of tsTests(readFileSync(f, 'utf8'), f)) {
      const status: TestStatus = e2e
        ? { runs: false, reason: 'web/e2e (Playwright) is not run in CI' }
        : t.skipped
          ? { runs: false, reason: 'skipped (skip/fixme/todo, or inside a skipped describe)' }
          : { runs: true }
      record(known, `${rel(f)}::${t.title}`, status)
    }
  }
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
  console.log('invariants: every named test exists and runs in CI')
}
