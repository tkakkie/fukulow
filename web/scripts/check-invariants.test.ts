import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { checkInvariants, checkRows, parseInvariants, rustTests, tsTests, collectKnownTests, parseCargoList, reconcileWithCargoList, cargoList, type Known } from './check-invariants.ts'
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
      { name: 'a', ignored: false, conditional: false },
      { name: 'b', ignored: true, conditional: false },
      { name: 'c', ignored: true, conditional: false },
      { name: 'd', ignored: false, conditional: false },
      { name: 'e', ignored: false, conditional: true },
      { name: 'f', ignored: false, conditional: true },
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

describe('reconciliation with the cargo test list', () => {
  const root = mkdtempSync(join(tmpdir(), 'inv-list-'))
  const put = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const t = '#[test]\nfn real() {}\n'
  mkdirSync(join(root, 'web'))
  put('server/tests/auth.rs', t)
  put('server/tests/helpers/mod.rs', t)
  put('server/src/channels/tests/names.rs', t)
  put('server/src/auth/throttle.rs', t)
  put('server/src/unused_guard.rs', t)
  put('server/src/orphan/mod.rs', t)
  const output = [
    '   Compiling x v0.1.0',
    '     Running unittests src/lib.rs (target/debug/deps/x-1)',
    'channels::tests::names::real: test',
    'auth::throttle::tests::real: test',
    '2 tests, 0 benchmarks',
    '     Running tests/auth.rs (target/debug/deps/auth-2)',
    'real: test',
    '   Doc-tests x',
    'src/lib.rs - doc (line 1): test',
  ].join('\n')
  const listed = parseCargoList(output)
  const known = reconcileWithCargoList(collectKnownTests(root), listed)
  const check = (ref: string) => checkRows(parseInvariants(`| Rule | Test |\n|---|---|\n| r | \`${ref}\` |`).rows, known)

  it('parses binaries and ignores doc-tests', () => {
    expect(listed).toEqual([
      { binary: 'src/lib.rs', name: 'channels::tests::names::real' },
      { binary: 'src/lib.rs', name: 'auth::throttle::tests::real' },
      { binary: 'tests/auth.rs', name: 'real' },
    ])
  })

  it('passes real tests: integration binary, nested module file, inline tests mod (positive)', () => {
    expect(check('server/tests/auth.rs::real')).toEqual([])
    expect(check('server/src/channels/tests/names.rs::real')).toEqual([])
    expect(check('server/src/auth/throttle.rs::real')).toEqual([])
  })

  it('fails a referenced test in a file outside the module tree (negative)', () => {
    expect(check('server/src/unused_guard.rs::real')[0]).toContain('cargo test -- --list')
    expect(check('server/src/orphan/mod.rs::real')[0]).toContain('cargo test -- --list')
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
