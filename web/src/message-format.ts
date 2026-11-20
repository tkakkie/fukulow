import type { Message } from './api'
import { isUrlChar, matchAutolink, matchScheme, scanUrlRun, type UrlRun } from './message-autolink'

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

type StepItem =
  | { type: 'text'; text: string }
  | { type: 'mention'; id: string }
  | { type: 'code'; start: number; end: number }
  | { type: 'link'; start: number; end: number }
  | { type: 'bold'; head: SpanNode }
  | { type: 'strikethrough'; head: SpanNode }

type SpanNode =
  | { kind: 'item'; item: StepItem; next: SpanNode | null; nextPos: number }
  | { kind: 'slice'; start: number; end: number; next: SpanNode | null; nextPos: number }

type StepRecord =
  | { kind: 'item'; pos: number; item: StepItem }
  | { kind: 'slice'; start: number; end: number }

const DEAD = 0 as const
type MemoEntry = typeof DEAD | SpanNode
type UrlRunSlot = { last: UrlRun | null; byPos: (UrlRun | undefined)[] | null }
type UrlRunTable = [UrlRunSlot, UrlRunSlot, UrlRunSlot, UrlRunSlot]

const LONG_URL_RUN_THRESHOLD = 128

function getUrlRun(
  line: IndexedLine,
  i: number,
  end: number,
  breakKind: number,
  isUrlBreak: (k: number) => boolean,
  urlRuns: UrlRunTable,
): UrlRun {
  const slot = urlRuns[breakKind]
  if (slot.last !== null && i >= slot.last.start && i < slot.last.end) {
    return slot.last
  }
  if (slot.byPos !== null) {
    const existing = slot.byPos[i]
    if (existing !== undefined) {
      slot.last = existing
      return existing
    }
  }
  let runStart = i
  while (runStart > 0 && !isUrlBreak(runStart - 1) && isUrlChar(line.str.charCodeAt(runStart - 1))) {
    runStart--
  }
  const run = scanUrlRun(line.str, runStart, end, isUrlBreak)
  slot.last = run
  if (run.end - run.start >= LONG_URL_RUN_THRESHOLD) {
    if (slot.byPos === null) {
      slot.byPos = new Array<UrlRun | undefined>(end)
    }
    for (let k = run.start; k < run.end; k++) {
      slot.byPos[k] = run
    }
  }
  return run
}

/**
 * Single-pass memoised inline parser. Emphasis closers are found by the same
 * scan that records steps, so autolinks, inline code, and nested emphasis can
 * never disagree on boundaries.
 *
 * Complexity O(N * stacks): for each non-empty `stack` (4 values), every
 * transition from position `i` depends only on `(i, stack)` (except `i === start`
 * at `closeChar`, which fails in O(1) without memoising). Each `(i, stack)` is
 * therefore scanned at most once and then permanently memoised as either `DEAD`
 * or an immutable `SpanNode` suffix linked to the span's closer (`nextPos`).
 * Reusing a `SpanNode` is O(1) with no array copying, and `UrlRun` tables are
 * cached per `(breakKind, run)`. Only surviving `STACK_NONE` spans are
 * materialized into fresh `InlineToken[]` trees, and no token object is ever
 * shared and mutated. Out-of-order autolink queries fall back to a binary search
 * in `matchAutolink`, so the worst case is O(N log N), accepted for #628.
 */
function parseSpan(
  line: IndexedLine,
  start: number,
  stack: EmphasisStack,
  memo: ((MemoEntry | undefined)[] | null)[],
  urlRuns: UrlRunTable,
): SpanNode | null {
  const end = line.str.length
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

  if (closeChar !== null && isPairAt(line, start, end, closeChar)) {
    return null
  }

  let memoForStack = stack === STACK_NONE ? null : memo[stack]
  if (memoForStack !== null) {
    const cached = memoForStack[start]
    if (cached === DEAD) return null
    if (cached !== undefined) {
      return cached.kind === 'slice' && cached.start !== start
        ? { kind: 'slice', start, end: cached.end, next: cached.next, nextPos: cached.nextPos }
        : cached
    }
  }

  const steps: StepRecord[] = []
  let sliceStart = -1

  const flushSlice = (pos: number) => {
    if (sliceStart !== -1) {
      steps.push({ kind: 'slice', start: sliceStart, end: pos })
      sliceStart = -1
    }
  }

  const ensureMemo = (): (MemoEntry | undefined)[] => {
    if (memoForStack === null) {
      memoForStack = new Array<MemoEntry | undefined>(end + 1)
      memo[stack] = memoForStack
    }
    return memoForStack
  }

  const markDeadAndFail = (extraPos?: number): null => {
    if (stack !== STACK_NONE) {
      const table = ensureMemo()
      for (let k = 0; k < steps.length; k++) {
        const s = steps[k]
        if (s.kind === 'item') {
          table[s.pos] = DEAD
        } else {
          for (let p = s.start; p < s.end; p++) table[p] = DEAD
        }
      }
      if (extraPos !== undefined) {
        table[extraPos] = DEAD
      }
    }
    return null
  }

  const commitSuccess = (tail: SpanNode | null, nextPos: number): SpanNode | null => {
    let cur: SpanNode | null = tail
    const table = stack !== STACK_NONE ? ensureMemo() : null
    for (let k = steps.length - 1; k >= 0; k--) {
      const s = steps[k]
      if (s.kind === 'item') {
        const node: SpanNode = { kind: 'item', item: s.item, next: cur, nextPos }
        if (table !== null) table[s.pos] = node
        cur = node
      } else {
        const node: SpanNode = {
          kind: 'slice',
          start: s.start,
          end: s.end,
          next: cur,
          nextPos,
        }
        if (table !== null) {
          for (let p = s.start; p < s.end; p++) table[p] = node
        }
        cur = node
      }
    }
    return cur
  }

  const breakKind = (boldOpen ? 1 : 0) | (strikeOpen ? 2 : 0)
  const isUrlBreak = (k: number): boolean =>
    line.atoms.has(k) ||
    (boldOpen && isPairAt(line, k, end, '*')) ||
    (strikeOpen && isPairAt(line, k, end, '~'))

  let i = start
  while (i < end) {
    if (closeChar !== null && isPairAt(line, i, end, closeChar)) {
      flushSlice(i)
      return commitSuccess(null, i + 2)
    }

    if (outerCloseChar !== null && isPairAt(line, i, end, outerCloseChar)) {
      flushSlice(i)
      return markDeadAndFail(i)
    }

    if (memoForStack !== null) {
      const cached = memoForStack[i]
      if (cached === DEAD) {
        flushSlice(i)
        return markDeadAndFail()
      }
      if (cached !== undefined) {
        flushSlice(i)
        const tail: SpanNode =
          cached.kind === 'slice' && cached.start !== i
            ? { kind: 'slice', start: i, end: cached.end, next: cached.next, nextPos: cached.nextPos }
            : cached
        return commitSuccess(tail, tail.nextPos)
      }
    }

    const atom = line.atoms.get(i)
    if (atom !== undefined) {
      flushSlice(i)
      steps.push({
        kind: 'item',
        pos: i,
        item:
          atom.type === 'literal'
            ? { type: 'text', text: atom.text }
            : { type: 'mention', id: atom.id },
      })
      i++
      continue
    }

    const ch = line.str[i]

    // 1. Inline code: backtick to the next backtick, non-empty
    if (ch === '`') {
      const closeIdx = line.nextBacktick.get(i) ?? -1
      if (closeIdx > i + 1 && closeIdx < end) {
        flushSlice(i)
        steps.push({ kind: 'item', pos: i, item: { type: 'code', start: i + 1, end: closeIdx } })
        i = closeIdx + 1
        continue
      }
      if (sliceStart === -1) sliceStart = i
      i++
      continue
    }

    // 2. Autolink: candidates in one printable run share its precomputed tables
    if (ch === 'h' || ch === 'H' || ch === 'm' || ch === 'M') {
      if (i === 0 || line.atoms.has(i - 1) || !ASCII_ALNUM.test(line.str[i - 1])) {
        const scheme = matchScheme(line.str, i, end)
        if (scheme !== null) {
          const run = getUrlRun(line, i, end, breakKind, isUrlBreak, urlRuns)
          const linkEnd = matchAutolink(run, i, scheme)
          if (linkEnd !== -1) {
            flushSlice(i)
            steps.push({ kind: 'item', pos: i, item: { type: 'link', start: i, end: linkEnd } })
            i = linkEnd
            continue
          }
        }
      }
    }

    // 3. Bold: **...**
    if (!boldOpen && isPairAt(line, i, end, '*')) {
      const nextStack: EmphasisStack = strikeOpen ? STACK_STRIKE_BOLD : STACK_BOLD
      const inner = parseSpan(line, i + 2, nextStack, memo, urlRuns)
      flushSlice(i)
      if (inner !== null) {
        steps.push({ kind: 'item', pos: i, item: { type: 'bold', head: inner } })
        i = inner.nextPos
        continue
      }
      steps.push({ kind: 'item', pos: i, item: { type: 'text', text: '**' } })
      i += 2
      continue
    }

    // 4. Strikethrough: ~~...~~
    if (!strikeOpen && isPairAt(line, i, end, '~')) {
      const nextStack: EmphasisStack = boldOpen ? STACK_BOLD_STRIKE : STACK_STRIKE
      const inner = parseSpan(line, i + 2, nextStack, memo, urlRuns)
      flushSlice(i)
      if (inner !== null) {
        steps.push({ kind: 'item', pos: i, item: { type: 'strikethrough', head: inner } })
        i = inner.nextPos
        continue
      }
      steps.push({ kind: 'item', pos: i, item: { type: 'text', text: '~~' } })
      i += 2
      continue
    }

    if (sliceStart === -1) sliceStart = i
    i++
  }

  flushSlice(end)
  if (stack !== STACK_NONE) {
    return markDeadAndFail()
  }
  return commitSuccess(null, end)
}

function materializeSpan(line: IndexedLine, head: SpanNode | null): InlineToken[] {
  const tokens: InlineToken[] = []
  let textBuffer = ''

  const flushText = () => {
    if (textBuffer.length > 0) {
      tokens.push({ type: 'text', text: textBuffer })
      textBuffer = ''
    }
  }

  for (let cur = head; cur !== null; cur = cur.next) {
    if (cur.kind === 'slice') {
      textBuffer += line.str.slice(cur.start, cur.end)
      continue
    }
    const { item } = cur
    switch (item.type) {
      case 'text':
        textBuffer += item.text
        break
      case 'mention':
        flushText()
        tokens.push({ type: 'mention', id: item.id })
        break
      case 'code':
        flushText()
        tokens.push({ type: 'code', children: sliceCodeChildren(line, item.start, item.end) })
        break
      case 'link': {
        flushText()
        const url = line.str.slice(item.start, item.end)
        tokens.push({ type: 'link', href: url, text: url })
        break
      }
      case 'bold':
        flushText()
        tokens.push({ type: 'bold', children: materializeSpan(line, item.head) })
        break
      case 'strikethrough':
        flushText()
        tokens.push({ type: 'strikethrough', children: materializeSpan(line, item.head) })
        break
    }
  }
  flushText()
  return tokens
}

function parseInlineLine(parts: AtomPart[]): InlineToken[] {
  if (parts.length === 0) return []
  const indexed = indexLine(parts)
  const memo: ((MemoEntry | undefined)[] | null)[] = [null, null, null, null, null]
  const urlRuns: UrlRunTable = [
    { last: null, byPos: null },
    { last: null, byPos: null },
    { last: null, byPos: null },
    { last: null, byPos: null },
  ]
  const head = parseSpan(indexed, 0, STACK_NONE, memo, urlRuns)
  return materializeSpan(indexed, head)
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
