import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { checkInvariants, checkRows, parseInvariants, rustTestNames, tsTestTitles } from './check-invariants.ts'

describe('rustTestNames', () => {
  it('finds #[test], #[tokio::test] and #[sqlx::test] functions', () => {
    const src = `
#[test]
fn a() {}
#[tokio::test]
async fn b() {}
#[sqlx::test(migrations = "./m")]
async fn c(pool: PgPool) {}
#[tokio::test]
#[ignore]
pub async fn d() {}
`
    expect(rustTestNames(src)).toEqual(['a', 'b', 'c', 'd'])
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
    expect(rustTestNames(src)).toEqual(['after_char_literal'])
  })
})

describe('tsTestTitles', () => {
  it('finds test( and it( titles, including modifiers', () => {
    const src = `
import { test, it } from 'x'
test('first', async () => {})
it("second", () => {})
test.skip(\`third\`, () => {})
`
    expect(tsTestTitles(src)).toEqual(['first', 'second', 'third'])
  })

  it('ignores titles in comments and strings (negative)', () => {
    const src = `
// test('in comment', () => {})
const s = "test('in string', () => {})"
const t = \`it('in template', () => {})\`
describe('only a group', () => {})
other('not a test', () => {})
`
    expect(tsTestTitles(src)).toEqual([])
  })
})

describe('docs/invariants.md rows', () => {
  const md = [
    '| Rule | Test |',
    '|---|---|',
    '| real | `exists_one` , `exists_two` (note) |',
    '| later | (todo) |',
  ].join('\n')

  it('accepts known names and (todo) rows', () => {
    const { rows, errors } = parseInvariants(md)
    expect(errors).toEqual([])
    expect(checkRows(rows, new Set(['exists_one', 'exists_two']))).toEqual([])
  })

  it('fails an unknown name, naming the row and the name (negative)', () => {
    const { rows } = parseInvariants(md)
    const errors = checkRows(rows, new Set(['exists_one']))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('line 3')
    expect(errors[0]).toContain('exists_two')
  })

  it('fails a row that names nothing and is not (todo) (negative)', () => {
    const { errors } = parseInvariants('| Rule | Test |\n|---|---|\n| r | nothing here |')
    expect(errors).toHaveLength(1)
  })
})

describe('the real docs/invariants.md', () => {
  it('names only existing tests', () => {
    expect(checkInvariants(resolve(import.meta.dirname, '../..'))).toEqual([])
  })
})
