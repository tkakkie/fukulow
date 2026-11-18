import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkDocBudgets } from './check-doc-budgets.ts'

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
