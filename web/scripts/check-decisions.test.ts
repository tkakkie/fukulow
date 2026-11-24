// Regression tests for the decisions index and part checks.
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { checkDecisionDocs, checkDecisions } from './check-decisions.ts'
import { checkInvariants } from './check-invariants.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('checkDecisions continuation lines', () => {
  it('ignores headings, blank lines, prose and tables outside entries', () => {
    expect(checkDecisions('# Decisions\n\nIntro prose.\n\n| Column |\n')).toEqual([])
  })

  it('refuses an indented or lazy continuation of an entry, keeps intro prose and headings', () => {
    const md = '# Decisions\n\nIntro prose.\n\n## A\nSection note.\n\n- one\n  indented more\n- two\nlazy more\n\n  after blank\n## B\n- three\n'
    expect(checkDecisions(md)).toEqual([
      'line 9: continuation of the entry on line 8; keep each decision on one line',
      'line 11: continuation of the entry on line 10; keep each decision on one line',
      'line 13: indented line (a list continuation); keep each decision on one line',
    ])
  })
})

describe('split decisions', () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'dec-split-'))
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    put('docs/decisions.md', '# Decisions\n\nIntro.\n- [a](decisions/a.md): First area\n- [b](decisions/b.md): Second area\n')
    put('docs/decisions/a.md', '# A\n- First decision\n- Another decision\n')
    put('docs/decisions/b.md', '# B\n- Second decision\n')
    return { root, put }
  }

  it('accepts parts without an Entries in other parts section', () => {
    expect(checkDecisionDocs(fixture().root)).toEqual([])
  })

  it('accepts multiple prefixes and bullets for the same part', () => {
    const { root, put } = fixture()
    put('docs/decisions/b.md', '# B\n- Second decision\n\n## Entries in other parts\nOptional explanation.\n\n- [a](a.md): `First`, `Another`\n- [a](a.md): `First decision`\n')
    expect(checkDecisionDocs(root)).toEqual([])
  })

  it('matches a prefix against entry text with code-span backticks removed', () => {
    const { root, put } = fixture()
    put('docs/decisions/a.md', '# A\n- #57: `auth` owns the predicate\n- #57: `channels` owns grants\n')
    put('docs/decisions/b.md', '# B\n- Second decision\n\n## Entries in other parts\n- [a](a.md): `#57: auth owns`\n')
    expect(checkDecisionDocs(root)).toEqual([])
  })

  it('accepts cross-references without prose and excludes target cross-references from prefix matching', () => {
    const { root, put } = fixture()
    put('docs/decisions/a.md', '# A\n- First decision\n\n## Entries in other parts\n- [b](b.md): `Second`\n')
    put('docs/decisions/b.md', '# B\n- Second decision\n\n## Entries in other parts\n- [a](a.md): `First`\n')
    expect(checkDecisionDocs(root)).toEqual([])
  })

  type Put = (path: string, text: string) => void
  const cases: [string, (put: Put, root: string) => void, string][] = [
    ['missing index', (_put, root) => rmSync(join(root, 'docs/decisions.md')), 'docs/decisions.md: line 1: missing index'],
    ['missing directory', (_put, root) => rmSync(join(root, 'docs/decisions'), { recursive: true }), 'docs/decisions/: line 1: missing parts directory'],
    ['zero parts', (_put, root) => { rmSync(join(root, 'docs/decisions'), { recursive: true }); mkdirSync(join(root, 'docs/decisions')) }, 'docs/decisions/: line 1: no parts found'],
    ['non-md file', (put) => put('docs/decisions/c.txt', 'hidden'), 'docs/decisions/c.txt: line 1: expected a regular *.md part file'],
    ['subdirectory', (_put, root) => mkdirSync(join(root, 'docs/decisions/c.md')), 'docs/decisions/c.md: line 1: expected a regular *.md part file'],
    ['unlinked part', (put) => put('docs/decisions/c.md', '# C\n- Third decision\n'), 'docs/decisions/c.md: line 1: part is not linked from docs/decisions.md'],
    ['missing index target', (put) => put('docs/decisions.md', '- [a](decisions/a.md): A\n- [b](decisions/b.md): B\n- [c](decisions/c.md): C\n'), 'docs/decisions.md: line 3: unknown part: c.md'],
    ['duplicate index link', (put) => put('docs/decisions.md', '- [a](decisions/a.md): A\n- [b](decisions/b.md): B\n- [a](decisions/a.md): A again\n'), 'docs/decisions.md: line 3: part is linked more than once: a.md'],
    ['index entry', (put) => put('docs/decisions.md', '- [a](decisions/a.md): A\n- [b](decisions/b.md): B\n- Hidden decision\n'), 'docs/decisions.md: line 3: entries belong in parts, not the index'],
    ['indented index entry', (put) => put('docs/decisions.md', '- [a](decisions/a.md): A\n- [b](decisions/b.md): B\n\n  - Hidden decision\n'), 'docs/decisions.md: line 4: indented line (a list continuation); keep each decision on one line'],
    ['index lazy continuation', (put) => put('docs/decisions.md', '- [a](decisions/a.md): A\n- [b](decisions/b.md): B\nlazy continuation\n'), 'docs/decisions.md: line 3: continuation of the entry on line 2; keep each decision on one line'],
    ['empty part', (put) => put('docs/decisions/b.md', '# B\nProse only.\n'), 'docs/decisions/b.md: line 1: no entries found'],
    ['duplicate across parts', (put) => put('docs/decisions/b.md', '# B\n- First decision\n'), 'docs/decisions/b.md: line 2: duplicate entry text (first at docs/decisions/a.md: line 2): First decision'],
    ['duplicate within part', (put) => put('docs/decisions/b.md', '# B\n- Second decision\n- Second decision\n'), 'docs/decisions/b.md: line 3: duplicate entry text (first at docs/decisions/b.md: line 2): Second decision'],
    ['lazy continuation', (put) => put('docs/decisions/b.md', '# B\n- Second decision\nlazy continuation\n'), 'docs/decisions/b.md: line 3: continuation of the entry on line 2; keep each decision on one line'],
    ['indented continuation', (put) => put('docs/decisions/b.md', '# B\n- Second decision\n  continuation\n'), 'docs/decisions/b.md: line 3: continuation of the entry on line 2; keep each decision on one line'],
    ['indented line', (put) => put('docs/decisions/b.md', '# B\n  indented\n- Second decision\n'), 'docs/decisions/b.md: line 2: indented line (a list continuation); keep each decision on one line'],
  ]
  it.each(cases)('rejects %s (negative)', (_label, change, error) => {
    const { root, put } = fixture()
    change(put, root)
    expect(checkDecisionDocs(root)).toContain(error)
  })

  it.each([
    ['mismatched index label', '- [wrong](decisions/a.md): A'],
    ['index link without description', '- [a](decisions/a.md): '],
    ['index link with wrong path', '- [a](a.md): A'],
  ])('rejects %s (negative)', (_label, bullet) => {
    const { root, put } = fixture()
    put('docs/decisions.md', bullet + '\n- [b](decisions/b.md): B\n')
    expect(checkDecisionDocs(root)).toContain('docs/decisions.md: line 1: entries belong in parts, not the index')
  })

  it.each([
    ['unknown part', '- [c](c.md): `First`', 'unknown part: c.md'],
    ['self link', '- [b](b.md): `Second`', 'cross-reference must link to another part'],
    ['missing prefix', '- [a](a.md): `Missing`', 'entry prefix not found in a.md: Missing'],
    ['ambiguous prefix', '- [a](a.md): `Shared`', 'entry prefix is ambiguous in a.md: Shared'],
    ['target cross-reference prefix', '- [a](a.md): `[b]`', 'entry prefix not found in a.md: [b]'],
    ['malformed bullet', '- [a](a.md): `First`, Another', 'expected an Entries in other parts bullet'],
    ['mismatched label', '- [wrong](a.md): `First`', 'expected an Entries in other parts bullet'],
    ['empty prefix', '- [a](a.md): ``', 'expected an Entries in other parts bullet'],
    ['missing separator space', '- [a](a.md): `First`,`Another`', 'expected an Entries in other parts bullet'],
    ['repeated prose', 'Another prose line.', 'expected an Entries in other parts bullet'],
    ['section after references', '## Later section', 'expected an Entries in other parts bullet'],
  ])('rejects cross-reference %s (negative)', (_label, bullet, reason) => {
    const { root, put } = fixture()
    put('docs/decisions/a.md', '# A\n- First decision\n- Another decision\n- Shared one\n- Shared two\n\n## Entries in other parts\n- [b](b.md): `Second`\n')
    put('docs/decisions/b.md', '# B\n- Second decision\n\n## Entries in other parts\nOptional explanation.\n\n' + bullet + '\n')
    expect(checkDecisionDocs(root).some((error) => error.startsWith('docs/decisions/b.md: line 7: ' + reason))).toBe(true)
  })

  it('requires the decisions index and directory through checkInvariants (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants.md', '[a](invariants/a.md)\n')
    put('docs/invariants/a.md', '| Rule | Test |\n|---|---|\n| r | `server/tests/a.rs::ok_test` |\n')
    put('server/tests/a.rs', '#[test]\nfn ok_test() {}\n')
    put('web/x.test.ts', '')
    rmSync(join(root, 'docs/decisions.md'))
    rmSync(join(root, 'docs/decisions'), { recursive: true })
    expect(checkInvariants(root)).toEqual([
      'docs/decisions.md: line 1: missing index',
      'docs/decisions/: line 1: missing parts directory',
    ])
  })
})

describe('the real decisions docs', () => {
  it('checks the required index, all parts, entries and cross-references', () => {
    expect(checkDecisionDocs(resolve(import.meta.dirname, '../..'))).toEqual([])
  })
})
