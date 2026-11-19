import type { Message } from './api'

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

type CacheEntry = {
  acceptedKey: string
  blocks: BlockToken[]
}

const MAX_CACHE_ENTRIES = 1024
const tokenCache = new Map<string, CacheEntry>()

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
      const segments = part.text.split('\n')
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
const SCHEME_RE = /^(?:https?:\/\/|mailto:)/i
const TRAILING_PUNCT = new Set(['.', ',', ':', ';', '!', '?', "'", '"'])

function countChar(s: string, ch: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) n++
  }
  return n
}

function isAllowedUrlChar(code: number): boolean {
  // Printable ASCII (0x21..0x7e): excludes whitespace, control chars, and non-ASCII
  return code >= 0x21 && code <= 0x7e
}

function trimAutolink(raw: string): string | null {
  const schemeMatch = SCHEME_RE.exec(raw)
  if (!schemeMatch) return null
  const schemeLen = schemeMatch[0].length
  const isMailto = schemeMatch[0].toLowerCase().startsWith('mailto:')

  let end = raw.length
  while (end > schemeLen) {
    const ch = raw[end - 1]
    if (TRAILING_PUNCT.has(ch)) {
      end--
      continue
    }
    if (ch === ')') {
      const sub = raw.slice(schemeLen, end)
      if (countChar(sub, ')') > countChar(sub, '(')) {
        end--
        continue
      }
    }
    if (ch === ']') {
      const sub = raw.slice(schemeLen, end)
      if (countChar(sub, ']') > countChar(sub, '[')) {
        end--
        continue
      }
    }
    break
  }

  const target = raw.slice(0, end)
  const remainder = target.slice(schemeLen)
  if (remainder.length === 0) return null

  if (isMailto) {
    // Non-empty address
    if (remainder.startsWith('/') || remainder.startsWith('?')) return null
    return target
  } else {
    // Non-empty host after http:// or https://
    const hostEnd = remainder.search(/[/?#]/)
    const host = hostEnd === -1 ? remainder : remainder.slice(0, hostEnd)
    if (host.length === 0 || host.startsWith(':')) return null
    return target
  }
}

/**
 * Flatten a line's AtomParts into a character sequence where each mention atom
 * occupies one sentinel code unit (\uFFFC) and stores its member id in a map
 * by exact string index.
 */
type IndexedLine = {
  str: string
  atoms: Map<number, Atom>
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
  return { str, atoms }
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

function findNextPlainChar(line: IndexedLine, ch: string, from: number, end: number): number {
  for (let i = from; i < end; i++) {
    if (line.str[i] === ch && !line.atoms.has(i)) return i
  }
  return -1
}

function findNextPlainPair(line: IndexedLine, pairChar: string, from: number, end: number): number {
  for (let i = from; i + 1 < end; i++) {
    if (
      line.str[i] === pairChar &&
      line.str[i + 1] === pairChar &&
      !line.atoms.has(i) &&
      !line.atoms.has(i + 1)
    ) {
      return i
    }
  }
  return -1
}

function matchAutolinkInLine(line: IndexedLine, index: number, end: number): string | null {
  if (line.atoms.has(index)) return null
  if (index > 0 && !line.atoms.has(index - 1) && ASCII_ALNUM.test(line.str[index - 1])) {
    return null
  }
  const c0 = line.str.charCodeAt(index) | 32
  if (c0 !== 104 && c0 !== 109) return null

  // Find extent up to end, whitespace, atom, or non-ASCII
  let rawEnd = index
  while (rawEnd < end && !line.atoms.has(rawEnd) && isAllowedUrlChar(line.str.charCodeAt(rawEnd))) {
    rawEnd++
  }
  const raw = line.str.slice(index, rawEnd)
  if (!SCHEME_RE.test(raw)) return null
  return trimAutolink(raw)
}

function parseInlineRange(
  line: IndexedLine,
  start: number,
  end: number,
  disallowBold: boolean,
  disallowStrike: boolean,
): InlineToken[] {
  const out: InlineToken[] = []
  let textBuffer = ''

  const flushText = () => {
    if (textBuffer.length > 0) {
      const last = out[out.length - 1]
      if (last && last.type === 'text') {
        last.text += textBuffer
      } else {
        out.push({ type: 'text', text: textBuffer })
      }
      textBuffer = ''
    }
  }

  // Track failed closer searches so repeated markers degrade in O(N) instead of O(N^2)
  let noBacktickAfter = -1
  let noBoldAfter = -1
  let noStrikeAfter = -1

  let i = start
  while (i < end) {
    const atom = line.atoms.get(i)
    if (atom !== undefined) {
      if (atom.type === 'literal') {
        textBuffer += atom.text
      } else {
        flushText()
        out.push({ type: 'mention', id: atom.id })
      }
      i++
      continue
    }

    const ch = line.str[i]

    // 1. Inline code: backtick to the next backtick, non-empty
    if (ch === '`') {
      if (noBacktickAfter === -1 || i < noBacktickAfter) {
        const closeIdx = findNextPlainChar(line, '`', i + 1, end)
        if (closeIdx === -1) {
          noBacktickAfter = i
        } else if (closeIdx > i + 1) {
          flushText()
          out.push({
            type: 'code',
            children: sliceCodeChildren(line, i + 1, closeIdx),
          })
          i = closeIdx + 1
          continue
        }
      }
      textBuffer += ch
      i++
      continue
    }

    // 2. Autolink
    if (ch === 'h' || ch === 'H' || ch === 'm' || ch === 'M') {
      const url = matchAutolinkInLine(line, i, end)
      if (url !== null) {
        flushText()
        out.push({ type: 'link', href: url, text: url })
        i += url.length
        continue
      }
    }

    // 3. Bold: **...**
    if (
      !disallowBold &&
      ch === '*' &&
      i + 1 < end &&
      line.str[i + 1] === '*' &&
      !line.atoms.has(i + 1)
    ) {
      if (noBoldAfter === -1 || i < noBoldAfter) {
        const closeIdx = findNextPlainPair(line, '*', i + 2, end)
        if (closeIdx === -1) {
          noBoldAfter = i
        } else if (closeIdx > i + 2) {
          flushText()
          out.push({
            type: 'bold',
            children: parseInlineRange(line, i + 2, closeIdx, true, disallowStrike),
          })
          i = closeIdx + 2
          continue
        }
      }
      textBuffer += '**'
      i += 2
      continue
    }

    // 4. Strikethrough: ~~...~~
    if (
      !disallowStrike &&
      ch === '~' &&
      i + 1 < end &&
      line.str[i + 1] === '~' &&
      !line.atoms.has(i + 1)
    ) {
      if (noStrikeAfter === -1 || i < noStrikeAfter) {
        const closeIdx = findNextPlainPair(line, '~', i + 2, end)
        if (closeIdx === -1) {
          noStrikeAfter = i
        } else if (closeIdx > i + 2) {
          flushText()
          out.push({
            type: 'strikethrough',
            children: parseInlineRange(line, i + 2, closeIdx, disallowBold, true),
          })
          i = closeIdx + 2
          continue
        }
      }
      textBuffer += '~~'
      i += 2
      continue
    }

    textBuffer += ch
    i++
  }

  flushText()
  return out
}

function parseInlineLine(parts: AtomPart[]): InlineToken[] {
  if (parts.length === 0) return []
  const indexed = indexLine(parts)
  return parseInlineRange(indexed, 0, indexed.str.length, false, false)
}

export function tokenizeMessageBody(
  body: string | null | undefined,
  mentions?: Message['mentions'],
  pending = false,
): BlockToken[] {
  const raw = body ?? ''
  const { set: accepted, key: acceptedKey } = buildAcceptedSet(mentions, pending)

  const cached = tokenCache.get(raw)
  if (cached && cached.acceptedKey === acceptedKey) {
    // Refresh LRU order
    tokenCache.delete(raw)
    tokenCache.set(raw, cached)
    return cached.blocks
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
  tokenCache.set(raw, { acceptedKey, blocks })

  return blocks
}
