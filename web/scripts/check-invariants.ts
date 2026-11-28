// Checks the docs/invariants.md index and every docs/invariants/*.md part.
// Verifies that every named test is a real test that CI actually runs.
// If present, cross-part bullets resolve each token to one distinct row by a unique test name or #id.
// Optional {#id} Rule prefixes are globally unique, must be referenced, and do not count as Rule text.
// Also checks the required docs/decisions.md index and every docs/decisions/*.md part:
// structure, unique single-line entries and cross-reference prefixes when present.
// Also checks the test citations in contract/realtime/**/*.json the same way (#892).
// Per-file byte budgets are checked separately by check-doc-budgets.ts.
// Run: node web/scripts/check-invariants.ts   (from the repository root)
// Detection lives in rust-tests.ts, ts-tests.ts and playwright-ci.ts, the cargo reconciliation in cargo-list.ts and
// the decisions check in check-decisions.ts; this file parses the tables, collects tests and runs every check.
//
// A reference is `path::test_name` (path relative to the repository root).
// What is detected (static analysis only):
//   - Rust: #[test] / #[tokio::test] / #[sqlx::test] / #[fukulow_test::test] in server/**/*.rs. Not run: #[ignore] and
//     #[ignore = "..."]. Any #[cfg(...)] other than exactly cfg(test), and cfg_attr, on the test fn is
//     treated as "cannot be verified" and refused, also when it sits on an enclosing inline `mod`.
//     NOT detected statically: cfg on an enclosing file, runtime early returns, feature- or env-dependent behaviour.
//     Reconciled with `cargo nextest list` (CLI only). A reference must (1) sit in a file that is really part of the
//     module tree and (2) appear as runnable in its test binary under the exact name `<module path>::<inline mods>::name`.
//     (1) is a small declaration scan, not a Rust parser: `mod x;` is resolved from server/src/lib.rs and main.rs
//     through x.rs / x/mod.rs (module directory rules, inline mods included). FAILS CLOSED, refusing the reference, when
//     a file is not reached by any declaration, is reached twice or through a non-test #[cfg] on a `mod`, or when the
//     tree cannot be trusted (#[path], include!, macro_rules!, unbalanced braces). So an unreferenced
//     server/src/unused_guard.rs is refused even if lib.rs has an inline `mod unused_guard` with a test of the same name.
//     Other server/tests/** paths (e.g. tests/helpers/mod.rs) and server/src/bin/** cannot be mapped and are refused.
//     Without cargo or nextest, the CLI fails. The list uses the same build flags as server-tests to reuse its artifacts.
//     The vitest "real docs" test uses the static scan only (the web job does not build server tests).
//   - Vitest: web/**/*.{test,spec}.ts outside web/e2e (mirrors `test.exclude` in web/vite.config.ts).
//     Not run: .skip, .todo, .fixme, xit/xtest/xdescribe, and any test inside such a describe.
//     NOT detected: runtime skips (test.skip(cond), skipIf/runIf, ctx.skip()), and .only: it silently
//     disables other tests of its file, but vitest refuses .only when CI is set (allowOnly=false), so
//     CI fails loudly; this check does not look for it.
//   - scripts/*.test.ts: counts only with the explicit CI node --test glob; options are refused conservatively.
//     Runtime skips inside callbacks cannot be detected, as with web tests.
//   - Playwright: web/e2e/**/*.{test,spec}.ts only with the verified unfiltered PR smoke command and
//     literal single-project discovery config. Compose acceptance is not PR CI and never counts.
//     Refuses skip/fixme/fail declarations and skipped suites; runtime skip/fixme, .only, mode changes,
//     conditional declarations and unsupported test APIs make the whole file unverifiable.
//     Across all smoke-directory files, modifier access/binding and aliases are refused conservatively.
//     Focus, aliases and unsafe helpers refuse all smoke references; other spec modifiers stay file-local.
//     Runtime imports must stay inside web/e2e (or be @playwright/test / node:*); type-only imports are erased.
//     Any other import, dynamic import() or require refuses all smoke references (helpers elsewhere are unscanned).
// A test title that is defined twice in one file counts only if no definition of it is skipped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { cargoList, reconcileWithCargoList, type ListedTest } from './cargo-list.ts'
import { checkDecisionDocs } from './check-decisions.ts'
import { isPlaywrightImport, playwrightCI, playwrightConfig, playwrightSafety } from './playwright-ci.ts'
import { analyzeRust, buildModuleTree, rustPlacement, type RustFile } from './rust-tests.ts'
import { tsTests } from './ts-tests.ts'

export type Row = { line: number; rule: string; id?: string; names: string[]; todo: boolean }

/** Parses a part table, separating a valid {#id} prefix from Rule text. Reports malformed tags and rows. */
export function parseInvariants(md: string): { rows: Row[]; errors: string[] } {
  const rows: Row[] = []
  const errors: string[] = []
  md.split('\n').forEach((text, idx) => {
    const line = idx + 1
    if (!text.startsWith('|')) return
    const cells = text.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim())
    if (cells[0] === 'Rule' || /^-+$/.test(cells[0])) return
    let rule = cells[0]
    const tag = /^\{#([a-z0-9]+(?:-[a-z0-9]+)*)\} (?=\S)/.exec(rule) // exactly one space, so the Rule text is canonical
    if (rule.startsWith('{#') && !tag) errors.push(`line ${line}: malformed rule ID tag: ${rule}`)
    if (tag) rule = rule.slice(tag[0].length)
    const cell = cells[1] ?? ''
    const names = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
    const todo = /\(todo\)/.test(cell)
    if (cells.length !== 2) errors.push(`line ${line}: expected 2 columns (Rule | Test): ${cells[0]}`)
    else if (names.length === 0 && !todo) errors.push(`line ${line}: Test column names no test and is not (todo): ${cells[0]}`)
    else if (todo && cell !== '(todo)') errors.push(`line ${line}: (todo) must stand alone in the Test column, not mixed with references: ${cells[0]}`)
    else rows.push({ line, rule, ...(tag ? { id: tag[1] } : {}), names, todo })
  })
  return { rows, errors }
}

/** What CI does with a defined test: 'runs', or the reason it does not count. */
export type TestStatus =
  | {
      runs: true
      /** Rust only: every (binary, full listed name) that must appear in `cargo nextest list` for this reference. */
      expect?: { binary: string; name: string }[]
      /** Rust only: why the reference cannot be tied to a listed test (fails closed in the reconciliation). */
      refuse?: string
    }
  | { runs: false; reason: string }
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
  // A name defined twice in one file counts only if every definition runs (and, for Rust, is listed).
  if (!prev || (prev.runs && !status.runs)) known.set(ref, status)
  else if (prev.runs && status.runs)
    known.set(ref, { runs: true, expect: [...(prev.expect ?? []), ...(status.expect ?? [])], refuse: prev.refuse ?? status.refuse })
}

/** Collects every test definition in the repository, keyed by `path::name`, with whether CI runs it. */
export function collectKnownTests(root: string): Known {
  const known: Known = new Map()
  const skip = new Set(['node_modules', 'target', 'dist', '.git'])
  const rel = (f: string) => relative(root, f).split(sep).join('/')
  const rust = new Map<string, RustFile>()
  for (const f of walk(join(root, 'server'), skip)) if (f.endsWith('.rs')) rust.set(rel(f), analyzeRust(readFileSync(f, 'utf8')))
  const tree = buildModuleTree(rust)
  for (const [file, { tests }] of rust)
    for (const t of tests) {
      const status: TestStatus = t.ignored
        ? { runs: false, reason: '#[ignore] tests are not run by cargo test' }
        : t.conditional
          ? { runs: false, reason: 'conditional #[cfg(...)] / cfg_attr cannot be verified statically' }
          : rustPlacement(file, t, rust, tree)
      record(known, `${file}::${t.name}`, status)
    }
  const webFiles = walk(join(root, 'web'), skip)
  let unsafeSmoke: string | undefined
  const smokeDir = join(root, 'web/e2e')
  for (const f of existsSync(smokeDir) ? walk(smokeDir, new Set()) : []) {
    // Never inspect environment files, even if one is accidentally placed in the smoke directory.
    if (/(?:^|\/)\.env(?:\.|$)/.test(rel(f))) {
      unsafeSmoke ??= 'environment file in web/e2e makes the entire smoke suite unverifiable'
      continue
    }
    const safety = playwrightSafety(ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true), smokeDir)
    if (safety && (safety.suiteWide || !/\.(test|spec)\.ts$/.test(f)))
      unsafeSmoke ??= `${safety.reason} in ${rel(f)} makes the entire smoke suite unverifiable`
  }
  const playwrightRefusal = playwrightCI(root) ?? playwrightConfig(root)
    ?? unsafeSmoke
  for (const f of webFiles) {
    if (!/\.(test|spec)\.ts$/.test(f)) continue
    const src = readFileSync(f, 'utf8')
    const path = rel(f)
    const e2e = /^web\/e2e(?:[/-])/.test(path)
      || ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true).statements.some(isPlaywrightImport)
    // e2e-compose.yml -> package script e2e:compose -> playwright.compose.config.ts -> e2e-compose.
    const refusal = path.startsWith('web/e2e-compose/') ? 'Compose-only Playwright acceptance is not PR CI'
      : !path.startsWith('web/e2e/') ? 'Playwright file is outside smoke testDir web/e2e'
      : playwrightRefusal
    for (const t of tsTests(src, f, false, e2e)) {
      const status: TestStatus = e2e
        ? refusal ? { runs: false, reason: refusal }
          : t.skipped ? { runs: false, reason: t.reason ?? 'inside a skipped Playwright describe (skip/fixme/fail)' } : { runs: true }
        : t.skipped
          ? { runs: false, reason: 'skipped (skip/fixme/todo, or inside a skipped describe)' }
          : { runs: true }
      record(known, `${rel(f)}::${t.title}`, status)
    }
  }
  // Only top-level script tests covered by the explicit CI command count.
  const scripts = join(root, 'scripts'), ci = join(root, '.github/workflows/ci.yml')
  const scriptCI = existsSync(ci) && /^\s*run: node --test scripts\/\*\.test\.ts\s*$/m.test(readFileSync(ci, 'utf8'))
  if (existsSync(scripts)) for (const file of readdirSync(scripts).filter(f => f.endsWith('.test.ts'))) {
    for (const t of tsTests(readFileSync(join(scripts, file), 'utf8'), file, true)) {
      record(known, `scripts/${file}::${t.title}`, !scriptCI
        ? { runs: false, reason: 'script tests are not run by the CI glob' }
        : t.skipped ? { runs: false, reason: 'skipped script test' } : { runs: true })
    }
  }
  return known
}

/** Resolve bullet tokens within the linked part; count rows, not matching test references within a row. */
function checkCrossReferences(tokens: string, target: string, rows: Row[], referencedIds: Set<string>): string[] {
  const errors: string[] = []
  const seen = new Set<Row>()
  for (const m of tokens.matchAll(/`([^`]+)`/g)) {
    const token = m[1]
    const isId = token.startsWith('#')
    const matches = rows.filter((row) => isId
      ? row.id === token.slice(1)
      : row.names.some((ref) => ref.slice(ref.lastIndexOf('::') + 2) === token))
    if (matches.length === 0) {
      errors.push((isId ? 'rule ID not found in ' : 'test name not found in ') + target + ': ' + token)
      continue
    }
    if (!isId && matches.length > 1) {
      errors.push(`test name matches ${matches.length} rows in ${target}; reference the row by its #id instead: ${token}`)
      continue
    }
    const row = matches[0]
    if (isId) referencedIds.add(token.slice(1))
    if (seen.has(row)) errors.push(`same row referenced twice in ${target}: ${token}`)
    seen.add(row)
  }
  return errors
}

/** Test citations in the contract/realtime JSON files (#892): every JSON string in `path.(rs|ts)::name` form must name a
 * test that runs in CI, resolved like an invariants row. The "rule" in a message is the citing scenario's `id`. */
function checkContractCitations(root: string, known: Known): string[] {
  const dir = join(root, 'contract/realtime')
  if (!existsSync(dir)) return []
  const errors: string[] = []
  for (const path of walk(dir, new Set()).filter((p) => p.endsWith('.json')).sort()) {
    const file = relative(root, path).split(sep).join('/')
    const text = readFileSync(path, 'utf8')
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (e) {
      errors.push(file + ': line 1: invalid JSON: ' + (e as Error).message)
      continue
    }
    const rows: Row[] = []
    // A test cited in several scenarios is found again after its previous occurrence, so each row gets its own line.
    const next = new Map<string, number>()
    const visit = (value: unknown, scenario: string) => {
      if (typeof value === 'string') {
        if (!/^[^\s:]+\.(rs|ts)::/.test(value)) return
        const needle = JSON.stringify(value)
        const at = text.indexOf(needle, next.get(needle) ?? 0)
        if (at >= 0) next.set(needle, at + needle.length)
        rows.push({ line: at < 0 ? 1 : text.slice(0, at).split('\n').length, rule: scenario, names: [value], todo: false })
      } else if (Array.isArray(value)) value.forEach((v) => visit(v, scenario))
      else if (value && typeof value === 'object') {
        const id = (value as { id?: unknown }).id
        for (const v of Object.values(value)) visit(v, typeof id === 'string' ? id : scenario)
      }
    }
    visit(json, '(file)')
    errors.push(...checkRows(rows, known).map((e) => file + ': ' + e.replace(/ \(rule: /, ' (scenario: ')))
  }
  return errors
}

/** Checks parts, Rule text/IDs and unambiguous cross-references, then the decisions index and parts.
 * Test definitions use a static scan, reconciled with the real cargo list when `listed` is given.
 */
export function checkInvariants(root: string, listed?: ListedTest[]): string[] {
  const errors: string[] = []
  const index = readFileSync(join(root, 'docs/invariants.md'), 'utf8')
  const dir = join(root, 'docs/invariants')
  const parts = new Map<string, { md: string; rows: Row[] }>()
  if (!existsSync(dir) || !statSync(dir).isDirectory()) errors.push('docs/invariants/: line 1: missing parts directory')
  else {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = 'docs/invariants/' + entry.name
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        errors.push(file + ': line 1: expected a regular *.md part file')
        continue
      }
      const md = readFileSync(join(dir, entry.name), 'utf8')
      const parsed = parseInvariants(md)
      errors.push(...parsed.errors.map((e) => file + ': ' + e))
      if (parsed.rows.length === 0) errors.push(file + ': line 1: no rows found')
      parts.set(entry.name, { md, rows: parsed.rows })
    }
    if (parts.size === 0) errors.push('docs/invariants/: line 1: no parts found')
  }
  const linked = new Set<string>()
  index.split('\n').forEach((text, idx) => {
    const at = 'docs/invariants.md: line ' + (idx + 1) + ': '
    if (text.startsWith('|')) errors.push(at + 'tables belong in parts, not the index')
    for (const m of text.matchAll(/\(invariants\/([^()]+\.md)\)/g)) {
      linked.add(m[1])
      if (!parts.has(m[1])) errors.push(at + 'unknown part: ' + m[1])
    }
  })
  const collected = collectKnownTests(root)
  const known = listed ? reconcileWithCargoList(collected, listed) : collected
  const rules = new Map<string, string>()
  const ids = new Map<string, string>()
  const referencedIds = new Set<string>()
  for (const [name, { md, rows }] of parts) {
    const file = 'docs/invariants/' + name
    if (!linked.has(name)) errors.push(file + ': line 1: part is not linked from docs/invariants.md')
    errors.push(...checkRows(rows, known).map((e) => file + ': ' + e))
    for (const row of rows) {
      const at = file + ': line ' + row.line
      const previous = rules.get(row.rule)
      if (previous) errors.push(at + ': duplicate Rule text (first at ' + previous + '): ' + row.rule)
      else rules.set(row.rule, at)
      if (row.id) {
        // An ID is only for a row that no test name identifies within its part.
        const suffix = (ref: string) => ref.slice(ref.lastIndexOf('::') + 2)
        const unique = row.names.map(suffix).find((n) => rows.filter((r) => r.names.some((ref) => suffix(ref) === n)).length === 1)
        if (unique) errors.push(at + ': rule ID is unnecessary; reference the row by its unique test name ' + unique + ': #' + row.id)
        const previousId = ids.get(row.id)
        if (previousId) errors.push(at + ': duplicate rule ID (first at ' + previousId + '): #' + row.id)
        else ids.set(row.id, at)
      }
    }
    let inOtherParts = false
    let proseSeen = false
    md.split('\n').forEach((text, idx) => {
      if (/^#{1,2} /.test(text)) {
        inOtherParts = text === '## Rows in other parts'
        return
      }
      if (!inOtherParts || text.trim() === '') return
      if (!proseSeen && text === 'Rows that also govern this area, listed by a test name unique to the row in that part, or by its `#id` when no such name exists.') {
        proseSeen = true
        return
      }
      const at = file + ': line ' + (idx + 1) + ': '
      const bullet = /^- \[([^\[\]\/]+)\]\(\1\.md\): (`[^`]+`(?:, `[^`]+`)*)$/.exec(text)
      if (!bullet) return void errors.push(at + 'expected a Rows in other parts bullet')
      const target = bullet[1] + '.md'
      const part = parts.get(target)
      if (!part) errors.push(at + 'unknown part: ' + target)
      else if (target === name) errors.push(at + 'cross-reference must link to another part')
      else {
        errors.push(...checkCrossReferences(bullet[2], target, part.rows, referencedIds).map((e) => at + e))
      }
    })
  }
  for (const [id, at] of ids)
    if (!referencedIds.has(id)) errors.push(at + ': rule ID is never referenced: #' + id)
  return [...errors, ...checkContractCitations(root, known), ...checkDecisionDocs(root)]
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '../..')
  let listed: ListedTest[]
  try {
    listed = cargoList(root)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
  const errors = checkInvariants(root, listed)
  for (const e of errors) console.error(e)
  if (errors.length > 0) process.exit(1)
  console.log('invariants: index and parts checked, and every named test (and every contract/realtime test citation) exists and runs in CI. Decisions: index, all parts, unique single-line entries and optional cross-references checked.')
}
