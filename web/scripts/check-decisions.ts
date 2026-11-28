// Checks the docs/decisions.md index and every docs/decisions/*.md part (structure, single-line entries, cross-references).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Checks that decision entries and cross-reference bullets each occupy one physical line.
 * A line right after an entry must be blank, a heading or another entry. Indented and lazy continuations are refused.
 */
export function checkDecisions(md: string): string[] {
  const errors: string[] = []
  const lines = md.split('\n')
  lines.forEach((text, idx) => {
    const line = idx + 1
    if (idx > 0 && lines[idx - 1].startsWith('- ') && text.trim() !== '' && !text.startsWith('- ') && !text.startsWith('#'))
      errors.push(`line ${line}: continuation of the entry on line ${idx}; keep each decision on one line`)
    else if (/^\s+\S/.test(text)) errors.push(`line ${line}: indented line (a list continuation); keep each decision on one line`)
  })
  return errors
}

/** Checks the required decisions index and all parts, including unique entries and cross-reference prefixes. */
export function checkDecisionDocs(root: string): string[] {
  const errors: string[] = []
  const indexPath = join(root, 'docs/decisions.md')
  let index = ''
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) errors.push('docs/decisions.md: line 1: missing index')
  else {
    index = readFileSync(indexPath, 'utf8')
    errors.push(...checkDecisions(index).map((e) => 'docs/decisions.md: ' + e))
  }
  const dir = join(root, 'docs/decisions')
  type Entry = { text: string; line: number }
  const parts = new Map<string, { lines: string[]; entries: Entry[]; otherParts: number }>()
  if (!existsSync(dir) || !statSync(dir).isDirectory()) errors.push('docs/decisions/: line 1: missing parts directory')
  else {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = 'docs/decisions/' + entry.name
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        errors.push(file + ': line 1: expected a regular *.md part file')
        continue
      }
      const md = readFileSync(join(dir, entry.name), 'utf8')
      errors.push(...checkDecisions(md).map((e) => file + ': ' + e))
      const lines = md.split('\n')
      const otherParts = lines.indexOf('## Entries in other parts')
      const entries = lines.flatMap((text, idx) =>
        text.startsWith('- ') && (otherParts === -1 || idx < otherParts) ? [{ text: text.slice(2), line: idx + 1 }] : [])
      if (entries.length === 0) errors.push(file + ': line 1: no entries found')
      parts.set(entry.name, { lines, entries, otherParts })
    }
    if (parts.size === 0) errors.push('docs/decisions/: line 1: no parts found')
  }
  const linked = new Set<string>()
  index.split('\n').forEach((text, idx) => {
    if (!text.startsWith('- ')) return
    const at = 'docs/decisions.md: line ' + (idx + 1) + ': '
    const link = /^- \[([^\[\]\/]+)\]\(decisions\/\1\.md\): \S.*$/.exec(text)
    if (!link) return void errors.push(at + 'entries belong in parts, not the index')
    const target = link[1] + '.md'
    if (linked.has(target)) errors.push(at + 'part is linked more than once: ' + target)
    linked.add(target)
    if (!parts.has(target)) errors.push(at + 'unknown part: ' + target)
  })
  const entries = new Map<string, string>()
  for (const [name, part] of parts) {
    const file = 'docs/decisions/' + name
    if (!linked.has(name)) errors.push(file + ': line 1: part is not linked from docs/decisions.md')
    for (const entry of part.entries) {
      const at = file + ': line ' + entry.line
      const previous = entries.get(entry.text)
      if (previous) errors.push(at + ': duplicate entry text (first at ' + previous + '): ' + entry.text)
      else entries.set(entry.text, at)
    }
    if (part.otherParts === -1) continue
    let contentSeen = false
    part.lines.slice(part.otherParts + 1).forEach((text, idx) => {
      if (text.trim() === '') return
      const at = file + ': line ' + (part.otherParts + idx + 2) + ': '
      if (!contentSeen && !/^(?:\s|[-#])/.test(text)) {
        contentSeen = true
        return
      }
      contentSeen = true
      const bullet = /^- \[([^\[\]\/]+)\]\(\1\.md\): (`[^`]+`(?:, `[^`]+`)*)$/.exec(text)
      if (!bullet) return void errors.push(at + 'expected an Entries in other parts bullet')
      const target = bullet[1] + '.md'
      const linkedPart = parts.get(target)
      if (!linkedPart) errors.push(at + 'unknown part: ' + target)
      else if (target === name) errors.push(at + 'cross-reference must link to another part')
      else {
        for (const prefix of bullet[2].matchAll(/`([^`]+)`/g)) {
          // Entries may contain code spans; a prefix is matched against the entry text with backticks removed.
          const matches = linkedPart.entries.filter((entry) => entry.text.replaceAll('`', '').startsWith(prefix[1])).length
          if (matches === 0) errors.push(at + 'entry prefix not found in ' + target + ': ' + prefix[1])
          else if (matches > 1) errors.push(at + 'entry prefix is ambiguous in ' + target + ': ' + prefix[1])
        }
      }
    })
  }
  return errors
}
