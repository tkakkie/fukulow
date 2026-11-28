// Regression tests for reconciling the static Rust scan with `cargo nextest list`.
import { describe, expect, it } from 'vitest'
import { checkRows, parseInvariants, collectKnownTests } from './check-invariants.ts'
import { reconcileWithCargoList, cargoList, type ListedTest } from './cargo-list.ts'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('reconciliation with the nextest list', () => {
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
    expect(onlyChild('server/src/a.rs::real')[0]).toContain('cargo nextest list')
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

  it('uses the CI build flags and lists only runnable server tests from stdout', () => {
    const bin = mkdtempSync(join(tmpdir(), 'inv-fakecargo-'))
    const test = { kind: 'test', 'filter-match': { status: 'matches' } }
    const suite = { 'package-name': 'x', 'binary-name': 'x', status: 'listed', testcases: { real: test } }
    const output = JSON.stringify({ 'rust-suites': {
      x: { ...suite, kind: 'lib', testcases: {
        'a::real': test,
        ignored: { kind: 'test', 'filter-match': { status: 'mismatch', reason: 'ignored' } },
        filtered: { kind: 'test', 'filter-match': { status: 'mismatch', reason: 'default-filter' } },
        benchmark: { ...test, kind: 'benchmark' },
      } },
      'x::bin/x': { ...suite, kind: 'bin' },
      'x::sample': { ...suite, kind: 'test', 'binary-name': 'sample' },
      other: { ...suite, kind: 'lib', 'package-name': 'other' },
    } })
    writeFileSync(join(bin, 'cargo'), `#!/bin/sh
printf '%s\\n' "$@" > cargo-args
printf '%s\\n' '${output}'
echo 'unexpected stderr' >&2
`, { mode: 0o755 })
    const r = makeRoot({ 'server/Cargo.toml': '[package]\nname = "x"\n' })
    const saved = process.env.PATH
    process.env.PATH = `${bin}:${saved}`
    try {
      expect(cargoList(r)).toEqual([
        { binary: 'src/lib.rs', name: 'a::real' },
        { binary: 'src/main.rs', name: 'real' },
        { binary: 'tests/sample.rs', name: 'real' },
      ])
      expect(readFileSync(join(r, 'cargo-args'), 'utf8').trim().split('\n')).toEqual([
        'nextest', 'list', '--locked', '--features', 'fukulow-client-core/wasm', '--message-format', 'json',
      ])
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
