import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Text = { text: string, offsets: number[] }
type Token = { kind: 'word' | 'identifier' | 'string' | 'symbol', value: string, offset: number, uncertain?: boolean, body?: Text }

// Scan every Rust string, including non-query strings (a deliberate conservative
// false positive). Keep Rust comments/escapes out of the SQL lexer, and map decoded
// characters back to physical source lines rather than SQL's escaped newlines.
function rustStrings(source: string): Text[] {
  const strings: Text[] = []
  let i = 0
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      i = source.indexOf('\n', i)
      if (i < 0) break
    } else if (source.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2 }
        else if (source.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
    } else {
      const raw = /^(?:br|cr|r)(#*)"/.exec(source.slice(i))
      if (raw) {
        i += raw[0].length
        const end = source.indexOf(`"${raw[1]}`, i)
        const stop = end < 0 ? source.length : end
        strings.push({ text: source.slice(i, stop), offsets: Array.from({ length: stop - i }, (_, n) => i + n) })
        i = stop + 1 + raw[1].length
      } else if (source[i] === '"') {
        i++
        let text = ''
        const offsets: number[] = []
        while (i < source.length && source[i] !== '"') {
          const start = i
          let value = source[i++]
          if (value === '\\') {
            const escape = source[i++]
            if (escape === '\n' || escape === '\r') {
              while (/\s/.test(source[i] ?? '') && i < source.length) i++
              continue
            }
            const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\', '"': '"', "'": "'" }
            if (escape === 'x') {
              value = String.fromCharCode(parseInt(source.slice(i, i + 2), 16))
              i += 2
            } else if (escape === 'u' && source[i] === '{') {
              const end = source.indexOf('}', i)
              value = String.fromCodePoint(parseInt(source.slice(i + 1, end).replaceAll('_', ''), 16))
              i = end + 1
            } else value = simple[escape] ?? escape
          }
          text += value
          offsets.push(...Array(value.length).fill(start))
        }
        strings.push({ text, offsets })
        i++
      } else {
        // A character literal may contain a double quote; lifetimes are not literals.
        const character = /^'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/.exec(source.slice(i))
        i += character?.[0].length ?? 1
      }
    }
  }
  return strings
}

function sqlTokens(input: Text): Token[] {
  const { text, offsets } = input
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue }
    if (text.startsWith('--', i)) {
      const end = text.slice(i).search(/[\r\n]/)
      i = end < 0 ? text.length : i + end
      continue
    }
    if (text.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < text.length && depth) {
        if (text.startsWith('/*', i)) { depth++; i += 2 }
        else if (text.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
      continue
    }
    const start = i
    const dollar = /^\$(?:[a-zA-Z_][\w]*|)\$/.exec(text.slice(i))
    if (dollar) {
      // Dollar bodies can execute SQL (DO/functions). Scan them conservatively;
      // an inert dollar-quoted value containing SQL can therefore be flagged.
      i += dollar[0].length
      const end = text.indexOf(dollar[0], i)
      const stop = end < 0 ? text.length : end
      const body = { text: text.slice(i, stop), offsets: offsets.slice(i, stop) }
      tokens.push({ kind: 'string', value: body.text, offset: offsets[start], body })
      i = stop + dollar[0].length
    } else if (text[i] === "'" || text[i] === '"' || /^[eE]'/.test(text.slice(i, i + 2))) {
      const escaped = text[i] !== "'" && text[i] !== '"'
      if (escaped) i++
      const quote = text[i++]
      let value = ''
      let uncertain = false
      while (i < text.length) {
        const char = text[i++]
        if (char === quote) {
          if (text[i] === quote) { value += quote; i++; continue }
          break
        }
        if (escaped && char === '\\') {
          const escape = text[i++]
          uncertain = true
          value += ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escape] ?? escape
        } else value += char
      }
      tokens.push({ kind: quote === "'" ? 'string' : 'identifier', value, offset: offsets[start], uncertain })
    } else {
      const word = /^[a-zA-Z_][\w$]*/.exec(text.slice(i))
      const value = word?.[0] ?? text[i]
      tokens.push({ kind: word ? 'word' : 'symbol', value: value.toLowerCase(), offset: offsets[i] })
      i += value.length
    }
  }
  return tokens
}

function sqlViolations(input: Text): number[] {
  const tokens = sqlTokens(input)
  const offsets = tokens.flatMap(token => token.body ? sqlViolations(token.body) : [])
  const word = (token: Token | undefined, value: string) => token?.kind === 'word' && token.value === value
  const identifier = (token: Token | undefined) => token?.kind === 'word' || token?.kind === 'identifier'
  const symbol = (token: Token | undefined, value: string) => token?.kind === 'symbol' && token.value === value
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (word(token, 'set')) {
      const key = tokens[i + (word(tokens[i + 1], 'session') ? 2 : 1)]
      if (identifier(key) && (key.value.toLowerCase().startsWith('fukulow.') || key.value.toLowerCase() === 'fukulow')) offsets.push(token.offset)
    }
    if (!identifier(token) || token.value !== 'set_config' || !symbol(tokens[i + 1], '(')) continue
    const args: Token[][] = [[]]
    let depth = 0
    for (let j = i + 2; j < tokens.length; j++) {
      const current = tokens[j]
      if (symbol(current, ')') && depth === 0) break
      if (symbol(current, ',') && depth === 0) { args.push([]); continue }
      if (symbol(current, '(')) depth++
      if (symbol(current, ')')) depth--
      args.at(-1)!.push(current)
    }
    const key = args[0].filter(t => !symbol(t, '(') && !symbol(t, ')'))
    const local = (args[2] ?? []).filter(t => !symbol(t, '(') && !symbol(t, ')'))
    // Casts on a literal key do not change which setting is written. Unknown
    // keys/locality expressions are deliberately flagged unless locality is
    // provably true. Escape strings with backslashes are treated as unknown
    // (even for unrelated settings); dynamic SQL still requires code review.
    const unrelated = key[0]?.kind === 'string' && !key[0].uncertain && !key[0].value.toLowerCase().startsWith('fukulow.')
      && (key.length === 1 || key.slice(1).map(t => t.value).join('').match(/^::(?:pg_catalog\.)?text$/))
    const localText = local.map(t => t.value).join('')
    const isLocal = !local[0]?.uncertain && (word(local[0], 'true') || local[0]?.kind === 'string' && /^(?:true|t|yes|y|on|1)$/i.test(local[0].value))
      && /^(?:true|t|yes|y|on|1)(?:::(?:pg_catalog\.)?bool(?:ean)?)?$/.test(localText)
    if (!unrelated && !isLocal) offsets.push(token.offset)
  }
  return offsets
}

// Diagnostics contain only file:line, never SQL or bound data.
export function violations(source: string, language: 'sql' | 'rust' = 'sql'): number[] {
  const inputs = language === 'rust' ? rustStrings(source)
    : [{ text: source, offsets: Array.from({ length: source.length }, (_, i) => i) }]
  return [...new Set(inputs.flatMap(sqlViolations).map(offset => source.slice(0, offset).split('\n').length))]
    .sort((a, b) => a - b)
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.rs', '*.sql'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const path of new Set(paths)) {
    for (const line of violations(readFileSync(resolve(root, path), 'utf8'), path.endsWith('.rs') ? 'rust' : 'sql')) {
      console.error(`${path}:${line}`)
      process.exitCode = 1
    }
  }
  if (!process.exitCode) console.log('Transaction-local context: Rust and SQL sources passed')
}
