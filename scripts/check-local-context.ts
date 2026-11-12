import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A conservative source grep, including SQL embedded in Rust. Do not print SQL:
// diagnostics need only the file and line, even if a future violation holds a secret.
export function violations(source: string): number[] {
  const text = source.replace(/\\(?=\r?\n)/g, ' ').replace(/\\[nrt]/g, '  ').replace(/\\"/g, '"')
    .replace(/'(?:''|[^'])*'|\/\*[\s\S]*?\*\/|--[^\n]*|\/\/[^\n]*/g,
      token => token.startsWith("'") ? token : token.replace(/[^\n]/g, ' '))
  const offsets: number[] = []
  const identifier = String.raw`(?:(?:fukulow|"fukulow")\s*\.\s*"?\w+"?|"fukulow\.\w+")`
  for (const match of text.matchAll(new RegExp(String.raw`\bSET\s+(?:SESSION\s+)?${identifier}`, 'gi'))) {
    offsets.push(match.index)
  }
  for (const match of text.matchAll(/\bset_config\s*\(/gi)) {
    const args: string[] = []
    let start = match.index + match[0].length
    let depth = 0
    let quoted = false
    for (let i = start; i < text.length; i++) {
      const char = text[i]
      if (char === "'") {
        if (quoted && text[i + 1] === "'") { i++; continue }
        quoted = !quoted
      }
      if (quoted) continue
      if (char === '(') depth++
      if (char === ')' && depth > 0) { depth--; continue }
      if (depth === 0 && (char === ',' || char === ')')) {
        args.push(text.slice(start, i).trim())
        start = i + 1
        if (char === ')') break
      }
    }
    const local = (args[2] ?? '').replace(/[()\s]/g, '')
    if (/^'fukulow\.[^']+'$/i.test(args[0] ?? '') && /^false(?:::(?:pg_catalog\.)?bool(?:ean)?)?$/i.test(local)) {
      offsets.push(match.index)
    }
  }
  return [...new Set(offsets.map(offset => text.slice(0, offset).split('\n').length))].sort((a, b) => a - b)
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.rs', '*.sql'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const path of new Set(paths)) {
    for (const line of violations(readFileSync(resolve(root, path), 'utf8'))) {
      console.error(`${path}:${line}: fukulow context must be transaction-local; use SET LOCAL or set_config(..., true)`)
      process.exitCode = 1
    }
  }
  if (!process.exitCode) console.log('Transaction-local context: Rust and SQL sources passed')
}
