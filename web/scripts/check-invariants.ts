// Verifies that every test named in docs/invariants.md is a real test that CI actually runs.
// Run: node web/scripts/check-invariants.ts   (from the repository root)
//
// A reference is `path::test_name` (path relative to the repository root).
// What is detected (static analysis only):
//   - Rust: #[test] / #[tokio::test] / #[sqlx::test] in server/**/*.rs. Not run: #[ignore] and
//     #[ignore = "..."]. Any #[cfg(...)] other than exactly cfg(test), and cfg_attr, on the test fn is
//     treated as "cannot be verified" and refused, also when it sits on an enclosing inline `mod`.
//     NOT detected: cfg on an enclosing file, runtime early returns, --features / env dependent behaviour.
//     Reconciled with `cargo test -- --list` (CLI only), per test binary (src/lib.rs, src/main.rs, tests/<x>.rs: one cargo
//     run each, stdout only). A reference must (1) sit in a file that is really part of the module tree and (2) appear in
//     the list of that binary under the exact name `<module path>::<inline mods>::name`.
//     (1) is a small declaration scan, not a Rust parser: `mod x;` is resolved from server/src/lib.rs and main.rs
//     through x.rs / x/mod.rs (module directory rules, inline mods included). FAILS CLOSED, refusing the reference, when
//     a file is not reached by any declaration, is reached twice or through a non-test #[cfg] on a `mod`, or when the
//     tree cannot be trusted (#[path], include!, macro_rules!, unbalanced braces). So an unreferenced
//     server/src/unused_guard.rs is refused even if lib.rs has an inline `mod unused_guard` with a test of the same name.
//     Other server/tests/** paths (e.g. tests/helpers/mod.rs) and server/src/bin/** cannot be mapped and are refused.
//     Without cargo, the CLI fails. CI runs it in the server job right after `cargo test` (already compiled).
//     The vitest "real docs" test uses the static scan only (the web job has no Rust build).
//   - Vitest: web/**/*.{test,spec}.ts outside web/e2e (mirrors `test.exclude` in web/vite.config.ts).
//     Not run: .skip, .todo, .fixme, xit/xtest/xdescribe, and any test inside such a describe.
//     NOT detected: runtime skips (test.skip(cond), skipIf/runIf, ctx.skip()), and .only: it silently
//     disables other tests of its file, but vitest refuses .only when CI is set (allowOnly=false), so
//     CI fails loudly; this check does not look for it.
//   - web/e2e/** (Playwright) is not run in CI, so references to it are refused until E2E joins CI.
// A test title that is defined twice in one file counts only if no definition of it is skipped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

const isConditionalAttr = (a: string) => /^#\[\s*cfg(?:_attr)?\b/.test(a) && !PLAIN_CFG_TEST.test(a)
const PATH_ATTR = /^#\[\s*(?:path\b|cfg_attr\b[^\]]*\bpath\b)/
// An optional attribute run, then `mod name;` / `mod name {`; or a bare brace; or constructs that can hide modules.
const MOD_TOKEN = new RegExp(
  `((?:${ATTR.source}\\s*)*)(?:pub(?:\\([^)]*\\))?\\s+)?\\bmod\\s+([A-Za-z_]\\w*)\\s*([;{])|[{}]|\\binclude!|\\bmacro_rules\\b`,
  'g',
)

/** A `mod name;` declaration (file module) with the inline modules enclosing it. */
export type ModDecl = { name: string; inline: string[]; conditional: boolean }
/** An inline `mod name { .. }` body: its path from the file root and the source range of the body. */
type InlineMod = { path: string[]; start: number; end: number; conditional: boolean }
export type ModScan = { decls: ModDecl[]; inlines: InlineMod[]; balanced: boolean; opaque: string | null }

/** Small declaration scan over comment/string-blanked source: `mod` declarations and inline mod bodies by brace matching. */
export function scanModules(code: string): ModScan {
  const scan: ModScan = { decls: [], inlines: [], balanced: true, opaque: null }
  type Frame = { name: string | null; start: number; conditional: boolean }
  const stack: Frame[] = []
  const names = () => stack.filter((f) => f.name !== null).map((f) => f.name as string)
  const inheritedConditional = () => stack.some((f) => f.conditional)
  for (const m of code.matchAll(MOD_TOKEN)) {
    const end = m.index + m[0].length
    if (m[0] === '{') stack.push({ name: null, start: end, conditional: false })
    else if (m[0] === '}') {
      const f = stack.pop()
      if (!f) scan.balanced = false
      else if (f.name !== null) scan.inlines.push({ path: [...names(), f.name], start: f.start, end: m.index, conditional: f.conditional || inheritedConditional() })
    } else if (m[0].startsWith('include!')) scan.opaque ??= 'include! can pull in module declarations'
    else if (m[0].startsWith('macro_rules')) scan.opaque ??= 'macro_rules! can generate module declarations'
    else {
      const attrs = m[1].match(ATTR) ?? []
      if (attrs.some((a) => PATH_ATTR.test(a))) scan.opaque ??= '#[path] on a mod declaration is not resolved'
      const conditional = attrs.some(isConditionalAttr) || inheritedConditional()
      if (m[3] === ';') scan.decls.push({ name: m[2], inline: names(), conditional })
      else stack.push({ name: m[2], start: end, conditional })
    }
  }
  if (stack.length > 0) scan.balanced = false
  return scan
}

export type RustTest = { name: string; ignored: boolean; conditional: boolean; inline: string[] }
type RustFile = { tests: RustTest[]; scan: ModScan }

function analyzeRust(src: string): RustFile {
  const code = blankRustCommentsAndStrings(src)
  const scan = scanModules(code)
  const tests: RustTest[] = []
  for (const m of code.matchAll(ATTRS_THEN_FN)) {
    const attrs = m[1].match(ATTR) ?? []
    if (!attrs.some((a) => TEST_ATTR.test(a))) continue
    let enclosing: InlineMod | null = null
    for (const i of scan.inlines) if (i.start <= m.index && m.index < i.end && (!enclosing || i.path.length > enclosing.path.length)) enclosing = i
    tests.push({
      name: m[2],
      ignored: attrs.some((a) => IGNORE_ATTR.test(a)),
      conditional: attrs.some(isConditionalAttr) || (enclosing?.conditional ?? false),
      inline: enclosing?.path ?? [],
    })
  }
  return { tests, scan }
}

/** Rust functions carrying #[test], #[tokio::test] or #[sqlx::test], with their ignore/cfg state and inline module path. */
export function rustTests(src: string): RustTest[] {
  return analyzeRust(src).tests
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
export type TestStatus =
  | {
      runs: true
      /** Rust only: every (binary, full listed name) that must appear in `cargo test -- --list` for this reference. */
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

type Place = { binary: string; modPath: string[] }
type ModuleTree = { places: Map<string, Place[]>; unsure: Map<string, string>; opaque: string | null }

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))

/**
 * Resolves `mod x;` declarations from server/src/lib.rs and server/src/main.rs (x.rs or x/mod.rs, relative to the
 * declaring file's module directory and any enclosing inline mods). `unsure` files are reached conditionally or twice;
 * `opaque` means the tree cannot be trusted at all (#[path], include!, macro_rules!, unbalanced braces).
 */
function buildModuleTree(files: Map<string, RustFile>): ModuleTree {
  const tree: ModuleTree = { places: new Map(), unsure: new Map(), opaque: null }
  const visit = (file: string, binary: string, modPath: string[], conditional: boolean, chain: string[]) => {
    const f = files.get(file)
    if (!f) return
    if (chain.includes(file)) return void tree.unsure.set(file, 'module declarations form a cycle')
    const places = tree.places.get(file) ?? []
    if (places.some((p) => p.binary === binary)) return void tree.unsure.set(file, 'declared by more than one `mod`')
    tree.places.set(file, [...places, { binary, modPath }])
    if (conditional) tree.unsure.set(file, 'reached through a conditional #[cfg(...)] on a `mod` declaration')
    if (f.scan.opaque) tree.opaque ??= `${file}: ${f.scan.opaque}`
    if (!f.scan.balanced) tree.opaque ??= `${file}: unbalanced braces (cannot scan modules)`
    const base = file.split('/').pop() as string
    const childDir = /^(?:mod|lib|main)\.rs$/.test(base) ? dirOf(file) : file.replace(/\.rs$/, '')
    for (const d of f.scan.decls) {
      const dir = [childDir, ...d.inline].join('/')
      const found = [`${dir}/${d.name}.rs`, `${dir}/${d.name}/mod.rs`].filter((c) => files.has(c))
      if (found.length > 1) for (const c of found) tree.unsure.set(c, 'module file is ambiguous (x.rs and x/mod.rs)')
      if (found.length === 1) visit(found[0], binary, [...modPath, ...d.inline, d.name], conditional || d.conditional, [...chain, file])
    }
  }
  visit('server/src/lib.rs', 'src/lib.rs', [], false, [])
  visit('server/src/main.rs', 'src/main.rs', [], false, [])
  return tree
}

/** Where `cargo test -- --list` must show a Rust test defined in `file` (with enclosing inline mods); refuses when unsure. */
function rustPlacement(file: string, t: RustTest, files: Map<string, RustFile>, tree: ModuleTree): TestStatus {
  const f = files.get(file)
  const refuse = (why: string): TestStatus => ({ runs: true, refuse: why })
  const names = (binary: string, modPath: string[]) => ({ binary, name: [...modPath, ...t.inline, t.name].join('::') })
  const integration = /^server\/tests\/([^/]+\.rs)$/.exec(file)
  if (integration) {
    if (!f?.scan.balanced) return refuse('module nesting cannot be scanned (unbalanced braces)')
    return { runs: true, expect: [names(`tests/${integration[1]}`, [])] }
  }
  if (!/^server\/src\/(?!bin\/).+\.rs$/.test(file))
    return refuse('path cannot be mapped to a cargo test binary (only server/tests/*.rs and server/src/**.rs under lib.rs/main.rs are supported)')
  if (tree.opaque) return refuse(`module tree cannot be resolved (${tree.opaque})`)
  const places = tree.places.get(file)
  if (!places) return refuse('is not in the Rust module tree: no `mod` declaration reaches the file from server/src/lib.rs or server/src/main.rs')
  const unsure = tree.unsure.get(file)
  if (unsure) return refuse(`module tree position is ambiguous (${unsure})`)
  return { runs: true, expect: places.map((p) => names(p.binary, p.modPath)) }
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

/** One test printed by `cargo test -- --list`: the test binary it came from and its full module path + name. */
export type ListedTest = { binary: string; name: string }

/** Parses the stdout of ONE test binary's `-- --list` run ("name: test" lines); `binary` is the one that was run. */
export function parseTestList(stdout: string, binary: string): ListedTest[] {
  const out: ListedTest[] = []
  for (const raw of stdout.split('\n')) {
    const t = /^(\S+): test$/.exec(raw.replace(/\r$/, ''))
    if (t) out.push({ binary, name: t[1] })
  }
  return out
}

/** Downgrades Rust tests whose module-tree position is unsure or whose exact listed name is missing from its binary. */
export function reconcileWithCargoList(known: Known, listed: ListedTest[]): Known {
  const out: Known = new Map(known)
  const have = new Set(listed.map((t) => `${t.binary}\0${t.name}`))
  for (const [ref, status] of known) {
    if (!status.runs || !ref.startsWith('server/')) continue
    const missing = (status.expect ?? []).filter((e) => !have.has(`${e.binary}\0${e.name}`))
    if (status.refuse) out.set(ref, { runs: false, reason: status.refuse })
    else if (!status.expect?.length) out.set(ref, { runs: false, reason: 'has no known position in a cargo test binary' })
    else if (missing.length > 0)
      out.set(ref, {
        runs: false,
        reason: `is not in \`cargo test -- --list\` of ${missing.map((e) => `${e.binary} as \`${e.name}\``).join(', ')} (cfg-excluded or not compiled)`,
      })
  }
  return out
}

/**
 * Lists the tests of each server test binary with its own `cargo test -p <pkg> <target> -- --list` run, stdout only
 * (the "Running <binary>" headers are on stderr, so one run per binary is the unambiguous way to attribute names).
 * Throws (never skips) if cargo is unavailable or any run fails.
 */
export function cargoList(root: string): ListedTest[] {
  const pkg = /^name\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, 'server/Cargo.toml'), 'utf8'))?.[1]
  if (!pkg) throw new Error('server/Cargo.toml: package name not found; cannot run `cargo test -- --list`')
  const targets: { binary: string; args: string[] }[] = []
  if (existsSync(join(root, 'server/src/lib.rs'))) targets.push({ binary: 'src/lib.rs', args: ['--lib'] })
  if (existsSync(join(root, 'server/src/main.rs'))) targets.push({ binary: 'src/main.rs', args: ['--bin', pkg] })
  if (existsSync(join(root, 'server/tests')))
    for (const f of readdirSync(join(root, 'server/tests')).sort())
      if (f.endsWith('.rs') && statSync(join(root, 'server/tests', f)).isFile()) targets.push({ binary: `tests/${f}`, args: ['--test', f.slice(0, -3)] })
  const listed: ListedTest[] = []
  for (const t of targets) {
    const r = spawnSync('cargo', ['test', '-p', pkg, ...t.args, '--', '--list'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    })
    if (r.error || r.status !== 0)
      throw new Error(`\`cargo test ${t.args.join(' ')} -- --list\` failed (cargo is required; this check does not skip):\n${r.error ?? ''}${r.stderr ?? ''}`)
    listed.push(...parseTestList(r.stdout, t.binary))
  }
  if (listed.length === 0) throw new Error('`cargo test -- --list` printed no tests; cannot reconcile')
  return listed
}

/** Static scan only, or reconciled with the real cargo list when `listed` is given. */
export function checkInvariants(root: string, listed?: ListedTest[]): string[] {
  const { rows, errors } = parseInvariants(readFileSync(join(root, 'docs/invariants.md'), 'utf8'))
  if (rows.length === 0) errors.push('docs/invariants.md: no rows found')
  const known = collectKnownTests(root)
  return [...errors, ...checkRows(rows, listed ? reconcileWithCargoList(known, listed) : known)]
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '../..')
  let listed: ListedTest[]
  try {
    listed = cargoList(root)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
  const errors = checkInvariants(root, listed)
  for (const e of errors) console.error(`${relative(process.cwd(), join(root, 'docs/invariants.md'))}: ${e}`)
  if (errors.length > 0) process.exit(1)
  console.log('invariants: every named test exists and runs in CI')
}
