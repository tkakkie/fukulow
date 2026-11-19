import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUDGETS_KIB, checkBudgetChanges, checkDocBudgets, parseBudgets, TOTAL_BUDGET_KIB } from './check-doc-budgets.ts'

describe('per-file documentation budgets', () => {
  const budgets = new Map([['AGENTS.md', 1], ['docs/spec/area.md', 1]])
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-budgets-'))
    mkdirSync(join(root, 'docs/spec'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n')
    writeFileSync(join(root, 'docs/spec/area.md'), 'é'.repeat(512))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('accepts a file at its byte limit and ignores files outside docs other than AGENTS.md', () => {
    writeFileSync(join(root, 'README.md'), '# Readme\n')
    expect(checkDocBudgets(root, budgets)).toEqual([])
  })

  it('rejects an unbudgeted non-Markdown file or extension variant under docs', () => {
    writeFileSync(join(root, 'docs/notes.txt'), 'Notes\n')
    writeFileSync(join(root, 'docs/spec/extra.MD'), 'x')
    expect(checkDocBudgets(root, budgets)).toEqual([
      'docs/notes.txt: 6 bytes, no budget. Add a per-file budget (docs/workflow.md §13).',
      'docs/spec/extra.MD: 1 bytes, no budget. Add a per-file budget (docs/workflow.md §13).',
    ])
  })

  it('rejects a symlink under docs even when it has a budget', () => {
    rmSync(join(root, 'docs/spec/area.md'))
    symlinkSync(join(root, 'AGENTS.md'), join(root, 'docs/spec/area.md'))
    expect(checkDocBudgets(root, budgets)).toEqual([
      'docs/spec/area.md: not a regular file (symlink or special file). Docs must be plain files (docs/workflow.md §13).',
    ])
  })

  it('rejects a file one byte over budget even when its character count fits', () => {
    writeFileSync(join(root, 'docs/spec/area.md'), 'é'.repeat(512) + 'a')
    expect(checkDocBudgets(root, budgets)).toEqual([
      'docs/spec/area.md: 1025 bytes exceeds its 1 KiB budget. Prune or merge first. A split needs a reason in the PR and its own approved Issue (docs/workflow.md §13).',
    ])
  })

  it('rejects a new Markdown file without a budget', () => {
    writeFileSync(join(root, 'docs/spec/new.md'), '# New\n')
    expect(checkDocBudgets(root, budgets)).toEqual([
      'docs/spec/new.md: 6 bytes, no budget. Add a per-file budget (docs/workflow.md §13).',
    ])
  })

  it('rejects a budget for a missing file', () => {
    rmSync(join(root, 'docs/spec/area.md'))
    expect(checkDocBudgets(root, budgets)).toEqual([
      'docs/spec/area.md: file missing for a 1 KiB budget. Remove the stale budget or restore the file.',
    ])
  })
})

describe('total documentation budget', () => {
  const budgets = new Map([['AGENTS.md', 2], ['docs/spec/area.md', 2]])
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-total-'))
    mkdirSync(join(root, 'docs/spec'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), 'a'.repeat(1024))
    writeFileSync(join(root, 'docs/spec/area.md'), 'é'.repeat(512))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('accepts a total at its byte limit', () => {
    expect(checkDocBudgets(root, budgets, 2)).toEqual([])
  })

  it('rejects a total one byte over even when every file fits its own budget', () => {
    writeFileSync(join(root, 'docs/spec/area.md'), 'é'.repeat(512) + 'a')
    expect(checkDocBudgets(root, budgets, 2)).toEqual([
      'total: 2049 bytes exceeds the 2 KiB total budget. Prune or merge first. Raising it needs the docs:budget-raise label and a linked maintainer approval (docs/workflow.md §13).',
    ])
  })

  it('counts a split part toward the total', () => {
    writeFileSync(join(root, 'docs/spec/part.md'), 'x')
    expect(checkDocBudgets(root, new Map([...budgets, ['docs/spec/part.md', 1]]), 2)).toEqual([
      'total: 2049 bytes exceeds the 2 KiB total budget. Prune or merge first. Raising it needs the docs:budget-raise label and a linked maintainer approval (docs/workflow.md §13).',
    ])
  })

  it('keeps the fixed #562 baseline constant', () => {
    expect(TOTAL_BUDGET_KIB).toBe(684)
  })
})

describe('budget changes against the PR base', () => {
  const rule = 'needs the docs:budget-raise label and a linked maintainer approval (docs/workflow.md §13).'
  const base = { files: new Map([['AGENTS.md', 10], ['docs/spec.md', 4]]), totalKiB: 100 }
  const head = (files: [string, number][], totalKiB: number | null = 100) => ({ files: new Map(files), totalKiB: totalKiB ?? undefined })

  it('passes unchanged budgets', () => {
    expect(checkBudgetChanges(base, head([['AGENTS.md', 10], ['docs/spec.md', 4]]), false)).toEqual([])
  })

  it('rejects a raised per-file budget without the label', () => {
    expect(checkBudgetChanges(base, head([['AGENTS.md', 11], ['docs/spec.md', 4]]), false)).toEqual([
      `AGENTS.md: budget raised from 10 to 11 KiB ${rule}`,
    ])
  })

  it('rejects a new file budget without the label', () => {
    expect(checkBudgetChanges(base, head([['AGENTS.md', 10], ['docs/spec.md', 4], ['docs/spec/new.md', 1]]), false)).toEqual([
      `docs/spec/new.md: new 1 KiB budget ${rule}`,
    ])
  })

  it('rejects a rename, which removes one budget and adds another, without the label', () => {
    expect(checkBudgetChanges(base, head([['AGENTS.md', 10], ['docs/index.md', 4]]), false)).toEqual([
      `docs/index.md: new 4 KiB budget ${rule}`,
    ])
  })

  it('rejects a raised or removed total budget without the label', () => {
    const files: [string, number][] = [['AGENTS.md', 10], ['docs/spec.md', 4]]
    expect(checkBudgetChanges(base, head(files, 101), false)).toEqual([`total: budget raised from 100 to 101 KiB ${rule}`])
    expect(checkBudgetChanges(base, head(files, null), false)).toEqual([`total: total budget removed ${rule}`])
  })

  it('passes raises, new budgets and a raised total with the label', () => {
    expect(checkBudgetChanges(base, head([['AGENTS.md', 11], ['docs/spec.md', 4], ['docs/spec/new.md', 1]], 101), true)).toEqual([])
  })

  it('passes lowered and removed budgets and a lowered total without the label', () => {
    expect(checkBudgetChanges(base, head([['AGENTS.md', 9]], 99), false)).toEqual([])
  })

  it('passes a base that has no total budget yet (the PR that introduces it)', () => {
    expect(checkBudgetChanges({ files: base.files }, head([['AGENTS.md', 10], ['docs/spec.md', 4]], 684), false)).toEqual([])
  })
})

describe('parsing the base budgets', () => {
  it('reads the same budgets and total as this script exports', () => {
    const parsed = parseBudgets(readFileSync(join(import.meta.dirname, 'check-doc-budgets.ts'), 'utf8'))
    expect(parsed.files).toEqual(BUDGETS_KIB)
    expect(parsed.totalKiB).toBe(TOTAL_BUDGET_KIB)
  })

  it('reads a base without a total budget', () => {
    expect(parseBudgets("const BUDGETS_KIB = new Map<string, number>([\n  ['AGENTS.md', 10],\n])")).toEqual({
      files: new Map([['AGENTS.md', 10]]),
      totalKiB: undefined,
    })
  })

  it('fails closed when the map is missing or empty', () => {
    expect(() => parseBudgets('export {}')).toThrow('BUDGETS_KIB map not found')
    expect(() => parseBudgets('const BUDGETS_KIB = new Map<string, number>([\n])')).toThrow('BUDGETS_KIB map has no entries')
  })
})
