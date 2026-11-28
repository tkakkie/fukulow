// Enforce per-file and total byte budgets for AGENTS.md and every file under docs/ (any extension; symlinks are refused).
// With --base <file>, instead refuse budget raises and new budgets against the PR base unless DOC_BUDGET_RAISE_APPROVED=true (#603).
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Initial budgets round each file's size plus 10% headroom up to the next KiB.
export const BUDGETS_KIB = new Map<string, number>([
  ['AGENTS.md', 10],
  ['docs/decisions.md', 1],
  ['docs/decisions/api.md', 3],
  ['docs/decisions/auth.md', 11],
  ['docs/decisions/load.md', 4],
  ['docs/decisions/messages.md', 21],
  ['docs/decisions/process.md', 18],
  ['docs/decisions/realtime.md', 20],
  ['docs/decisions/web.md', 10],
  ['docs/invariants.md', 3],
  ['docs/invariants/auth.md', 34],
  ['docs/invariants/channels.md', 23],
  ['docs/invariants/deployment.md', 33],
  ['docs/invariants/messages.md', 29],
  ['docs/invariants/realtime.md', 39],
  ['docs/invariants/replies.md', 25],
  ['docs/invariants/sections.md', 7],
  ['docs/invariants/sync.md', 32],
  ['docs/invariants/topics.md', 12],
  ['docs/invariants/unread.md', 16],
  ['docs/invariants/web.md', 28],
  ['docs/measurements.md', 22],
  ['docs/spec.md', 4],
  ['docs/spec/accounts.md', 12],
  ['docs/spec/channels.md', 7],
  ['docs/spec/deployment.md', 58],
  ['docs/spec/dms.md', 58],
  ['docs/spec/realtime.md', 74],
  ['docs/spec/sections.md', 21],
  ['docs/ui.md', 24],
  ['docs/workflow.md', 28],
])

// #562 final size (8def9c2: 636,734 bytes over 29 files) plus 10%, rounded up to whole KiB. Fixed, never recomputed per PR (#603).
export const TOTAL_BUDGET_KIB = 684
const RAISE_LABEL = 'docs:budget-raise'
const RAISE_RULE = `needs the ${RAISE_LABEL} label and a linked maintainer approval (docs/workflow.md §13)`

export function checkDocBudgets(
  root: string,
  budgets: ReadonlyMap<string, number> = BUDGETS_KIB,
  totalKiB: number = TOTAL_BUDGET_KIB,
): string[] {
  const docs = join(root, 'docs')
  const files = ['AGENTS.md']
  if (existsSync(docs)) {
    for (const entry of readdirSync(docs, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue
      files.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    }
  }

  const errors: string[] = []
  const found = new Set<string>()
  let total = 0
  for (const file of files.sort()) {
    const stat = lstatSync(join(root, file), { throwIfNoEntry: false })
    if (!stat) continue
    found.add(file)
    if (!stat.isFile()) {
      errors.push(`${file}: not a regular file (symlink or special file). Docs must be plain files (docs/workflow.md §13).`)
      continue
    }
    total += stat.size
    const budget = budgets.get(file)
    if (budget === undefined) {
      errors.push(`${file}: ${stat.size} bytes, no budget. Add a per-file budget (docs/workflow.md §13).`)
    } else if (stat.size > budget * 1024) {
      errors.push(`${file}: ${stat.size} bytes exceeds its ${budget} KiB budget. Prune or merge first. A split needs a reason in the PR and its own approved Issue (docs/workflow.md §13).`)
    }
  }
  for (const [file, budget] of budgets) {
    if (!found.has(file)) errors.push(`${file}: file missing for a ${budget} KiB budget. Remove the stale budget or restore the file.`)
  }
  if (total > totalKiB * 1024) {
    errors.push(`total: ${total} bytes exceeds the ${totalKiB} KiB total budget. Prune or merge first. Raising it ${RAISE_RULE}.`)
  }
  return errors
}

export interface Budgets {
  files: ReadonlyMap<string, number>
  totalKiB?: number
}

// Reads the budgets from a copy of this script (the PR base). Fails closed when the map cannot be found.
export function parseBudgets(source: string): Budgets {
  const block = /BUDGETS_KIB = new Map<string, number>\(\[([\s\S]*?)\]\)/.exec(source)
  if (!block) throw new Error('base budgets: BUDGETS_KIB map not found')
  const files = new Map<string, number>()
  for (const [, file, kib] of block[1].matchAll(/\['([^']+)',\s*(\d+)\]/g)) files.set(file, Number(kib))
  if (files.size === 0) throw new Error('base budgets: BUDGETS_KIB map has no entries')
  const total = /TOTAL_BUDGET_KIB = (\d+)/.exec(source)
  if (!total && source.includes('TOTAL_BUDGET_KIB')) throw new Error('base budgets: TOTAL_BUDGET_KIB present but not parsed')
  return { files, totalKiB: total ? Number(total[1]) : undefined }
}

// Lowering or removing a per-file budget always passes. Raising one, adding one or raising the total needs approval.
export function checkBudgetChanges(base: Budgets, head: Budgets, approved: boolean): string[] {
  const changes: string[] = []
  for (const [file, kib] of head.files) {
    const old = base.files.get(file)
    if (old === undefined) changes.push(`${file}: new ${kib} KiB budget`)
    else if (kib > old) changes.push(`${file}: budget raised from ${old} to ${kib} KiB`)
  }
  if (head.totalKiB === undefined) changes.push('total: total budget removed')
  else if (base.totalKiB !== undefined && head.totalKiB > base.totalKiB) {
    changes.push(`total: budget raised from ${base.totalKiB} to ${head.totalKiB} KiB`)
  }
  return approved ? [] : changes.map((change) => `${change} ${RAISE_RULE}.`)
}

if (import.meta.main) {
  const baseFlag = process.argv.indexOf('--base')
  if (baseFlag >= 0) {
    const basePath = process.argv[baseFlag + 1]
    if (!basePath) throw new Error('--base needs a file path')
    const approved = process.env.DOC_BUDGET_RAISE_APPROVED === 'true'
    const head = { files: BUDGETS_KIB, totalKiB: TOTAL_BUDGET_KIB }
    const errors = checkBudgetChanges(parseBudgets(readFileSync(basePath, 'utf8')), head, approved)
    for (const error of errors) console.error(error)
    if (errors.length > 0) process.exitCode = 1
    else console.log(`doc budget changes: none needing approval${approved ? ` (${RAISE_LABEL} set)` : ''}`)
  } else {
    const errors = checkDocBudgets(join(import.meta.dirname, '../..'))
    for (const error of errors) console.error(error)
    if (errors.length > 0) process.exitCode = 1
    else console.log(`doc budgets: ${BUDGETS_KIB.size} files and the ${TOTAL_BUDGET_KIB} KiB total within budget`)
  }
}
