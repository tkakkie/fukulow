import type { Message } from './api'
import { matchAutolink, matchScheme, scanUrlRun, type UrlRun } from './message-autolink'

const tokenPattern = /@\{member:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}/g

export type MentionToken = {
  type: 'mention'
  id: string
}

export type TextToken = {
  type: 'text'
  text: string
}

export type InlineCodeToken = {
  type: 'code'
  children: (TextToken | MentionToken)[]
}

export type LinkToken = {
  type: 'link'
  href: string
  text: string
}

export type BoldToken = {
  type: 'bold'
  children: InlineToken[]
}

export type StrikethroughToken = {
  type: 'strikethrough'
  children: InlineToken[]
}

export type InlineToken =
  | TextToken
  | MentionToken
  | InlineCodeToken
  | LinkToken
  | BoldToken
  | StrikethroughToken

export type LineBlock = {
  type: 'line'
  children: InlineToken[]
}

export type CodeBlock = {
  type: 'code_block'
  children: (TextToken | MentionToken)[]
}

export type QuoteBlock = {
  type: 'quote'
  lines: InlineToken[][]
}

export type BlockToken = LineBlock | CodeBlock | QuoteBlock

// A rejected or pending Mention token is a `literal` atom: shown as its token text, never parsed.
type AtomPart =
  | { type: 'text'; text: string }
  | { type: 'mention'; id: string }
  | { type: 'literal'; text: string }
type Atom = Exclude<AtomPart, { type: 'text' }>

const MAX_CACHE_ENTRIES = 1024
const tokenCache = new Map<string, BlockToken[]>()

export function clearMessageFormatCache(): void {
  tokenCache.clear()
}

function buildAcceptedSet(
  mentions: Message['mentions'] | undefined,
  pending = false,
): { set: Set<string>; key: string } {
  if (pending || !mentions || mentions.length === 0) {
    return { set: new Set(), key: '' }
  }
  const set = new Set<string>()
  const ids: string[] = []
  for (const m of mentions) {
    if (!set.has(m.member_id)) {
      set.add(m.member_id)
      ids.push(m.member_id)
    }
  }
  ids.sort()
  return { set, key: ids.join(',') }
}

/**
 * Step 1: Mention atoms first.
 * Every complete M1 token in the original body is recognized before any other rule.
 * Accepted ids become mention atoms; rejected tokens (or any token when pending) become literal atoms.
 */
function splitAtoms(text: string, accepted: Set<string>): AtomPart[] {
  const parts: AtomPart[] = []
  let lastIndex = 0
  tokenPattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(text)) !== null) {
    const id = match[1]
    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    }
    parts.push(accepted.has(id) ? { type: 'mention', id } : { type: 'literal', text: match[0] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push({ type: 'text', text: text.slice(lastIndex) })
  }
  return parts
}

function splitAtomsIntoLines(parts: AtomPart[]): AtomPart[][] {
  const lines: AtomPart[][] = [[]]
  for (const part of parts) {
    if (part.type !== 'text') {
      lines[lines.length - 1].push(part)
    } else {
      const segments = part.text.split(/\r?\n/)
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) lines.push([])
        if (segments[i].length > 0) {
          lines[lines.length - 1].push({ type: 'text', text: segments[i] })
        }
      }
    }
  }
  return lines
}

function isExactFenceLine(line: AtomPart[]): boolean {
  return line.length === 1 && line[0].type === 'text' && line[0].text === '```'
}

function stripQuotePrefix(line: AtomPart[]): AtomPart[] | null {
  if (line.length === 0) {
    return null
  }
  const first = line[0]
  if (first.type !== 'text' || !first.text.startsWith('> ')) {
    return null
  }
  const restText = first.text.slice(2)
  if (restText.length > 0) {
    return [{ type: 'text', text: restText }, ...line.slice(1)]
  }
  return line.slice(1)
}

function joinCodeLines(lines: AtomPart[][]): (TextToken | MentionToken)[] {
  const out: (TextToken | MentionToken)[] = []
  const pushText = (t: string) => {
    if (t.length === 0) return
    const last = out[out.length - 1]
    if (last && last.type === 'text') {
      last.text += t
    } else {
      out.push({ type: 'text', text: t })
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) pushText('\n')
    for (const part of lines[i]) {
      if (part.type !== 'mention') pushText(part.text)
      else out.push({ type: 'mention', id: part.id })
    }
  }
  return out
}

const ASCII_ALNUM = /^[A-Za-z0-9]$/
/**
 * Flatten a line's AtomParts into a character sequence where each mention atom
 * occupies one sentinel code unit (\uFFFC) and stores its member id in a map
 * by exact string index. Also precompute the next plain backtick index for O(1)
 * inline-code lookup and skipping.
 */
type IndexedLine = {
  str: string
  atoms: Map<number, Atom>
  nextBacktick: Map<number, number>
}

const ATOM_SENTINEL = '\uFFFC'

function indexLine(parts: AtomPart[]): IndexedLine {
  let str = ''
  const atoms = new Map<number, Atom>()
  for (const part of parts) {
    if (part.type === 'text') {
      str += part.text
    } else {
      atoms.set(str.length, part)
      str += ATOM_SENTINEL
    }
  }
  const nextBacktick = new Map<number, number>()
  let lastBacktick = -1
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === '`' && !atoms.has(i)) {
      nextBacktick.set(i, lastBacktick)
      lastBacktick = i
    }
  }
  return { str, atoms, nextBacktick }
}

function sliceCodeChildren(
  line: IndexedLine,
  start: number,
  end: number,
): (TextToken | MentionToken)[] {
  const out: (TextToken | MentionToken)[] = []
  const pushText = (text: string) => {
    if (text.length === 0) return
    const last = out[out.length - 1]
    if (last && last.type === 'text') last.text += text
    else out.push({ type: 'text', text })
  }
  let textStart = start
  for (let i = start; i < end; i++) {
    const atom = line.atoms.get(i)
    if (atom !== undefined) {
      pushText(line.str.slice(textStart, i))
      if (atom.type === 'mention') out.push({ type: 'mention', id: atom.id })
      else pushText(atom.text)
      textStart = i + 1
    }
  }
  pushText(line.str.slice(textStart, end))
  return out
}

function isPairAt(line: IndexedLine, idx: number, end: number, ch: string): boolean {
  return (
    idx + 1 < end &&
    !line.atoms.has(idx) &&
    !line.atoms.has(idx + 1) &&
    line.str[idx] === ch &&
    line.str[idx + 1] === ch
  )
}

const STACK_NONE = 0
const STACK_BOLD = 1
const STACK_STRIKE = 2
const STACK_BOLD_STRIKE = 3
const STACK_STRIKE_BOLD = 4
type EmphasisStack =
  | typeof STACK_NONE
  | typeof STACK_BOLD
  | typeof STACK_STRIKE
  | typeof STACK_BOLD_STRIKE
  | typeof STACK_STRIKE_BOLD

/**
 * Single-pass recursive inline parser. Emphasis closers are found by the same
 * scan that emits tokens, so autolinks, inline code, and nested emphasis can
 * never disagree on boundaries.
 *
 * Soundness of `dead[stack]`: for any non-empty `stack`, every transition from
 * a position `i` in this loop depends solely on `(i, stack)` (and on `i > start`
 * for the target closer). If a non-empty scan fails (reaches EOL, an outer
 * closer, or a position already in `dead[stack]`), none of its visited positions
 * was the target closer, so any future call with the same `stack` reaching any
 * of those positions will follow the identical path and fail. Empty failures at
 * `i === start` return in O(1) without marking `start` dead (since `start` IS a
 * valid closer for any non-empty span reaching it).
 */
function parseInline(
  line: IndexedLine,
  start: number,
  stack: EmphasisStack,
  dead: (Uint8Array | null)[],
): { tokens: InlineToken[]; nextPos: number } | null {
  const end = line.str.length
  const tokens: InlineToken[] = []
  let textBuffer = ''

  const flushText = () => {
    if (textBuffer.length > 0) {
      const last = tokens[tokens.length - 1]
      if (last && last.type === 'text') {
        last.text += textBuffer
      } else {
        tokens.push({ type: 'text', text: textBuffer })
      }
      textBuffer = ''
    }
  }

  const boldOpen =
    stack === STACK_BOLD || stack === STACK_BOLD_STRIKE || stack === STACK_STRIKE_BOLD
  const strikeOpen =
    stack === STACK_STRIKE || stack === STACK_BOLD_STRIKE || stack === STACK_STRIKE_BOLD
  const closeChar =
    stack === STACK_BOLD || stack === STACK_STRIKE_BOLD
      ? '*'
      : stack === STACK_STRIKE || stack === STACK_BOLD_STRIKE
        ? '~'
        : null
  const outerCloseChar =
    stack === STACK_BOLD_STRIKE ? '*' : stack === STACK_STRIKE_BOLD ? '~' : null

  const deadForStack = stack === STACK_NONE ? null : dead[stack]
  const visited: number[] | null = stack === STACK_NONE ? null : []

  const markDeadAndFail = (): null => {
    if (visited !== null && visited.length > 0) {
      let arr = dead[stack]
      if (arr === null) {
        arr = new Uint8Array(end + 1)
        dead[stack] = arr
      }
      for (let k = 0; k < visited.length; k++) {
        arr[visited[k]] = 1
      }
    }
    return null
  }

  const isUrlBreak = (k: number): boolean =>
    line.atoms.has(k) ||
    (boldOpen && isPairAt(line, k, end, '*')) ||
    (strikeOpen && isPairAt(line, k, end, '~'))

  let urlRun: UrlRun | null = null
  let i = start

  while (i < end) {
    if (deadForStack !== null && deadForStack[i] === 1) {
      return markDeadAndFail()
    }

    const atom = line.atoms.get(i)
    if (atom !== undefined) {
      if (visited !== null) visited.push(i)
      if (atom.type === 'literal') {
        textBuffer += atom.text
      } else {
        flushText()
        tokens.push({ type: 'mention', id: atom.id })
      }
      i++
      continue
    }

    if (closeChar !== null && isPairAt(line, i, end, closeChar)) {
      if (i === start) {
        return null
      }
      flushText()
      return { tokens, nextPos: i + 2 }
    }

    if (outerCloseChar !== null && isPairAt(line, i, end, outerCloseChar)) {
      return markDeadAndFail()
    }

    if (visited !== null) visited.push(i)

    const ch = line.str[i]

    // 1. Inline code: backtick to the next backtick, non-empty
    if (ch === '`') {
      const closeIdx = line.nextBacktick.get(i) ?? -1
      if (closeIdx > i + 1 && closeIdx < end) {
        flushText()
        tokens.push({
          type: 'code',
          children: sliceCodeChildren(line, i + 1, closeIdx),
        })
        i = closeIdx + 1
        continue
      }
      textBuffer += ch
      i++
      continue
    }

    // 2. Autolink: candidates in one printable run share its precomputed tables
    if (ch === 'h' || ch === 'H' || ch === 'm' || ch === 'M') {
      if (i === 0 || line.atoms.has(i - 1) || !ASCII_ALNUM.test(line.str[i - 1])) {
        const scheme = matchScheme(line.str, i, end)
        if (scheme !== null) {
          if (urlRun === null || urlRun.end <= i) {
            urlRun = scanUrlRun(line.str, i, end, isUrlBreak)
          }
          const linkEnd = matchAutolink(urlRun, i, scheme)
          if (linkEnd !== -1) {
            const url = line.str.slice(i, linkEnd)
            flushText()
            tokens.push({ type: 'link', href: url, text: url })
            i = linkEnd
            continue
          }
        }
      }
    }

    // 3. Bold: **...**
    if (!boldOpen && isPairAt(line, i, end, '*')) {
      const nextStack: EmphasisStack = strikeOpen ? STACK_STRIKE_BOLD : STACK_BOLD
      const inner = parseInline(line, i + 2, nextStack, dead)
      if (inner !== null) {
        flushText()
        tokens.push({ type: 'bold', children: inner.tokens })
        i = inner.nextPos
        continue
      }
      textBuffer += '**'
      i += 2
      continue
    }

    // 4. Strikethrough: ~~...~~
    if (!strikeOpen && isPairAt(line, i, end, '~')) {
      const nextStack: EmphasisStack = boldOpen ? STACK_BOLD_STRIKE : STACK_STRIKE
      const inner = parseInline(line, i + 2, nextStack, dead)
      if (inner !== null) {
        flushText()
        tokens.push({ type: 'strikethrough', children: inner.tokens })
        i = inner.nextPos
        continue
      }
      textBuffer += '~~'
      i += 2
      continue
    }

    textBuffer += ch
    i++
  }

  if (stack !== STACK_NONE) {
    return markDeadAndFail()
  }

  flushText()
  return { tokens, nextPos: end }
}

function parseInlineLine(parts: AtomPart[]): InlineToken[] {
  if (parts.length === 0) return []
  const indexed = indexLine(parts)
  const dead: (Uint8Array | null)[] = [null, null, null, null, null]
  return parseInline(indexed, 0, STACK_NONE, dead)?.tokens ?? []
}

export function tokenizeMessageBody(
  body: string | null | undefined,
  mentions?: Message['mentions'],
  pending = false,
): BlockToken[] {
  const raw = body ?? ''
  const { set: accepted, key: acceptedKey } = buildAcceptedSet(mentions, pending)
  const cacheKey = `${acceptedKey}\0${raw}`

  const cached = tokenCache.get(cacheKey)
  if (cached !== undefined) {
    // Refresh LRU order
    tokenCache.delete(cacheKey)
    tokenCache.set(cacheKey, cached)
    return cached
  }

  const atoms = splitAtoms(raw, accepted)
  const lines = splitAtomsIntoLines(atoms)
  const blocks: BlockToken[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Rule 2: Fenced code block: a line that is exactly three backticks opens it and the next such line closes it.
    if (isExactFenceLine(line)) {
      let closeLine = -1
      for (let j = i + 1; j < lines.length; j++) {
        if (isExactFenceLine(lines[j])) {
          closeLine = j
          break
        }
      }
      if (closeLine !== -1) {
        const innerLines = lines.slice(i + 1, closeLine)
        blocks.push({
          type: 'code_block',
          children: joinCodeLines(innerLines),
        })
        i = closeLine + 1
        continue
      }
      // Without a closing line, the opening line is literal and later lines are parsed normally.
    }

    // Rule 3: Block quote: outside code blocks, consecutive lines starting `> ` form one quote of inline content without the prefix.
    const quoteFirst = stripQuotePrefix(line)
    if (quoteFirst !== null) {
      const quoteLines: InlineToken[][] = [parseInlineLine(quoteFirst)]
      i++
      while (i < lines.length) {
        // Note: if a line starts with `> `, it cannot be an exact fence line (` ``` `), so consecutive `> ` lines merge into the quote.
        const nextStripped = stripQuotePrefix(lines[i])
        if (nextStripped === null) break
        quoteLines.push(parseInlineLine(nextStripped))
        i++
      }
      blocks.push({
        type: 'quote',
        lines: quoteLines,
      })
      continue
    }

    // Rule 4: Normal inline line
    blocks.push({
      type: 'line',
      children: parseInlineLine(line),
    })
    i++
  }

  if (tokenCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = tokenCache.keys().next().value
    if (oldestKey !== undefined) tokenCache.delete(oldestKey)
  }
  tokenCache.set(cacheKey, blocks)

  return blocks
}
