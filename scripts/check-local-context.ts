// Conservative raw-text guard for tracked Rust/SQL: require literal true as
// set_config's third argument, reject non-LOCAL SET within 200 chars of fukulow,
// and reject Unicode escape prefixes. No parsing, decoding or comment stripping:
// quotes are ordinary characters; false positives in comments/strings are accepted.
// Diagnostics contain only file:line, never matched text or bound data.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function violations(source: string): number[] {
  const offsets: number[] = []
  for (const match of source.matchAll(/\bset_config\s*\(/gi)) {
    const args: string[] = []
    let start = match.index + match[0].length
    let depth = 0
    let closed = false
    for (let i = start; i < source.length; i++) {
      const char = source[i]
      if (char === '(') depth++
      if (char === ')' && depth === 0) {
        args.push(source.slice(start, i).trim())
        closed = true
        break
      }
      if (char === ')') depth--
      if (char === ',' && depth === 0) {
        args.push(source.slice(start, i).trim())
        start = i + 1
      }
    }
    if (!closed || args.length !== 3 || !args[0] || !args[1] || !/^true$/i.test(args[2])) {
      offsets.push(match.index)
    }
  }
  for (const match of source.matchAll(/\bSET\b/gi)) {
    const after = source.slice(match.index + match[0].length)
    if (!/^\s+LOCAL\b/i.test(after) && /^[\s\S]{0,200}fukulow/i.test(after)) offsets.push(match.index)
  }
  for (const match of source.matchAll(/U&['"]/gi)) offsets.push(match.index)
  return [...new Set(offsets.map(offset => source.slice(0, offset).split('\n').length))].sort((a, b) => a - b)
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const paths = execFileSync('git', ['ls-files', '-z', '--', '*.rs', '*.sql'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const path of new Set(paths)) {
    for (const line of violations(readFileSync(resolve(root, path), 'utf8'))) {
      console.error(`${path}:${line}`)
      process.exitCode = 1
    }
  }
}
