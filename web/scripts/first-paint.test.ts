import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  AUTHOR_LOOKUP_API_PATH,
  DIRECTORY_API_PATH,
  findDiagnosticStarts,
  hasResolvedSenderLabel,
  resolveArmSourceSha,
  summarizeCell,
  waitForPageMilestones,
  type MilestoneProbe,
  type RunMetrics,
} from './first-paint.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('first-paint measurement diagnostics (#954 R1)', () => {
  it('matches the real POST /message-authors request so authorLookupStartMs is recorded', () => {
    const openapi = JSON.parse(readFileSync(resolve(root, 'openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>
    }
    expect(openapi.paths[AUTHOR_LOOKUP_API_PATH]?.post).toBeDefined()
    expect(openapi.paths[DIRECTORY_API_PATH]?.get).toBeDefined()

    const apiSource = readFileSync(resolve(root, 'web/src/api.ts'), 'utf8')
    expect(apiSource).toContain('/message-authors')

    const starts = findDiagnosticStarts([
      { method: 'GET', path: '/api/v1/orgs/{org}/channels/{channel}/timeline', start: 120 },
      { method: 'POST', path: '/api/v1/orgs/{org}/message-authors', start: 185.5 },
      { method: 'GET', path: '/api/v1/orgs/{org}/members', start: 260.25 },
    ])
    expect(starts).toEqual({
      directoryStartMs: 260.25,
      authorLookupStartMs: 185.5,
    })
  })

  it('records firstNamedRowMs when any mounted row is named and never gates FCP/Timeline on named-row or directory timeouts', async () => {
    // A single unresolved sender (メンバー) must not block named-row detection when a named row is visible.
    expect(hasResolvedSenderLabel(['アリス', 'メンバー'])).toBe(true)
    expect(hasResolvedSenderLabel(['メンバー', ''])).toBe(false)
    expect(hasResolvedSenderLabel([])).toBe(false)

    // Primary FCP/Timeline wait succeeds even when firstNamedRowMs is null and directory has not started.
    const probe: MilestoneProbe = {
      timelineVisibleMs: 310,
      timelinePaintedMs: 325,
      wsSubscribedMs: 210,
      fcpMs: 140,
      firstNamedRowMs: null,
      apiCalls: [],
    }
    const prevWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = { __fp345: probe }
    const calls: Array<{ satisfied: boolean }> = []
    const fakePage = {
      waitForFunction: vi.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
        const satisfied = Boolean(fn(arg))
        calls.push({ satisfied })
        if (!satisfied) throw new Error('Timeout 5000ms exceeded')
        return undefined as never
      }),
    }
    try {
      await expect(waitForPageMilestones(fakePage, { primaryTimeoutMs: 1000, diagnosticTimeoutMs: 50 })).resolves.toBeUndefined()
      expect(calls).toEqual([{ satisfied: true }, { satisfied: false }])
    } finally {
      if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window
      else (globalThis as { window?: unknown }).window = prevWindow
    }

    // summarizeCell handles runs where firstNamedRowMs is null without throwing.
    const baseRun: RunMetrics = {
      run: 1,
      ttfbMs: 10,
      htmlEndMs: 20,
      htmlTransferBytes: 1000,
      fcpMs: 140,
      blankScreenMs: 140,
      jsEndMs: 100,
      cssEndMs: 80,
      wasmEndMs: 110,
      assetsEndMs: 110,
      assetsTransferBytes: 50000,
      appMountMs: 150,
      wsConnectStartMs: 160,
      wsOpenMs: 180,
      wsSubscribeSentMs: 185,
      wsSubscribedMs: 210,
      timelineVisibleMs: 310,
      timelinePaintedMs: 325,
      firstNamedRowMs: null,
      directoryStartMs: null,
      authorLookupStartMs: 190,
      apiCalls: [],
      timingChain: [],
    }
    const summary = summarizeCell('/', '/', 'throttled', 'cold', [baseRun])
    expect(summary.fcpMs.p50).toBe(140)
    expect(summary.timelineVisibleMs.p50).toBe(310)
    expect(summary.firstNamedRowMs).toBeNull()
    expect(summary.authorLookupStartMs?.p50).toBe(190)
  })

  it('records the measured image source revision for prebuilt arms and refuses falling back to checkout SHA', () => {
    const checkoutSha = 'checkout-sha-1111111'
    const imageSha = 'image-sha-2222222'
    const explicitSha = 'explicit-sha-3333333'

    // Prebuilt arm reads revision from the measured image label instead of checkout SHA.
    expect(
      resolveArmSourceSha({
        prebuiltImage: 'fukulow-954:baseline',
        explicitSourceSha: undefined,
        inspectImageRevision: () => imageSha,
        checkoutSha,
      }),
    ).toBe(imageSha)

    // Explicit FIRST_PAINT_SOURCE_SHA overrides both label and checkout SHA.
    expect(
      resolveArmSourceSha({
        prebuiltImage: 'fukulow-954:candidate',
        explicitSourceSha: explicitSha,
        inspectImageRevision: () => imageSha,
        checkoutSha,
      }),
    ).toBe(explicitSha)

    // Prebuilt arm with no label and no explicit SHA must fail rather than recording checkout SHA.
    expect(() =>
      resolveArmSourceSha({
        prebuiltImage: 'fukulow-954:baseline',
        explicitSourceSha: undefined,
        inspectImageRevision: () => '<no value>',
        checkoutSha,
      }),
    ).toThrow(/FIRST_PAINT_SOURCE_SHA/)
    expect(() =>
      resolveArmSourceSha({
        prebuiltImage: 'fukulow-954:baseline',
        explicitSourceSha: undefined,
        inspectImageRevision: () => null,
        checkoutSha,
      }),
    ).toThrow(/FIRST_PAINT_SOURCE_SHA/)

    // Non-prebuilt arm built from the current checkout records checkout SHA.
    expect(
      resolveArmSourceSha({
        prebuiltImage: undefined,
        explicitSourceSha: undefined,
        inspectImageRevision: () => null,
        checkoutSha,
      }),
    ).toBe(checkoutSha)
  })
})
