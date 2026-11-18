// Enforce per-file byte budgets for AGENTS.md and every file under docs/ (any extension; symlinks are refused).
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Initial budgets round each file's size plus 10% headroom up to the next KiB.
const BUDGETS_KIB = new Map<string, number>([
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
  ['docs/invariants/channels.md', 22],
  ['docs/invariants/deployment.md', 33],
  ['docs/invariants/messages.md', 29],
  ['docs/invariants/realtime.md', 36],
  ['docs/invariants/replies.md', 25],
  ['docs/invariants/sync.md', 31],
  ['docs/invariants/topics.md', 12],
  ['docs/invariants/unread.md', 16],
  ['docs/invariants/web.md', 28],
  ['docs/measurements.md', 22],
  ['docs/spec.md', 4],
  ['docs/spec/accounts.md', 12],
  ['docs/spec/deployment.md', 58],
  ['docs/spec/dms.md', 60],
  ['docs/spec/realtime.md', 74],
  ['docs/spec/sections.md', 21],
  ['docs/ui.md', 24],
  ['docs/workflow.md', 28],
])

export function checkDocBudgets(root: string, budgets: ReadonlyMap<string, number> = BUDGETS_KIB): string[] {
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
  for (const file of files.sort()) {
    const stat = lstatSync(join(root, file), { throwIfNoEntry: false })
    if (!stat) continue
    found.add(file)
    if (!stat.isFile()) {
      errors.push(`${file}: not a regular file (symlink or special file). Docs must be plain files (docs/workflow.md §13).`)
      continue
    }
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
  return errors
}

if (import.meta.main) {
  const errors = checkDocBudgets(join(import.meta.dirname, '../..'))
  for (const error of errors) console.error(error)
  if (errors.length > 0) process.exitCode = 1
  else console.log(`doc budgets: ${BUDGETS_KIB.size} files within budget`)
}
