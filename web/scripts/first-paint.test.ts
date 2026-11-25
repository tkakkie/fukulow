import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { MiniDocument, MiniElement } from '../src/svelte-dom-test-helpers.ts'
import {
  AUTHOR_LOOKUP_API_PATH,
  DIRECTORY_API_PATH,
  collectRunMetrics,
  extractRunMetricsInPage,
  findDiagnosticStarts,
  installFirstPaintProbe,
  resolveArmSourceSha,
  summarizeCell,
  waitForPageMilestones,
  type MilestoneProbe,
  type RunMetrics,
} from './first-paint.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function withProbeGlobals<T>(fn: (ctx: {
  doc: MiniDocument
  win: Record<string, unknown>
  triggerMutation: () => void
  mutationOptions: MutationObserverInit[]
}) => T): T {
  const doc = new MiniDocument()
  const mutationCallbacks: Array<() => void> = []
  const mutationOptions: MutationObserverInit[] = []
  class FakeMutationObserver {
    private cb: () => void
    constructor(cb: () => void) { this.cb = cb }
    observe(_target: unknown, opts: MutationObserverInit) {
      mutationCallbacks.push(this.cb)
      mutationOptions.push(opts)
    }
    disconnect() {}
  }
  class FakePerformanceObserver {
    observe() {}
    disconnect() {}
  }
  class FakeWebSocket {
    addEventListener() {}
    send() {}
  }
  const win: Record<string, unknown> = {
    location: { origin: 'https://localhost' },
    fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    WebSocket: FakeWebSocket,
    getComputedStyle: (el: MiniElement) => ({
      display: 'block',
      visibility: el.closest('.timeline-scroll--positioning, .topic-view__scroll--positioning') ? 'hidden' : 'visible',
    }),
  }
  const g = globalThis as Record<string, unknown>
  const saved = {
    window: g.window,
    document: g.document,
    MutationObserver: g.MutationObserver,
    PerformanceObserver: g.PerformanceObserver,
    requestAnimationFrame: g.requestAnimationFrame,
  }
  g.window = win
  g.document = doc
  g.MutationObserver = FakeMutationObserver
  g.PerformanceObserver = FakePerformanceObserver
  g.requestAnimationFrame = (cb: () => void) => { cb(); return 1 }
  try {
    return fn({
      doc,
      win,
      triggerMutation: () => { for (const cb of mutationCallbacks) cb() },
      mutationOptions,
    })
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]
      else g[k] = v
    }
  }
}

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

  it('browser probe ignores rows hidden under positioning Skeleton/inert/aria-busy and records firstNamedRowMs when any visible row is named', () => {
    withProbeGlobals(({ doc, win, triggerMutation, mutationOptions }) => {
      installFirstPaintProbe({ expectedOrg: 'org-1', expectedChannel: 'ch-1' })
      const probe = win.__fp345 as MilestoneProbe & { appMountMs: number | null }

      // Probe observes attribute changes so clearing inert/aria-busy/positioning class is detected without childList changes.
      expect(mutationOptions[0]?.attributes).toBe(true)

      const app = doc.createElement('div')
      app.setAttribute('id', 'app')
      const scroll = doc.createElement('div')
      scroll.setAttribute('class', 'timeline-scroll timeline-scroll--positioning')
      scroll.setAttribute('aria-busy', 'true')
      scroll.inert = true
      const list = doc.createElement('div')
      list.setAttribute('class', 'timeline-list')

      const addRow = (senderLabel: string) => {
        const item = doc.createElement('div')
        item.setAttribute('class', 'timeline-list__item')
        const sender = doc.createElement('span')
        sender.setAttribute('class', 'ui-message-row__sender')
        sender.textContent = senderLabel
        item.appendChild(sender)
        list.appendChild(item)
      }
      // One resolved sender and one unresolved placeholder row.
      addRow('アリス')
      addRow('メンバー')

      scroll.appendChild(list)
      app.appendChild(scroll)
      doc.body.appendChild(app)

      // While rows are behind the positioning Skeleton (inert + aria-busy + visibility: hidden),
      // neither timelineVisibleMs nor firstNamedRowMs may be recorded.
      triggerMutation()
      expect(probe.appMountMs).not.toBeNull()
      expect(probe.timelineVisibleMs).toBeNull()
      expect(probe.timelinePaintedMs).toBeNull()
      expect(probe.firstNamedRowMs).toBeNull()

      // Even if only inert/aria-busy remain (without positioning class), rows are still not interactive/visible.
      scroll.setAttribute('class', 'timeline-scroll')
      triggerMutation()
      expect(probe.timelineVisibleMs).toBeNull()
      expect(probe.firstNamedRowMs).toBeNull()

      // Once positioning ends, the visible timeline and first named row (despite the sibling メンバー row) are recorded.
      scroll.inert = false
      scroll.removeAttribute('aria-busy')
      triggerMutation()
      expect(probe.timelineVisibleMs).not.toBeNull()
      expect(probe.timelinePaintedMs).not.toBeNull()
      expect(probe.firstNamedRowMs).not.toBeNull()
    })
  })

  it('never gates FCP/Timeline on diagnostic timeouts or stalled deferred directory response bodies', async () => {
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
      await expect(waitForPageMilestones(fakePage, { primaryTimeoutMs: 1000, diagnosticTimeoutMs: 50 })).resolves.toBeGreaterThanOrEqual(0)
      expect(calls).toEqual([{ satisfied: true }, { satisfied: false }])
    } finally {
      if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window
      else (globalThis as { window?: unknown }).window = prevWindow
    }

    // A stalled deferred GET /members response body must not hang page.evaluate or drop the valid FCP/Timeline sample.
    const stalledDone = new Promise<void>(() => {})
    const fullProbe = {
      appMountMs: 150,
      fcpMs: 140,
      timelineVisibleMs: 310,
      timelinePaintedMs: 325,
      firstNamedRowMs: 315,
      wsConnectStartMs: 160,
      wsOpenMs: 180,
      wsSubscribeSentMs: 185,
      wsSubscribedMs: 210,
      apiCalls: [
        {
          seq: 1,
          method: 'GET',
          path: '/api/v1/orgs/{org}/channels/{channel}/timeline',
          label: 'GET /api/v1/orgs/{org}/channels/{channel}/timeline',
          start: 190,
          headersEnd: 240,
          end: 250,
          status: 200,
          latestEndedBefore: null,
          done: Promise.resolve(),
        },
        {
          seq: 2,
          method: 'GET',
          path: DIRECTORY_API_PATH,
          label: `GET ${DIRECTORY_API_PATH}`,
          start: 330,
          headersEnd: 330,
          end: null,
          status: 0,
          latestEndedBefore: 'GET /api/v1/orgs/{org}/channels/{channel}/timeline',
          done: stalledDone,
        },
      ],
    }
    ;(globalThis as { window?: unknown }).window = {
      __fp345: fullProbe,
      location: { origin: 'https://localhost' },
    }
    const stalledPage = {
      waitForFunction: vi.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
        if (!fn(arg)) throw new Error('Timeout')
        return undefined as never
      }),
      evaluate: vi.fn(async (fn: typeof extractRunMetricsInPage, arg: Parameters<typeof extractRunMetricsInPage>[0]) => {
        return await fn(arg)
      }),
    }
    try {
      const startedAt = Date.now()
      const metrics = await collectRunMetrics(stalledPage as never, {
        runNumber: 1,
        expectedOrg: 'org-1',
        expectedChannel: 'ch-1',
        primaryTimeoutMs: 1000,
        diagnosticTimeoutMs: 40,
      })
      const elapsedMs = Date.now() - startedAt
      expect(elapsedMs).toBeLessThan(1000)
      expect(metrics.fcpMs).toBe(140)
      expect(metrics.timelineVisibleMs).toBe(310)
      expect(metrics.timelinePaintedMs).toBe(325)
      expect(metrics.firstNamedRowMs).toBe(315)
      expect(metrics.directoryStartMs).toBe(330)
      const dirCall = metrics.apiCalls.find((c) => c.path === DIRECTORY_API_PATH)
      expect(dirCall?.completedBeforeTimeline).toBe(false)
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
