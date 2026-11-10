import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { checkInvariants, checkRows, parseInvariants, MAX_RULE_LENGTH, rustTests, tsTests, collectKnownTests, parseTestList, reconcileWithCargoList, cargoList, scanModules, blankRustCommentsAndStrings, type ListedTest, type Known } from './check-invariants.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('rustTests', () => {
  it('finds test attributes and reports #[ignore] and cfg state', () => {
    const src = `
#[test]
fn a() {}
#[tokio::test]
#[ignore]
async fn b() {}
#[tokio::test]
#[ignore = "needs a database"]
pub async fn c() {}
#[sqlx::test(migrations = "./m")]
#[cfg(test)]
async fn d(pool: PgPool) {}
#[test]
#[cfg(feature = "slow")]
fn e() {}
#[cfg_attr(windows, ignore)]
#[test]
fn f() {}
`
    expect(rustTests(src)).toEqual([
      { name: 'a', ignored: false, conditional: false, inline: [] },
      { name: 'b', ignored: true, conditional: false, inline: [] },
      { name: 'c', ignored: true, conditional: false, inline: [] },
      { name: 'd', ignored: false, conditional: false, inline: [] },
      { name: 'e', ignored: false, conditional: true, inline: [] },
      { name: 'f', ignored: false, conditional: true, inline: [] },
    ])
  })

  it('ignores comments, strings and plain functions (negative)', () => {
    const src = `
// #[test]
// fn in_line_comment() {}
/* #[test]
   /* nested */ fn in_block_comment() {} */
const S: &str = "#[test] fn in_string() {}";
const R: &str = r#"#[test] fn in_raw() {}"#;
fn not_a_test() {}
#[derive(Debug)]
fn helper() {}
#[cfg(test)]
fn cfg_only() {}
fn lifetimes<'a>(x: &'a str) -> char { '"' }
#[test]
fn after_char_literal() {}
`
    expect(rustTests(src).map((t) => t.name)).toEqual(['after_char_literal'])
  })
})

describe('tsTests', () => {
  it('finds test( and it( titles and marks skipped ones', () => {
    const src = `
test('first', async () => {})
it("second", () => {})
test.skip(\`third\`, () => {})
it.todo('fourth')
test.fixme('fifth', () => {})
xit('sixth', () => {})
test.only('seventh', () => {})
`
    expect(tsTests(src)).toEqual([
      { title: 'first', skipped: false },
      { title: 'second', skipped: false },
      { title: 'third', skipped: true },
      { title: 'fourth', skipped: true },
      { title: 'fifth', skipped: true },
      { title: 'sixth', skipped: true },
      { title: 'seventh', skipped: false },
    ])
  })

  it('marks every test inside a skipped describe, nested too (negative)', () => {
    const src = `
describe.skip('a', () => { it('in skipped', () => {}); describe('inner', () => { it('deep', () => {}) }) })
test.describe.skip('b', () => { test('pw in skipped', () => {}) })
describe('c', () => { it('fine', () => {}) })
`
    expect(tsTests(src)).toEqual([
      { title: 'in skipped', skipped: true },
      { title: 'deep', skipped: true },
      { title: 'pw in skipped', skipped: true },
      { title: 'fine', skipped: false },
    ])
  })

  it('ignores titles in comments and strings (negative)', () => {
    const src = `
// test('in comment', () => {})
const s = "test('in string', () => {})"
const t = \`it('in template', () => {})\`
describe('only a group', () => {})
other('not a test', () => {})
`
    expect(tsTests(src)).toEqual([])
  })
})

describe('docs/invariants.md parsing', () => {
  const table = (cell: string) => `| Rule | Test |\n|---|---|\n| r | ${cell} |`

  it('accepts references and a lone (todo)', () => {
    expect(parseInvariants(table('`a.rs::x`, `b.ts::y` (note)')).errors).toEqual([])
    expect(parseInvariants(table('(todo)')).errors).toEqual([])
  })

  it('fails a row that names nothing and is not (todo) (negative)', () => {
    expect(parseInvariants(table('nothing here')).errors).toHaveLength(1)
  })

  it('fails (todo) mixed with references, naming the line (negative)', () => {
    const { errors } = parseInvariants(table('(todo) `a.rs::x`'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('line 3')
    expect(errors[0]).toContain('(todo)')
  })

  const ruleRow = (rule: string) => `| Rule | Test |\n|---|---|\n| ${rule} | \`a.rs::x\` |`

  it('accepts a Rule cell of exactly the maximum length', () => {
    expect(MAX_RULE_LENGTH).toBe(160)
    const { rows, errors } = parseInvariants(ruleRow('a'.repeat(160)))
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
  })

  it('fails a Rule cell one character over the maximum, naming the line (negative)', () => {
    const { errors } = parseInvariants(ruleRow('a'.repeat(161)))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('line 3')
    expect(errors[0]).toContain('161 characters (max 160)')
  })

  it('counts Unicode code points, backticks and markup included, not bytes or UTF-16 units', () => {
    const fits = '`x` ' + '組'.repeat(155) + '𠮷'
    expect([...fits].length).toBe(160)
    expect(fits.length).toBeGreaterThan(160)
    expect(parseInvariants(ruleRow(fits)).errors).toEqual([])
    expect(parseInvariants(ruleRow(fits + '`')).errors[0]).toContain('161 characters')
  })

  it('fails closed on an escaped pipe in a Rule cell as a column-count error (negative)', () => {
    const { rows, errors } = parseInvariants(ruleRow('a \\| b'))
    expect(rows).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('expected 2 columns')
  })
})

describe('reference checking against a fixture repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'inv-'))
  const put = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  put('server/tests/a.rs', '#[test]\nfn ok_test() {}\n#[test]\n#[ignore]\nfn ignored_test() {}\n#[test]\nfn same_name() {}\n')
  put('server/tests/b.rs', '#[test]\nfn same_name() {}\n')
  put('web/src/x.test.ts', "it('runs', () => {})\nit.skip('skipped', () => {})\ndescribe.skip('g', () => { it('in parent', () => {}) })\ntest('dup', () => {})\ntest.skip('dup', () => {})\n")
  put('web/e2e/y.spec.ts', "test('e2e one', () => {})\n")
  const known: Known = collectKnownTests(root)
  const check = (...refs: string[]) =>
    checkRows(parseInvariants(`| Rule | Test |\n|---|---|\n| r | ${refs.map((r) => '`' + r + '`').join(', ')} |`).rows, known)

  it('passes valid references (rust and vitest)', () => {
    expect(check('server/tests/a.rs::ok_test', 'web/src/x.test.ts::runs')).toEqual([])
  })

  it('fails an ignored Rust test', () => {
    expect(check('server/tests/a.rs::ignored_test')[0]).toContain('#[ignore]')
  })

  it('fails a skipped Vitest test and a test inside a skipped describe', () => {
    expect(check('web/src/x.test.ts::skipped')[0]).toContain('skipped')
    expect(check('web/src/x.test.ts::in parent')[0]).toContain('skipped')
  })

  it('fails the skipped part of a mixed cell only, with its line', () => {
    const errors = check('server/tests/a.rs::ok_test', 'web/src/x.test.ts::skipped')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('line 3')
    expect(errors[0]).toContain('web/src/x.test.ts::skipped')
  })

  it('fails a title defined twice when one definition is skipped', () => {
    expect(check('web/src/x.test.ts::dup')).toHaveLength(1)
  })

  it('tells equal names in different files apart', () => {
    expect(check('server/tests/a.rs::same_name', 'server/tests/b.rs::same_name')).toEqual([])
    expect(check('server/tests/c.rs::same_name')[0]).toContain('not a test definition')
    expect(check('same_name')[0]).toContain('path::test_name')
  })

  it('fails a test CI does not run (Playwright e2e)', () => {
    expect(check('web/e2e/y.spec.ts::e2e one')[0]).toContain('not run in CI')
  })

  it('fails a nonexistent name', () => {
    expect(check('server/tests/a.rs::nope')[0]).toContain('not a test definition')
  })
})

describe('the real docs/invariants.md', () => {
  it('names only existing, executable tests (static scan; the CLI also reconciles with cargo)', () => {
    expect(checkInvariants(resolve(import.meta.dirname, '../..'))).toEqual([])
  })
})

describe('module scan', () => {
  it('finds file mods and inline mod bodies, ignoring comments and strings', () => {
    const src = `
// mod commented;
const S: &str = "mod in_string;";
pub mod a;
pub(crate) mod b;
#[cfg(test)]
mod tests {
    mod deep;
    #[test]
    fn t() {}
}
#[cfg(feature = "x")]
mod gated;
`
    const scan = scanModules(blankRustCommentsAndStrings(src))
    expect(scan.decls).toEqual([
      { name: 'a', inline: [], conditional: false },
      { name: 'b', inline: [], conditional: false },
      { name: 'deep', inline: ['tests'], conditional: false },
      { name: 'gated', inline: [], conditional: true },
    ])
    expect(scan.inlines.map((i) => i.path)).toEqual([['tests']])
    expect(scan.balanced).toBe(true)
    expect(rustTests(src)).toEqual([{ name: 't', ignored: false, conditional: false, inline: ['tests'] }])
  })

  it('marks tests inside a conditionally compiled inline mod as conditional, and flags unscannable constructs', () => {
    expect(rustTests('#[cfg(feature = "x")]\nmod m {\n#[test]\nfn t() {}\n}\n')[0]).toMatchObject({ conditional: true, inline: ['m'] })
    expect(scanModules('#[path = "x.rs"]\nmod a;').opaque).toContain('#[path]')
    expect(scanModules('include!("x.rs");').opaque).toContain('include!')
    expect(scanModules('macro_rules! m { () => {} }').opaque).toContain('macro_rules!')
    expect(scanModules('fn f() { }}').balanced).toBe(false)
    expect(scanModules('fn f() {').balanced).toBe(false)
  })
})

describe('reconciliation with the cargo test list', () => {
  const makeRoot = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'inv-list-'))
    mkdirSync(join(root, 'web'))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return root
  }
  const t = '#[test]\nfn real() {}\n'
  const lib = (name: string) => ({ binary: 'src/lib.rs', name })
  const checker = (root: string, listed: ListedTest[]) => {
    const known = reconcileWithCargoList(collectKnownTests(root), listed)
    return (ref: string) => checkRows(parseInvariants(`| Rule | Test |\n|---|---|\n| r | \`${ref}\` |`).rows, known)
  }

  const root = makeRoot({
    'server/Cargo.toml': '[package]\nname = "x"\n',
    'server/src/lib.rs': 'pub mod channels;\npub mod auth;\n#[cfg(test)]\nmod tests {\n#[test]\nfn real() {}\n}\n',
    'server/src/main.rs': '#[cfg(test)]\nmod tests {\n#[test]\nfn real() {}\n}\n',
    'server/src/channels.rs': '#[cfg(test)]\nmod tests;\n',
    'server/src/channels/tests.rs': 'mod names;\n#[test]\nfn real() {}\n',
    'server/src/channels/tests/names.rs': t,
    'server/src/auth.rs': 'mod throttle;\nmod sub;\n',
    'server/src/auth/throttle.rs': '#[cfg(test)]\nmod tests {\n#[test]\nfn real() {}\n}\n',
    'server/src/auth/sub/mod.rs': t,
    'server/src/unused_guard.rs': t,
    'server/src/orphan/mod.rs': t,
    'server/tests/auth.rs': t,
    'server/tests/helpers/mod.rs': t,
  })
  const listed = [
    lib('channels::tests::names::real'),
    lib('channels::tests::real'),
    lib('auth::throttle::tests::real'),
    lib('auth::sub::real'),
    lib('tests::real'),
    { binary: 'src/main.rs', name: 'tests::real' },
    { binary: 'tests/auth.rs', name: 'real' },
  ]
  const check = checker(root, listed)

  it('parses one binary stdout and ignores everything else', () => {
    const out = ['', 'a::real: test', 'b: benchmark', 'noise', '2 tests, 0 benchmarks'].join('\r\n')
    expect(parseTestList(out, 'src/lib.rs')).toEqual([{ binary: 'src/lib.rs', name: 'a::real' }])
  })

  it('passes real tests: integration binary, nested module files, mod.rs, inline mods (positive)', () => {
    expect(check('server/tests/auth.rs::real')).toEqual([])
    expect(check('server/src/channels/tests/names.rs::real')).toEqual([])
    expect(check('server/src/channels/tests.rs::real')).toEqual([])
    expect(check('server/src/auth/throttle.rs::real')).toEqual([])
    expect(check('server/src/auth/sub/mod.rs::real')).toEqual([])
    expect(check('server/src/lib.rs::real')).toEqual([])
    expect(check('server/src/main.rs::real')).toEqual([])
  })

  it('fails a referenced test in a file outside the module tree (negative)', () => {
    expect(check('server/src/unused_guard.rs::real')[0]).toContain('module tree')
    expect(check('server/src/orphan/mod.rs::real')[0]).toContain('module tree')
  })

  it('refuses an unreferenced file whose test name collides with an inline mod test in lib.rs (negative)', () => {
    const r = makeRoot({
      'server/src/lib.rs': '#[cfg(test)]\nmod unused_guard {\n#[test]\nfn real() {}\n}\n',
      'server/src/unused_guard.rs': t,
    })
    const c = checker(r, [lib('unused_guard::real')])
    expect(c('server/src/lib.rs::real')).toEqual([])
    const errors = c('server/src/unused_guard.rs::real')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('not in the Rust module tree')
  })

  it('matches exact names: a child module test does not satisfy its parent file, and the wrong binary does not count', () => {
    const r = makeRoot({
      'server/src/lib.rs': 'mod a;\n',
      'server/src/a.rs': '#[cfg(test)]\nmod b;\n#[test]\nfn real() {}\n',
      'server/src/a/b.rs': t,
      'server/src/main.rs': '',
    })
    const onlyChild = checker(r, [lib('a::b::real')])
    expect(onlyChild('server/src/a/b.rs::real')).toEqual([])
    expect(onlyChild('server/src/a.rs::real')[0]).toContain('cargo test -- --list')
    const wrongBinary = checker(r, [{ binary: 'src/main.rs', name: 'a::real' }, lib('a::b::real')])
    expect(wrongBinary('server/src/a.rs::real')[0]).toContain('src/lib.rs')
  })

  it('refuses ambiguous module trees (fail closed)', () => {
    const cases: [string, Record<string, string>, string, string][] = [
      ['conditional mod declaration', { 'server/src/lib.rs': '#[cfg(feature = "x")]\nmod a;\n', 'server/src/a.rs': t }, 'server/src/a.rs', 'a::real'],
      ['declared twice', { 'server/src/lib.rs': 'mod a;\nmod a;\n', 'server/src/a.rs': t }, 'server/src/a.rs', 'a::real'],
      ['x.rs and x/mod.rs both exist', { 'server/src/lib.rs': 'mod a;\n', 'server/src/a.rs': t, 'server/src/a/mod.rs': t }, 'server/src/a.rs', 'a::real'],
      ['#[path]', { 'server/src/lib.rs': '#[path = "elsewhere.rs"]\nmod a;\nmod b;\n', 'server/src/b.rs': t }, 'server/src/b.rs', 'b::real'],
      ['include!', { 'server/src/lib.rs': 'include!("gen.rs");\nmod b;\n', 'server/src/b.rs': t }, 'server/src/b.rs', 'b::real'],
      ['unbalanced braces', { 'server/src/lib.rs': 'mod b;\nfn f() {\n', 'server/src/b.rs': t }, 'server/src/b.rs', 'b::real'],
    ]
    for (const [label, files, file, listedName] of cases) {
      const errors = checker(makeRoot(files), [lib(listedName)])(`${file}::real`)
      expect(errors, label).toHaveLength(1)
    }
  })

  it('does not let a same-named test in a/b/c.rs satisfy a reference to a/b.rs (negative)', () => {
    const r = makeRoot({
      'server/src/lib.rs': 'mod a;\n',
      'server/src/a.rs': 'mod b;\n',
      'server/src/a/b.rs': '#[cfg(test)]\nmod c;\n#[test]\nfn real() {}\n',
      'server/src/a/b/c.rs': t,
    })
    const c = checker(r, [lib('a::b::c::real')])
    expect(c('server/src/a/b/c.rs::real')).toEqual([])
    expect(c('server/src/a/b.rs::real')[0]).toContain('a::b::real')
    expect(c('server/src/a.rs::real')).toHaveLength(1)
  })

  it('requires a module declared by both lib.rs and main.rs to be listed in both binaries (negative)', () => {
    const r = makeRoot({
      'server/src/lib.rs': '#[cfg(test)]\nmod tests {\n#[test]\nfn real() {}\n}\n',
      'server/src/main.rs': '#[cfg(test)]\nmod tests {\n#[test]\nfn real() {}\n}\n',
    })
    const main = (name: string) => ({ binary: 'src/main.rs', name })
    expect(checker(r, [lib('tests::real'), main('tests::real')])('server/src/lib.rs::real')).toEqual([])
    expect(checker(r, [lib('tests::real')])('server/src/main.rs::real')[0]).toContain('src/main.rs')
    expect(checker(r, [main('tests::real')])('server/src/lib.rs::real')[0]).toContain('src/lib.rs')
  })

  it('parses stdout only: stderr from cargo is never merged into the list (negative)', () => {
    const bin = mkdtempSync(join(tmpdir(), 'inv-fakecargo-'))
    writeFileSync(join(bin, 'cargo'), '#!/bin/sh\necho "real: test"\necho "from_stderr: test" >&2\n', { mode: 0o755 })
    const r = makeRoot({ 'server/Cargo.toml': '[package]\nname = "x"\n', 'server/src/lib.rs': '' })
    const saved = process.env.PATH
    process.env.PATH = `${bin}:${saved}`
    try {
      expect(cargoList(r)).toEqual([{ binary: 'src/lib.rs', name: 'real' }])
    } finally {
      process.env.PATH = saved
    }
  })

  it('fails an unmappable path', () => {
    expect(check('server/tests/helpers/mod.rs::real')[0]).toContain('cannot be mapped')
  })

  it('fails when cargo is unavailable instead of skipping', () => {
    const saved = process.env.PATH
    process.env.PATH = ''
    try {
      expect(() => cargoList(root)).toThrow(/cargo is required/)
    } finally {
      process.env.PATH = saved
    }
  })
})
