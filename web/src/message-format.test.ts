import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearMessageFormatCache,
  tokenizeMessageBody,
  type BlockToken,
  type InlineToken,
} from './message-format'

const ID_1 = '123e4567-e89b-12d3-a456-426614174000'
const ID_2 = '123e4567-e89b-12d3-a456-426614174001'
const ID_REJECTED = '123e4567-e89b-12d3-a456-426614174999'

function firstLine(blocks: BlockToken[]): InlineToken[] {
  expect(blocks.length).toBe(1)
  expect(blocks[0].type).toBe('line')
  return (blocks[0] as Extract<BlockToken, { type: 'line' }>).children
}

describe('message-format: Message body formatting and safe autolinks (#628)', () => {
  beforeEach(() => {
    clearMessageFormatCache()
  })

  it('keeps plain text, whitespace, line breaks, and escaped markup literal', () => {
    const blocks = tokenizeMessageBody('hello  world\n\n<script>alert(1)</script> & "quote"')
    expect(blocks).toEqual([
      { type: 'line', children: [{ type: 'text', text: 'hello  world' }] },
      { type: 'line', children: [] },
      { type: 'line', children: [{ type: 'text', text: '<script>alert(1)</script> & "quote"' }] },
    ])
  })

  it('recognizes accepted Mention tokens as atoms first and leaves rejected or pending tokens literal', () => {
    const body = `Hello @{member:${ID_1}}, rejected @{member:${ID_REJECTED}}, malformed @{member:UPPER}`
    const mentions = [{ member_id: ID_1, name: 'Alice' }]

    // Confirmed with accepted ID_1
    expect(firstLine(tokenizeMessageBody(body, mentions))).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'mention', id: ID_1 },
      {
        type: 'text',
        text: `, rejected @{member:${ID_REJECTED}}, malformed @{member:UPPER}`,
      },
    ])

    // Pending never treats a Mention as accepted
    expect(firstLine(tokenizeMessageBody(body, mentions, true))).toEqual([
      { type: 'text', text: body },
    ])
  })

  it('parses fenced code blocks with exact three-backtick lines and keeps Mention atoms inside code', () => {
    const body = [
      'before',
      '```',
      `**not bold** https://example.com @{member:${ID_1}} @{member:${ID_REJECTED}}`,
      'second line',
      '```',
      'after',
    ].join('\n')
    const mentions = [{ member_id: ID_1, name: 'Alice' }]

    expect(tokenizeMessageBody(body, mentions)).toEqual([
      { type: 'line', children: [{ type: 'text', text: 'before' }] },
      {
        type: 'code_block',
        children: [
          { type: 'text', text: '**not bold** https://example.com ' },
          { type: 'mention', id: ID_1 },
          { type: 'text', text: ` @{member:${ID_REJECTED}}\nsecond line` },
        ],
      },
      { type: 'line', children: [{ type: 'text', text: 'after' }] },
    ])

    // Stored CRLF body produces the exact same code block as its LF equivalent
    expect(tokenizeMessageBody('```\r\nx\r\n```')).toEqual(tokenizeMessageBody('```\nx\n```'))
    expect(tokenizeMessageBody('```\r\nx\r\n```')).toEqual([
      {
        type: 'code_block',
        children: [{ type: 'text', text: 'x' }],
      },
    ])
  })

  it('treats an unclosed code fence as literal and parses following lines normally', () => {
    const body = ['```', '**bold line**', 'https://example.com'].join('\n')
    expect(tokenizeMessageBody(body)).toEqual([
      { type: 'line', children: [{ type: 'text', text: '```' }] },
      {
        type: 'line',
        children: [{ type: 'bold', children: [{ type: 'text', text: 'bold line' }] }],
      },
      {
        type: 'line',
        children: [{ type: 'link', href: 'https://example.com', text: 'https://example.com' }],
      },
    ])

    // Fence line with trailing text or spaces is not an exact three-backtick line
    const nonExactFence = ['```ts', 'code', '```'].join('\n')
    expect(tokenizeMessageBody(nonExactFence)).toEqual([
      { type: 'line', children: [{ type: 'text', text: '```ts' }] },
      { type: 'line', children: [{ type: 'text', text: 'code' }] },
      { type: 'line', children: [{ type: 'text', text: '```' }] },
    ])
  })

  it('groups consecutive `> ` lines into a single block quote with inline formatting and no nesting', () => {
    const body = [
      '> first **bold** line',
      '> > second line with https://example.com',
      'normal line',
      '> separate quote',
    ].join('\n')

    expect(tokenizeMessageBody(body)).toEqual([
      {
        type: 'quote',
        lines: [
          [
            { type: 'text', text: 'first ' },
            { type: 'bold', children: [{ type: 'text', text: 'bold' }] },
            { type: 'text', text: ' line' },
          ],
          [
            { type: 'text', text: '> second line with ' },
            { type: 'link', href: 'https://example.com', text: 'https://example.com' },
          ],
        ],
      },
      { type: 'line', children: [{ type: 'text', text: 'normal line' }] },
      {
        type: 'quote',
        lines: [[{ type: 'text', text: 'separate quote' }]],
      },
    ])
  })

  it('parses inline code with backticks, preserving markers, URLs and Mention atoms verbatim', () => {
    const body = `code \`with **bold** https://example.com and @{member:${ID_1}} + @{member:${ID_REJECTED}}\` end`
    const mentions = [{ member_id: ID_1, name: 'Alice' }]

    expect(firstLine(tokenizeMessageBody(body, mentions))).toEqual([
      { type: 'text', text: 'code ' },
      {
        type: 'code',
        children: [
          { type: 'text', text: 'with **bold** https://example.com and ' },
          { type: 'mention', id: ID_1 },
          { type: 'text', text: ` + @{member:${ID_REJECTED}}` },
        ],
      },
      { type: 'text', text: ' end' },
    ])
  })

  it('enforces inline precedence (earliest start wins) and nesting between bold and strikethrough', () => {
    // Bold containing strikethrough and link
    expect(
      firstLine(tokenizeMessageBody('**bold ~~and strike~~ https://example.com/a**')),
    ).toEqual([
      {
        type: 'bold',
        children: [
          { type: 'text', text: 'bold ' },
          { type: 'strikethrough', children: [{ type: 'text', text: 'and strike' }] },
          { type: 'text', text: ' ' },
          { type: 'link', href: 'https://example.com/a', text: 'https://example.com/a' },
        ],
      },
    ])

    // Strikethrough containing bold and inline code
    expect(firstLine(tokenizeMessageBody('~~strike **and bold** `code`~~'))).toEqual([
      {
        type: 'strikethrough',
        children: [
          { type: 'text', text: 'strike ' },
          { type: 'bold', children: [{ type: 'text', text: 'and bold' }] },
          { type: 'text', text: ' ' },
          { type: 'code', children: [{ type: 'text', text: 'code' }] },
        ],
      },
    ])

    // Inline code inside bold/strikethrough containing the surrounding marker does not close the outer emphasis
    expect(firstLine(tokenizeMessageBody('**before `**` after**'))).toEqual([
      {
        type: 'bold',
        children: [
          { type: 'text', text: 'before ' },
          { type: 'code', children: [{ type: 'text', text: '**' }] },
          { type: 'text', text: ' after' },
        ],
      },
    ])
    expect(firstLine(tokenizeMessageBody('~~before `~~` after~~'))).toEqual([
      {
        type: 'strikethrough',
        children: [
          { type: 'text', text: 'before ' },
          { type: 'code', children: [{ type: 'text', text: '~~' }] },
          { type: 'text', text: ' after' },
        ],
      },
    ])

    // Earliest start wins: inline code opening before bold closer consumes the bold closer, leaving the outer ** unclosed
    expect(firstLine(tokenizeMessageBody('**bold `code**` after'))).toEqual([
      { type: 'text', text: '**bold ' },
      {
        type: 'code',
        children: [{ type: 'text', text: 'code**' }],
      },
      { type: 'text', text: ' after' },
    ])

    // Inline code starting before bold opener wins
    expect(firstLine(tokenizeMessageBody('`code **not bold` still not**'))).toEqual([
      {
        type: 'code',
        children: [{ type: 'text', text: 'code **not bold' }],
      },
      { type: 'text', text: ' still not**' },
    ])

    // Autolink containing ** or ~~ is not split by formatting
    expect(
      firstLine(tokenizeMessageBody('https://example.com/**path**/~~file~~ and **bold**')),
    ).toEqual([
      {
        type: 'link',
        href: 'https://example.com/**path**/~~file~~',
        text: 'https://example.com/**path**/~~file~~',
      },
      { type: 'text', text: ' and ' },
      { type: 'bold', children: [{ type: 'text', text: 'bold' }] },
    ])
  })

  it('keeps unclosed or empty inline markers literal and does not match across lines', () => {
    expect(firstLine(tokenizeMessageBody('unclosed `code and **bold and ~~strike'))).toEqual([
      { type: 'text', text: 'unclosed `code and **bold and ~~strike' },
    ])

    // Empty markers stay literal
    expect(firstLine(tokenizeMessageBody('empty `` and **** and ~~~~'))).toEqual([
      { type: 'text', text: 'empty `` and **** and ~~~~' },
    ])

    // Cross-line markers stay literal
    expect(tokenizeMessageBody('**bold\nnext**')).toEqual([
      { type: 'line', children: [{ type: 'text', text: '**bold' }] },
      { type: 'line', children: [{ type: 'text', text: 'next**' }] },
    ])
  })

  it('autolinks allowed schemes (http, https, mailto) case-insensitively with shown text equal to href', () => {
    const blocks = tokenizeMessageBody(
      'Visit https://example.com/path?a=1#hash or HTTP://EXAMPLE.ORG:8080/test and MAILTO:user@example.com',
    )
    expect(firstLine(blocks)).toEqual([
      { type: 'text', text: 'Visit ' },
      {
        type: 'link',
        href: 'https://example.com/path?a=1#hash',
        text: 'https://example.com/path?a=1#hash',
      },
      { type: 'text', text: ' or ' },
      {
        type: 'link',
        href: 'HTTP://EXAMPLE.ORG:8080/test',
        text: 'HTTP://EXAMPLE.ORG:8080/test',
      },
      { type: 'text', text: ' and ' },
      {
        type: 'link',
        href: 'MAILTO:user@example.com',
        text: 'MAILTO:user@example.com',
      },
    ])
  })

  it('rejects disallowed schemes, empty hosts/addresses, and ASCII alphanumeric prefixes', () => {
    const disallowed = [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'JaVaScRiPt:void(0)',
      'data:text/html,<script>alert(1)</script>',
      'DATA:text/plain;base64,SGVsbG8=',
      'vbscript:msgbox(1)',
      'VBSCRIPT:run',
      '//example.com/scheme-relative',
      'ftp://example.com/file',
      'http://',
      'https:///no-host',
      'https://:8080/no-host',
      'https://user@/x',
      'https://user@:8080/x',
      'mailto:',
      'mailto:?subject=hi',
      'mailto:#frag',
      'mailto:user@',
      'foohttps://example.com',
      '9http://example.com',
      'amailto:user@example.com',
    ]

    for (const sample of disallowed) {
      expect(firstLine(tokenizeMessageBody(sample))).toEqual([{ type: 'text', text: sample }])
    }
  })

  it('handles Japanese punctuation, non-ASCII boundaries, trailing ASCII punctuation, and balanced parens/brackets around URLs', () => {
    // Japanese text & full-width punctuation immediately around URL
    expect(
      firstLine(
        tokenizeMessageBody('詳細はhttps://example.com/doc、または「https://example.com/jp」を参照。'),
      ),
    ).toEqual([
      { type: 'text', text: '詳細は' },
      { type: 'link', href: 'https://example.com/doc', text: 'https://example.com/doc' },
      { type: 'text', text: '、または「' },
      { type: 'link', href: 'https://example.com/jp', text: 'https://example.com/jp' },
      { type: 'text', text: '」を参照。' },
    ])

    // Trailing ASCII punctuation excluded: . , : ; ! ? ' "
    expect(
      firstLine(
        tokenizeMessageBody(
          'Links: https://example.com/a.,:;!?\'" and (https://example.com/b) and [https://example.com/c]!',
        ),
      ),
    ).toEqual([
      { type: 'text', text: 'Links: ' },
      { type: 'link', href: 'https://example.com/a', text: 'https://example.com/a' },
      { type: 'text', text: '.,:;!?\'" and (' },
      { type: 'link', href: 'https://example.com/b', text: 'https://example.com/b' },
      { type: 'text', text: ') and [' },
      { type: 'link', href: 'https://example.com/c', text: 'https://example.com/c' },
      { type: 'text', text: ']!' },
    ])

    // Balanced parentheses and brackets inside URL are kept, including matched closing delimiters after an unmatched closer
    expect(
      firstLine(
        tokenizeMessageBody(
          'Wiki (https://en.wikipedia.org/wiki/Rust_(programming_language)) and https://example.com/arr[0] and https://e/x)(a) and https://e/x][a]',
        ),
      ),
    ).toEqual([
      { type: 'text', text: 'Wiki (' },
      {
        type: 'link',
        href: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
        text: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
      },
      { type: 'text', text: ') and ' },
      {
        type: 'link',
        href: 'https://example.com/arr[0]',
        text: 'https://example.com/arr[0]',
      },
      { type: 'text', text: ' and ' },
      {
        type: 'link',
        href: 'https://e/x)(a)',
        text: 'https://e/x)(a)',
      },
      { type: 'text', text: ' and ' },
      {
        type: 'link',
        href: 'https://e/x][a]',
        text: 'https://e/x][a]',
      },
    ])

    // URL stops before an accepted Mention atom
    const mentions = [{ member_id: ID_1, name: 'Alice' }]
    expect(
      firstLine(tokenizeMessageBody(`https://example.com/path@{member:${ID_1}}`, mentions)),
    ).toEqual([
      { type: 'link', href: 'https://example.com/path', text: 'https://example.com/path' },
      { type: 'mention', id: ID_1 },
    ])
  })

  it('reuses cached token trees by (body, accepted id set) and invalidates when accepted set changes', () => {
    const body = `Hello **world** @{member:${ID_1}} @{member:${ID_2}}`
    const mentions1 = [{ member_id: ID_1, name: 'Alice' }]
    const mentions1Renamed = [{ member_id: ID_1, name: 'Alice Renamed' }]
    const mentions1And2 = [
      { member_id: ID_2, name: 'Bob' },
      { member_id: ID_1, name: 'Alice' },
    ]

    const tokensA = tokenizeMessageBody(body, mentions1)
    const tokensB = tokenizeMessageBody(body, mentions1Renamed)
    // Same accepted id set -> exact same cached token array reference
    expect(tokensB).toBe(tokensA)

    // Pending uses empty accepted set -> different token tree
    const tokensPending = tokenizeMessageBody(body, mentions1, true)
    expect(tokensPending).not.toBe(tokensA)
    expect(firstLine(tokensPending)).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'bold', children: [{ type: 'text', text: 'world' }] },
      { type: 'text', text: ` @{member:${ID_1}} @{member:${ID_2}}` },
    ])

    // Different accepted id set -> re-tokenized, while keeping both accepted-set variants cached simultaneously
    const tokensBoth = tokenizeMessageBody(body, mentions1And2)
    expect(tokensBoth).not.toBe(tokensA)
    expect(firstLine(tokensBoth)).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'bold', children: [{ type: 'text', text: 'world' }] },
      { type: 'text', text: ' ' },
      { type: 'mention', id: ID_1 },
      { type: 'text', text: ' ' },
      { type: 'mention', id: ID_2 },
    ])

    // Alternating two Messages with identical body text where the Mention is accepted in one and rejected in the other preserves both cached trees
    const tokensRejected = tokenizeMessageBody(body, [])
    expect(tokensRejected).toBe(tokensPending)
    expect(tokenizeMessageBody(body, mentions1)).toBe(tokensA)
    expect(tokenizeMessageBody(body, [])).toBe(tokensRejected)
    expect(tokenizeMessageBody(body, mentions1And2)).toBe(tokensBoth)
  })

  it('tokenizes 4000-character worst-case bodies in linear time', () => {
    const pattern = '**~~`http:// '
    const worstCaseMarkers = pattern.repeat(Math.ceil(4000 / pattern.length)).slice(0, 4000)
    const worstCaseSchemeRuns = '!h'.repeat(2000)
    const worstCaseTrailingParens = 'http://x' + ')'.repeat(3992)
    // Many failed candidates inside one printable run (round-2 review of #634)
    const failedCandidateRuns = ['http://)', 'http://.', 'http://@', 'mailto:@'].map(unit => unit.repeat(500))

    expect(worstCaseMarkers.length).toBe(4000)
    expect(worstCaseSchemeRuns.length).toBe(4000)
    expect(worstCaseTrailingParens.length).toBe(4000)

    expect(firstLine(tokenizeMessageBody(worstCaseTrailingParens))).toEqual([
      { type: 'link', href: 'http://x', text: 'http://x' },
      { type: 'text', text: ')'.repeat(3992) },
    ])

    for (const sample of [worstCaseMarkers, worstCaseSchemeRuns, worstCaseTrailingParens, ...failedCandidateRuns]) {
      const start = performance.now()
      for (let i = 0; i < 20; i++) {
        clearMessageFormatCache()
        const blocks = tokenizeMessageBody(sample)
        expect(blocks.length).toBe(1)
      }
      const elapsedMs = performance.now() - start
      // 20 uncached runs of each 4000-char worst-case body should take only a few milliseconds
      expect(elapsedMs).toBeLessThan(50)
    }
  })
  it('rejects every failed candidate in a shared run and still links a later valid one', () => {
    for (const unit of ['http://)', 'http://.', 'http://@', 'mailto:@']) {
      expect(firstLine(tokenizeMessageBody(unit.repeat(50)))).toEqual([{ type: 'text', text: unit.repeat(50) }])
    }
    const body = 'http://)http://@(https://ok.example/a(b))).'
    expect(firstLine(tokenizeMessageBody(body))).toEqual([
      { type: 'text', text: 'http://)http://@(' },
      { type: 'link', href: 'https://ok.example/a(b)', text: 'https://ok.example/a(b)' },
      { type: 'text', text: ')).' },
    ])
  })

  it('keeps rejected and pending Mention tokens as unparsed atoms that end URLs and hide markers', () => {
    const rejected = `@{member:${ID_REJECTED}}`
    const mentions = [{ member_id: ID_1, name: 'Alice' }]
    const urlBody = `https://example.com/${rejected}x`
    for (const pending of [false, true]) {
      expect(firstLine(tokenizeMessageBody(urlBody, mentions, pending))).toEqual([
        { type: 'link', href: 'https://example.com/', text: 'https://example.com/' },
        { type: 'text', text: `${rejected}x` },
      ])
    }
    const pendingAccepted = `https://example.com/@{member:${ID_1}}`
    expect(firstLine(tokenizeMessageBody(pendingAccepted, mentions, true))).toEqual([
      { type: 'link', href: 'https://example.com/', text: 'https://example.com/' },
      { type: 'text', text: `@{member:${ID_1}}` },
    ])
  })
})
