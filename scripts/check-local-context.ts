// Conservative raw-text guard for tracked Rust/SQL: allow only strict local
// set_config calls and unambiguous SET forms; reject pg_settings and Unicode
// escape prefixes. No parsing, decoding or comment stripping:
// quotes are ordinary characters; false positives in comments/strings are accepted.
// Dynamic SQL building keywords/function names at runtime (EXECUTE with
// concatenation) is out of scope and must be covered by review.
// Diagnostics contain only file:line, never matched text or bound data.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function violations(source: string): number[] {
  const offsets: number[] = []
  const localCall = /set_config\([ \t\r\n]*'[A-Z0-9_.{}]+'[ \t\r\n]*,[ \t\r\n]*(?:\$[0-9]+|:[A-Z_][A-Z0-9_]*(?:::[A-Z_][A-Z0-9_]*)?|'[A-Z0-9_.]*')[ \t\r\n]*,[ \t\r\n]*true[ \t\r\n]*\)/iy
  for (const match of source.matchAll(/\bset_config\b/gi)) {
    localCall.lastIndex = match.index
    if (!localCall.test(source)) offsets.push(match.index)
  }
  for (const match of source.matchAll(/\bSET\b/gi)) {
    const after = source.slice(match.index + match[0].length)
      .replace(/^[ \t\r\n]*(?:SESSION\b[ \t\r\n]*)?/i, '')
    if (/^LOCAL\b/i.test(after)) continue
    const identifier = /^[A-Z_][A-Z0-9_]*/i.exec(after)?.[0]
    if (identifier?.toLowerCase() === 'fukulow' || /^(?:\/\*|--|\/\/|["']|U&|\$|\\)/i.test(after)) {
      offsets.push(match.index)
    }
  }
  for (const match of source.matchAll(/pg_settings|U&['"]/gi)) offsets.push(match.index)
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
