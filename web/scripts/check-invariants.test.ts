// Regression tests for executable invariant references, Rule text/IDs and distinct cross-part row resolution.
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { checkInvariants, checkRows, parseInvariants, collectKnownTests, type Known } from './check-invariants.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  it('separates a valid ID tag from Rule text', () => {
    const rule = 'A critical guarantee'
    const { rows, errors } = parseInvariants(ruleRow('{#row-123} ' + rule))
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({ id: 'row-123', rule })
  })

  it.each(['{#Bad_ID} text', '{#} text', '{#valid}text', '{#valid}', '{#-bad} text', '{#bad--id} text', '{#bad-} text', '{#unclosed text', '{#valid}\ttext'])(
    'rejects malformed rule ID tag %s (negative)', (rule) => {
      expect(parseInvariants(ruleRow(rule)).errors).toEqual([`line 3: malformed rule ID tag: ${rule}`])
    },
  )

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

describe('split invariants', () => {
  const table = (rule: string, ref = 'server/tests/a.rs::ok_test') =>
    `| Rule | Test |\n|---|---|\n| ${rule} | \`${ref}\` |\n`
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'inv-split-'))
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    put('docs/decisions.md', '# Decisions\n- [a](decisions/a.md): First area\n')
    put('docs/decisions/a.md', '# A\n- First decision\n')
    put('docs/invariants.md', '[a](invariants/a.md)\n[b](invariants/b.md)\n')
    put('docs/invariants/a.md', table('first'))
    put('docs/invariants/b.md', table('second'))
    put('server/tests/a.rs', '#[test]\nfn ok_test() {}\n#[test]\nfn other_test() {}\n')
    put('web/x.test.ts', "it.skip('skipped', () => {})\n")
    return { root, put }
  }

  it('accepts parts without a Rows in other parts section', () => {
    expect(checkInvariants(fixture().root)).toEqual([])
  })

  it('accepts valid cross-references', () => {
    const { root, put } = fixture()
    put('docs/invariants/b.md', table('second') + '\n## Rows in other parts\n\nRows that also govern this area, listed by a test name unique to the row in that part, or by its `#id` when no such name exists.\n\n- [a](a.md): `ok_test`\n')
    expect(checkInvariants(root)).toEqual([])
  })

  const cases: [string, (put: (path: string, text: string) => void, root: string) => void, string][] = [
    ['unlinked part', (put) => put('docs/invariants.md', '[a](invariants/a.md)\n'),
      'docs/invariants/b.md: line 1: part is not linked from docs/invariants.md'],
    ['missing index target', (put) => put('docs/invariants.md', '[a](invariants/a.md)\n[b](invariants/b.md)\n[c](invariants/c.md)\n'),
      'docs/invariants.md: line 3: unknown part: c.md'],
    ['non-md entry', (put) => put('docs/invariants/c.txt', 'hidden'),
      'docs/invariants/c.txt: line 1: expected a regular *.md part file'],
    ['subdirectory', (_put, root) => mkdirSync(join(root, 'docs/invariants/c.md')),
      'docs/invariants/c.md: line 1: expected a regular *.md part file'],
    ['missing directory', (put, root) => { rmSync(join(root, 'docs/invariants'), { recursive: true }); put('docs/invariants.md', '# Index\n') },
      'docs/invariants/: line 1: missing parts directory'],
    ['zero parts', (put, root) => { rmSync(join(root, 'docs/invariants'), { recursive: true }); mkdirSync(join(root, 'docs/invariants')); put('docs/invariants.md', '# Index\n') },
      'docs/invariants/: line 1: no parts found'],
    ['index table row', (put) => put('docs/invariants.md', '[a](invariants/a.md)\n[b](invariants/b.md)\n| hidden | (todo) |\n'),
      'docs/invariants.md: line 3: tables belong in parts, not the index'],
    ['empty part', (put) => put('docs/invariants/b.md', '# Empty\n'),
      'docs/invariants/b.md: line 1: no rows found'],
    ['missing test in second part', (put) => put('docs/invariants/b.md', table('second', 'server/tests/a.rs::missing')),
      'docs/invariants/b.md: line 3: `server/tests/a.rs::missing` is not a test definition at that path (rule: second)'],
    ['skipped test in second part', (put) => put('docs/invariants/b.md', table('second', 'web/x.test.ts::skipped')),
      'docs/invariants/b.md: line 3: `web/x.test.ts::skipped` does not count: skipped (skip/fixme/todo, or inside a skipped describe) (rule: second)'],
    ['malformed reference in second part', (put) => put('docs/invariants/b.md', table('second', 'ok_test')),
      'docs/invariants/b.md: line 3: `ok_test` is not in path::test_name form, e.g. server/tests/auth.rs::some_test (rule: second)'],
    ['duplicate Rule', (put) => put('docs/invariants/b.md', table('first')),
      'docs/invariants/b.md: line 3: duplicate Rule text (first at docs/invariants/a.md: line 3): first'],
  ]
  it.each(cases)('rejects %s (negative)', (_label, change, error) => {
    const { root, put } = fixture()
    change(put, root)
    expect(checkInvariants(root)).toEqual([error])
  })

  describe('contract/realtime test citations (#892)', () => {
    const contract = (refs: string[]) =>
      JSON.stringify({ kind: 'k', scenarios: [{ id: 'scenario-a', rust: { existing_tests: refs } }] }, null, 2) + '\n'
    it('accepts citations of running tests', () => {
      const { root, put } = fixture()
      put('contract/realtime/delivery/x.json', contract(['server/tests/a.rs::ok_test']))
      expect(checkInvariants(root)).toEqual([])
    })
    it('rejects a citation of a missing test (negative)', () => {
      const { root, put } = fixture()
      put('contract/realtime/delivery/x.json', contract(['server/tests/a.rs::ok_test', 'server/tests/a.rs::moved_away']))
      expect(checkInvariants(root)).toEqual([
        'contract/realtime/delivery/x.json: line 9: `server/tests/a.rs::moved_away` is not a test definition at that path (scenario: scenario-a)',
      ])
    })
    it('reports the own line of each scenario when one missing test is cited twice (negative)', () => {
      const { root, put } = fixture()
      const two = { kind: 'k', scenarios: [
        { id: 'first', rust: { existing_tests: ['server/tests/a.rs::moved_away'] } },
        { id: 'second', rust: { existing_tests: ['server/tests/a.rs::moved_away'] } },
      ] }
      put('contract/realtime/delivery/x.json', JSON.stringify(two, null, 2) + '\n')
      expect(checkInvariants(root).map((e) => e.replace(/: `.*/, ''))).toEqual([
        'contract/realtime/delivery/x.json: line 8',
        'contract/realtime/delivery/x.json: line 16',
      ])
    })
    it('rejects a citation of a skipped test and invalid JSON (negative)', () => {
      const { root, put } = fixture()
      put('contract/realtime/x.json', contract(['web/x.test.ts::skipped']))
      put('contract/realtime/y.json', '{')
      const errors = checkInvariants(root)
      expect(errors).toHaveLength(2)
      expect(errors[0]).toMatch(/^contract\/realtime\/x\.json: line 8: `web\/x\.test\.ts::skipped` does not count: skipped/)
      expect(errors[1]).toMatch(/^contract\/realtime\/y\.json: line 1: invalid JSON/)
    })
    it('rejects a citation the cargo list does not run (negative)', () => {
      const { root, put } = fixture()
      put('contract/realtime/x.json', contract(['server/tests/a.rs::other_test']))
      const errors = checkInvariants(root, [{ binary: 'tests/a.rs', name: 'ok_test' }])
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/^contract\/realtime\/x\.json: line \d+: `server\/tests\/a\.rs::other_test`.*\(scenario: scenario-a\)/)
    })
  })

  it('rejects cargo omission only in second part (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/b.md', table('second', 'server/tests/a.rs::other_test'))
    expect(checkInvariants(root, [{ binary: 'tests/a.rs', name: 'ok_test' }])).toEqual([
      'docs/invariants/b.md: line 3: `server/tests/a.rs::other_test` does not count: is not runnable in `cargo nextest list` for tests/a.rs as `other_test` (cfg-excluded, not compiled, or skipped) (rule: second)',
    ])
  })

  it.each([
    ['unknown part', '- [c](c.md): `ok_test`', 'unknown part: c.md'],
    ['self link', '- [b](b.md): `ok_test`', 'cross-reference must link to another part'],
    ['dangling name', '- [a](a.md): `other_test`', 'test name not found in a.md: other_test'],
    ['malformed line', 'not a bullet', 'expected a Rows in other parts bullet'],
    ['malformed bullet', '- [a](a.md): `ok_test`, other_test', 'expected a Rows in other parts bullet'],
    ['mismatched label', '- [wrong](a.md): `ok_test`', 'expected a Rows in other parts bullet'],
    ['repeated prose', 'Rows that also govern this area, listed by a test name unique to the row in that part, or by its `#id` when no such name exists.', 'expected a Rows in other parts bullet'],
  ])('rejects cross-reference %s (negative)', (_label, bullet, reason) => {
    const { root, put } = fixture()
    put('docs/invariants/b.md', table('second') + '\n## Rows in other parts\n\nRows that also govern this area, listed by a test name unique to the row in that part, or by its `#id` when no such name exists.\n\n' + bullet + '\n')
    expect(checkInvariants(root)).toEqual(['docs/invariants/b.md: line 9: ' + reason])
  })

  const cross = (target: string, tokens: string) => `\n## Rows in other parts\n\n- [${target}](${target}.md): ${tokens}\n`

  it('resolves a unique test name even when two references in that row have the same suffix', () => {
    const { root, put } = fixture()
    put('server/tests/b.rs', '#[test]\nfn ok_test() {}\n')
    put('docs/invariants/a.md', '| Rule | Test |\n|---|---|\n| first | `server/tests/a.rs::ok_test`, `server/tests/b.rs::ok_test` |\n')
    put('docs/invariants/b.md', table('second') + cross('a', '`ok_test`'))
    expect(checkInvariants(root)).toEqual([])
  })

  it('rejects a test name matching zero rows (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/b.md', table('second') + cross('a', '`ok`'))
    expect(checkInvariants(root)).toEqual(['docs/invariants/b.md: line 7: test name not found in a.md: ok'])
  })

  it('rejects the pre-#282 prose line, which promised only test names (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('first'))
    put('docs/invariants/b.md', table('second') + '\n## Rows in other parts\n\nRows that also govern this area, listed by a test name from the row in that part.\n\n- [a](a.md): `ok_test`\n')
    expect(checkInvariants(root)).toEqual(['docs/invariants/b.md: line 7: expected a Rows in other parts bullet'])
  })

  it('rejects a test name matching two rows (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('first') + table('another'))
    put('docs/invariants/b.md', table('second') + cross('a', '`ok_test`'))
    expect(checkInvariants(root)).toEqual([
      'docs/invariants/b.md: line 7: test name matches 2 rows in a.md; reference the row by its #id instead: ok_test',
    ])
  })

  it('resolves #id to its row even when its test name is shared by another row', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('{#first-row} first') + table('another'))
    put('docs/invariants/b.md', table('second') + cross('a', '`#first-row`'))
    expect(checkInvariants(root)).toEqual([])
  })

  it('rejects duplicate rule IDs across parts and names both places (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('{#shared} first') + table('twin a') + cross('b', '`#shared`'))
    put('docs/invariants/b.md', table('{#shared} second') + table('twin b') + cross('a', '`#shared`'))
    expect(checkInvariants(root)).toEqual([
      'docs/invariants/b.md: line 3: duplicate rule ID (first at docs/invariants/a.md: line 3): #shared',
    ])
  })

  it('rejects duplicate Rule text after stripping the ID tag (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('{#first-row} first') + table('twin'))
    put('docs/invariants/b.md', table('first') + cross('a', '`#first-row`'))
    expect(checkInvariants(root)).toEqual([
      'docs/invariants/b.md: line 3: duplicate Rule text (first at docs/invariants/a.md: line 3): first',
    ])
  })

  it('rejects a rule ID reference not found in the linked part (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/b.md', table('second') + cross('a', '`#missing`'))
    expect(checkInvariants(root)).toEqual(['docs/invariants/b.md: line 7: rule ID not found in a.md: #missing'])
  })

  it('rejects a rule ID that exists only in another part (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('first') + cross('b', '`#elsewhere`'))
    put('docs/invariants/b.md', table('{#elsewhere} second') + table('twin') + cross('a', '`#elsewhere`'))
    expect(checkInvariants(root)).toEqual(['docs/invariants/b.md: line 10: rule ID not found in a.md: #elsewhere'])
  })

  it('rejects an unreferenced rule ID (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('{#unused} first') + table('twin'))
    expect(checkInvariants(root)).toEqual(['docs/invariants/a.md: line 3: rule ID is never referenced: #unused'])
  })

  it.each([
    ['`#first-row`, `#first-row`', table('{#first-row} first') + table('twin')],
    ['`ok_test`, `ok_test`', table('first')],
  ])(
    'rejects the same row twice in one bullet: %s (negative)', (tokens, a) => {
      const { root, put } = fixture()
      put('docs/invariants/a.md', a)
      put('docs/invariants/b.md', table('second') + cross('a', tokens))
      const last = tokens.slice(tokens.lastIndexOf(', ') + 2).slice(1, -1)
      expect(checkInvariants(root)).toEqual(['docs/invariants/b.md: line 7: same row referenced twice in a.md: ' + last])
    },
  )

  it('allows referencing the same row in separate bullets', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('{#first-row} first') + table('twin'))
    put('docs/invariants/b.md', table('second') + cross('a', '`#first-row`') + '- [a](a.md): `#first-row`\n')
    expect(checkInvariants(root)).toEqual([])
  })

  it('rejects an ID on a row that a unique test name already identifies (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('{#first-row} first'))
    put('docs/invariants/b.md', table('second') + cross('a', '`#first-row`'))
    expect(checkInvariants(root)).toEqual([
      'docs/invariants/a.md: line 3: rule ID is unnecessary; reference the row by its unique test name ok_test: #first-row',
    ])
  })

  it('rejects extra whitespace after an ID tag, so the Rule text stays canonical (negative)', () => {
    const { root, put } = fixture()
    put('docs/invariants/a.md', table('{#first-row}  first') + table('twin'))
    expect(checkInvariants(root)).toContain('docs/invariants/a.md: line 3: malformed rule ID tag: {#first-row}  first')
  })
})

describe('the real docs/invariants.md', () => {
  it('names only existing, executable tests (static scan; the CLI also reconciles with cargo)', () => {
    expect(checkInvariants(resolve(import.meta.dirname, '../..'))).toEqual([])
  })
})

describe('checkInvariants also checks the decisions index and parts', () => {
  const fixture = (decisions: string) => {
    const root = mkdtempSync(join(tmpdir(), 'inv-dec-'))
    mkdirSync(join(root, 'docs/invariants'), { recursive: true })
    mkdirSync(join(root, 'server/tests'), { recursive: true })
    mkdirSync(join(root, 'web'), { recursive: true })
    writeFileSync(join(root, 'server/tests/a.rs'), '#[test]\nfn ok_test() {}\n')
    writeFileSync(join(root, 'docs/invariants.md'), '[a](invariants/a.md)\n')
    writeFileSync(join(root, 'docs/invariants/a.md'), '| Rule | Test |\n|---|---|\n| r | \`server/tests/a.rs::ok_test\` |\n')
    mkdirSync(join(root, 'docs/decisions'))
    writeFileSync(join(root, 'docs/decisions.md'), '# Decisions\n- [a](decisions/a.md): First area\n')
    writeFileSync(join(root, 'docs/decisions/a.md'), decisions)
    return root
  }

  it('keeps reporting invariants reference errors unchanged alongside decision errors', () => {
    const root = fixture('- Decision\nlazy continuation\n')
    writeFileSync(join(root, 'docs/invariants/a.md'), '| Rule | Test |\n|---|---|\n| r | \`server/tests/a.rs::missing\` |\n')
    const errors = checkInvariants(root)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('not a test definition')
    expect(errors[1]).toBe('docs/decisions/a.md: line 2: continuation of the entry on line 1; keep each decision on one line')
  })
})

describe('script invariant CI coverage', () => {
  it('requires the CI glob and refuses skipped script tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'inv-scripts-'))
    try {
      for (const dir of ['server', 'web', 'scripts', '.github/workflows']) mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, 'scripts/x.test.ts'), "test('runs', () => {})\ntest.skip('skipped', () => {})\ntest('options', { skip: true }, () => {})\n")
      const ref = 'scripts/x.test.ts::runs'
      expect(collectKnownTests(root).get(ref)?.runs).toBe(false)
      writeFileSync(join(root, '.github/workflows/ci.yml'), '  run: node --test scripts/*.test.ts\n')
      expect(collectKnownTests(root).get(ref)?.runs).toBe(true)
      expect(collectKnownTests(root).get('scripts/x.test.ts::skipped')?.runs).toBe(false)
      expect(collectKnownTests(root).get('scripts/x.test.ts::options')?.runs).toBe(false)
      writeFileSync(join(root, '.github/workflows/ci.yml'), '  run: node --test scripts/other.test.ts\n')
      expect(collectKnownTests(root).get(ref)?.runs).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
