// Autolink matching for Message body formatting (#628, docs/spec/realtime.md rule 5).
// Every candidate inside one printable run shares the run's precomputed tables, so a
// body full of failed candidates stays linear instead of rescanning the run's suffix.

const TRAILING_PUNCT = new Set(['.', ',', ':', ';', '!', '?', "'", '"'])

export type Scheme = { schemeLen: number; isMailto: boolean }

/** One maximal run of printable ASCII without Mention atoms, `[start, end)` in `str`. */
export type UrlRun = {
  str: string
  start: number
  end: number
  /** Indexed by `k - start`: for `)` or `]`, the index of its matching opener, else -1. */
  opener: Int32Array
  /** Indexed by `k - start`: next `/`, `?` or `#` at or after k, else `end`. */
  nextHttpDelim: Int32Array
  /** Indexed by `k - start`: next `?` or `#` at or after k, else `end`. */
  nextMailDelim: Int32Array
  /** Trim boundary shared by later candidates; it only moves left (see `matchAutolink`). */
  trimEnd: number
}

export function isUrlChar(code: number): boolean {
  return code >= 0x21 && code <= 0x7e
}

export function matchScheme(str: string, index: number, end: number): Scheme | null {
  if (index + 7 > end) return null
  const prefix = str.slice(index, Math.min(end, index + 8)).toLowerCase()
  if (prefix.startsWith('https://')) return { schemeLen: 8, isMailto: false }
  if (prefix.startsWith('http://')) return { schemeLen: 7, isMailto: false }
  if (prefix.startsWith('mailto:')) return { schemeLen: 7, isMailto: true }
  return null
}

export function scanUrlRun(str: string, start: number, limit: number, isBreak: (i: number) => boolean): UrlRun {
  let end = start
  while (end < limit && !isBreak(end) && isUrlChar(str.charCodeAt(end))) end++
  const size = end - start
  const opener = new Int32Array(size).fill(-1)
  const parens: number[] = []
  const brackets: number[] = []
  for (let k = start; k < end; k++) {
    const ch = str[k]
    if (ch === '(') parens.push(k)
    else if (ch === '[') brackets.push(k)
    else if (ch === ')') opener[k - start] = parens.pop() ?? -1
    else if (ch === ']') opener[k - start] = brackets.pop() ?? -1
  }
  const nextHttpDelim = new Int32Array(size)
  const nextMailDelim = new Int32Array(size)
  let http = end
  let mail = end
  for (let k = end - 1; k >= start; k--) {
    const ch = str[k]
    if (ch === '?' || ch === '#') {
      http = k
      mail = k
    } else if (ch === '/') {
      http = k
    }
    nextHttpDelim[k - start] = http
    nextMailDelim[k - start] = mail
  }
  return { str, start, end, opener, nextHttpDelim, nextMailDelim, trimEnd: end }
}

/**
 * Returns the link end for a candidate at `index` (inside `run`, scheme already matched),
 * or -1. Candidates must be tried in increasing `index` order within one run: a trailing
 * character trimmable for an earlier candidate is trimmable for every later one, so the
 * shared trim boundary only moves left and the total trimming work is linear.
 */
export function matchAutolink(run: UrlRun, index: number, scheme: Scheme): number {
  const { str } = run
  const body = index + scheme.schemeLen
  if (body >= run.end || str[body] === '/' || str[body] === '#') return -1

  let end = Math.max(run.trimEnd, body)
  while (end > body) {
    const ch = str[end - 1]
    const unmatchedCloser = (ch === ')' || ch === ']') && run.opener[end - 1 - run.start] < body
    if (!TRAILING_PUNCT.has(ch) && !unmatchedCloser) break
    end--
  }
  run.trimEnd = end
  if (end === body) return -1

  if (scheme.isMailto) {
    const addressEnd = Math.min(run.nextMailDelim[body - run.start], end)
    if (addressEnd === body || str[body] === '@' || str[addressEnd - 1] === '@') return -1
    return end
  }
  const authorityEnd = Math.min(run.nextHttpDelim[body - run.start], end)
  return validHttpAuthority(str.slice(body, authorityEnd)) ? end : -1
}

// Each http candidate's authority ends at the next `/`, which every later `http://`
// candidate contains, so authorities overlap by at most a scheme and slicing stays linear.
function validHttpAuthority(authority: string): boolean {
  if (authority.length === 0 || authority.includes('\\')) return false
  const atIdx = authority.lastIndexOf('@')
  if (atIdx === 0) return false
  const hostPort = atIdx === -1 ? authority : authority.slice(atIdx + 1)
  if (hostPort.length === 0) return false

  if (hostPort.startsWith('[')) {
    const closeBracket = hostPort.indexOf(']')
    if (closeBracket <= 1) return false
    const afterBracket = hostPort.slice(closeBracket + 1)
    if (afterBracket.length > 0 && !/^:\d+$/.test(afterBracket)) return false
  } else {
    const colonIdx = hostPort.indexOf(':')
    const hostname = colonIdx === -1 ? hostPort : hostPort.slice(0, colonIdx)
    if (hostname.length === 0 || /[[\]]/.test(hostname)) return false
    if (colonIdx !== -1 && !/^\d+$/.test(hostPort.slice(colonIdx + 1))) return false
  }

  try {
    const parsed = new URL(`http://${authority}`)
    return (
      parsed.hostname.length > 0 &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    )
  } catch {
    return false
  }
}
