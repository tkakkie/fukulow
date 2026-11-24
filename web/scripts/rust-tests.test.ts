// Regression tests for the Rust test and module-tree scan.
import { describe, expect, it } from 'vitest'
import { blankRustCommentsAndStrings, rustTests, scanModules } from './rust-tests.ts'

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
#[fukulow_test::test(migrations = false)]
async fn managed(pool: PgPool) {}
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
      { name: 'managed', ignored: false, conditional: false, inline: [] },
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
