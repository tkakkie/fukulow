import { expect, it } from 'vitest'
import { summarizeCell, type ApiTiming, type RunMetrics } from './first-paint-summary.ts'
import { classifyChannelReads } from './read-reasons.ts'

const call: ApiTiming = {
  seq: 1, method: 'GET', path: '/timeline', label: 'timeline',
  start: 12.125, headersEnd: 15, end: 16.125, duration: 4, transferBytes: 512, status: 200,
  latestEndedBefore: 'channels', startedBeforeTimeline: true, completedBeforeTimeline: true,
}
const base: RunMetrics = {
  run: 1, ttfbMs: 10, htmlEndMs: 20, htmlTransferBytes: 1000,
  fcpMs: 140.125, blankScreenMs: 140, jsEndMs: 100, cssEndMs: 80, wasmEndMs: 110,
  assetsEndMs: 110, assetsTransferBytes: 50_000, appMountMs: 150,
  wsConnectStartMs: 160, wsOpenMs: 180, wsSubscribeSentMs: 185, wsSubscribedMs: 210,
  timelineVisibleMs: 310, timelinePaintedMs: 325, firstNamedRowMs: null,
  directoryStartMs: null, authorLookupStartMs: 190, apiCalls: [call],
  channelReads: classifyChannelReads([], []), timingChain: ['channels', 'timeline'],
}

it('summarizes fixed runs in input order with optional diagnostics and per-label timings', () => {
  const summary = summarizeCell('/', '/', 'throttled', 'cold', [base, {
    ...base, run: 2, fcpMs: 120.125, firstNamedRowMs: 321.125, authorLookupStartMs: null,
    apiCalls: [{ ...call, start: 14.125, end: 20.125, duration: 6, transferBytes: 1024,
      latestEndedBefore: null, completedBeforeTimeline: false }],
    timingChain: ['timeline'],
  }])
  expect(summary.fcpMs).toEqual({ p50: 120.13, p90: 140.13, p95: 140.13, max: 140.13 })
  expect(summary.firstNamedRowMs).toEqual({ p50: 321.13, p90: 321.13, p95: 321.13, max: 321.13 })
  expect(summary.directoryStartMs).toBeNull()
  expect(summary.apiByLabel).toEqual({
    timeline: {
      start: { p50: 12.13, p90: 14.13, p95: 14.13, max: 14.13 },
      end: { p50: 16.13, p90: 20.13, p95: 20.13, max: 20.13 },
      duration: { p50: 4, p90: 6, p95: 6, max: 6 },
      transferBytes: { p50: 512, p90: 1024, p95: 1024, max: 1024 },
      latestEndedBefore: 'channels', startedBeforeTimelineCount: 2, completedBeforeTimelineCount: 1,
    },
  })
  expect(summary.channelReads.validRuns).toBe(2)
  expect(summary.timingChain).toEqual(['channels', 'timeline'])
})

it('rejects a cell with no captured runs', () => {
  expect(() => summarizeCell('/', '/', 'unthrottled', 'cold', [])).toThrow(TypeError)
})
