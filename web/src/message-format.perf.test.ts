import { beforeEach, describe, expect, it } from 'vitest'
import { clearMessageFormatCache, tokenizeMessageBody, type BlockToken, type InlineToken } from './message-format'

// Timing ratios only hold without other test files competing for the CPU: inside the parallel
// suite they reached 18 on an idle 10-CPU host against at most 10 alone (#753). The `perf`
// project in vite.config.ts runs `*.perf.test.ts` files after every other file, one at a time.

// '**http://u:`**@x/ ** ' + 'http://@/'.repeat(n) + '`http://@', cut to exactly `size` characters
function outOfOrderUrlBody(size: number): string {
  const prefix = '**http://u:`**@x/ ** '
  const suffix = '`http://@'
  const middle = size - prefix.length - suffix.length
  return prefix + 'http://@/'.repeat(Math.ceil(middle / 9)).slice(0, middle) + suffix
}

function firstLine(blocks: BlockToken[]): InlineToken[] {
  expect(blocks.length).toBe(1)
  expect(blocks[0].type).toBe('line')
  return (blocks[0] as Extract<BlockToken, { type: 'line' }>).children
}

describe('message-format: tokenizer scaling (#628)', () => {
  beforeEach(() => {
    clearMessageFormatCache()
  })

  it('tokenizes 8000-character and 64000-character worst-case bodies without quadratic growth', () => {
    const repeatToLen = (unit: string, len: number) =>
      unit.repeat(Math.ceil(len / unit.length)).slice(0, len)

    const sampleFactories: Array<{ name: string; build: (size: number) => string }> = [
      { name: 'mixed markers', build: size => repeatToLen('**~~`http:// ', size) },
      { name: 'scheme runs', build: size => repeatToLen('!h', size) },
      { name: 'trailing parens', build: size => 'http://x' + ')'.repeat(size - 8) },
      // Many failed candidates inside one printable run (round-2 review of #634)
      { name: 'failed http://)', build: size => repeatToLen('http://)', size) },
      { name: 'failed http://.', build: size => repeatToLen('http://.', size) },
      { name: 'failed http://@', build: size => repeatToLen('http://@', size) },
      { name: 'failed mailto:@', build: size => repeatToLen('mailto:@', size) },
      { name: 'failed http://a%b/', build: size => repeatToLen('http://a%b/', size) },
      { name: 'failed http://[bad]/', build: size => repeatToLen('http://[bad]/', size) },
      { name: 'unclosed bold failed URLs', build: size => '**' + repeatToLen('http://)', size - 2) },
      {
        name: 'nested emphasis failed URLs',
        build: size => '**' + repeatToLen('~~http://)', size - 2),
      },
      { name: 'repeated inner emphasis', build: size => '**' + repeatToLen('~~a~~', size - 2) },
      { name: 'unclosed bold + ~~a', build: size => '**' + repeatToLen('~~a', size - 2) },
      { name: 'alternating markers', build: size => repeatToLen('**~~', size) },
      { name: 'backtick-heavy ** + `a', build: size => '**' + repeatToLen('`a', size - 2) },
      { name: 'backtick-heavy **~~ + `', build: size => '**~~' + '`'.repeat(size - 4) },
      // Successful nested emphasis reparsed inside failing outer openers (round-4 review of #634)
      {
        name: 'nested strike in failing bold',
        build: size => {
          const unit = '**http://u:~~``**@x/ '
          const suffix = '`~~'
          const count = Math.floor((size - suffix.length) / unit.length)
          const pad = size - count * unit.length - suffix.length
          return ' '.repeat(pad) + unit.repeat(count) + suffix
        },
      },
      {
        name: 'nested bold in failing strike',
        build: size => {
          const unit = '~~http://u:**``~~@x/ '
          const suffix = '`**'
          const count = Math.floor((size - suffix.length) / unit.length)
          const pad = size - count * unit.length - suffix.length
          return ' '.repeat(pad) + unit.repeat(count) + suffix
        },
      },
      // Accepted O(N log N) family: out-of-order autolink queries (round-5 review of #634)
      { name: 'out-of-order URL queries', build: size => outOfOrderUrlBody(size) },
    ]

    const trailingParens8k = sampleFactories[2].build(8000)
    expect(trailingParens8k.length).toBe(8000)
    expect(firstLine(tokenizeMessageBody(trailingParens8k))).toEqual([
      { type: 'link', href: 'http://x', text: 'http://x' },
      { type: 'text', text: ')'.repeat(7992) },
    ])

    const MIN_BATCH_MS = 5
    const SAMPLES = 5
    const measureBatch = (input: string): number => {
      let count = 0
      const start = performance.now()
      do {
        clearMessageFormatCache()
        expect(tokenizeMessageBody(input).length).toBe(1)
        count++
      } while (performance.now() - start < MIN_BATCH_MS)
      return (performance.now() - start) / count
    }

    const measurePair = (s8k: string, s64k: string): { med8k: number; med64k: number } => {
      // Warm up JIT before measuring
      for (let i = 0; i < 2; i++) {
        clearMessageFormatCache()
        tokenizeMessageBody(s8k)
        clearMessageFormatCache()
        tokenizeMessageBody(s64k)
      }
      const runs8k: number[] = []
      const runs64k: number[] = []
      for (let s = 0; s < SAMPLES; s++) {
        runs8k.push(measureBatch(s8k))
        runs64k.push(measureBatch(s64k))
      }
      runs8k.sort((a, b) => a - b)
      runs64k.sort((a, b) => a - b)
      return {
        med8k: runs8k[Math.floor(runs8k.length / 2)],
        med64k: runs64k[Math.floor(runs64k.length / 2)],
      }
    }

    for (const { name, build } of sampleFactories) {
      const s8k = build(8000)
      const s64k = build(64000)
      expect(s8k.length, name).toBe(8000)
      expect(s64k.length, name).toBe(64000)

      const { med8k, med64k } = measurePair(s8k, s64k)
      // 8x input growth should stay well below 64x quadratic scaling
      expect(
        med64k / med8k,
        `${name}: 8k=${med8k.toFixed(3)}ms 64k=${med64k.toFixed(3)}ms`,
      ).toBeLessThan(24)
    }
  })
  it('tokenizes the accepted O(N log N) family at 3,999 characters and the 32 KiB body limit', () => {
    // #628 accepts worst-case O(N log N); this family is the round-5 reproduction from #634
    expect(outOfOrderUrlBody(3999)).toBe(
      '**http://u:`**@x/ ** ' + 'http://@/'.repeat(441) + '`http://@',
    )
    const small = outOfOrderUrlBody(3999)
    const large = outOfOrderUrlBody(32 * 1024)
    expect(small.length).toBe(3999)
    expect(large.length).toBe(32 * 1024)

    const BATCH_CALLS = 16
    const SAMPLES = 5
    const measureFixedBatch = (body: string): number => {
      const start = performance.now()
      for (let i = 0; i < BATCH_CALLS; i++) {
        clearMessageFormatCache()
        expect(tokenizeMessageBody(body).length).toBe(1)
      }
      return (performance.now() - start) / BATCH_CALLS
    }

    // Warm up JIT before measuring
    for (let i = 0; i < 2; i++) {
      clearMessageFormatCache()
      tokenizeMessageBody(small)
      clearMessageFormatCache()
      tokenizeMessageBody(large)
    }

    const runsSmall: number[] = []
    const runsLarge: number[] = []
    for (let s = 0; s < SAMPLES; s++) {
      runsSmall.push(measureFixedBatch(small))
      runsLarge.push(measureFixedBatch(large))
    }
    runsSmall.sort((a, b) => a - b)
    runsLarge.sort((a, b) => a - b)
    const medSmall = runsSmall[Math.floor(runsSmall.length / 2)]
    const medLarge = runsLarge[Math.floor(runsLarge.length / 2)]
    // 32768 / 3999 ~= 8.19x input: O(N log N) is ~10.3x (8.19 * log2(32768)/log2(3999)),
    // O(N^2) is ~67.1x (8.19^2); 25 cleanly separates them (~2.4x above O(N log N), ~2.7x below O(N^2)).
    expect(
      medLarge / medSmall,
      `3999=${medSmall.toFixed(3)}ms 32KiB=${medLarge.toFixed(3)}ms`,
    ).toBeLessThan(25)
  })
})
