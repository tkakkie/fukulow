// Summarize captured first-paint runs for one measurement cell.
import { firstPaintPercentile } from './measure-stats.ts'
import { summarizeCellChannelReads, type CellChannelReadSummary, type ChannelReadSummary } from './read-reasons.ts'

export type ApiTiming = {
  seq: number
  method: string
  path: string
  search?: string
  readId?: string | null
  label: string
  start: number
  headersEnd: number
  end: number
  duration: number
  transferBytes: number
  status: number
  latestEndedBefore: string | null
  startedBeforeTimeline: boolean
  completedBeforeTimeline: boolean
}

export type RunMetrics = {
  run: number
  ttfbMs: number
  htmlEndMs: number
  htmlTransferBytes: number
  fcpMs: number
  blankScreenMs: number
  jsEndMs: number
  cssEndMs: number
  wasmEndMs: number
  assetsEndMs: number
  assetsTransferBytes: number
  appMountMs: number
  wsConnectStartMs: number
  wsOpenMs: number
  wsSubscribeSentMs: number
  wsSubscribedMs: number
  timelineVisibleMs: number
  timelinePaintedMs: number
  firstNamedRowMs: number | null
  directoryStartMs: number | null
  authorLookupStartMs: number | null
  apiCalls: ApiTiming[]
  channelReads: ChannelReadSummary
  timingChain: string[]
}

export type PercentileSummary = { p50: number; p90: number; p95: number; max: number }

export type CellSummary = {
  pathLabel: '/' | '/o/:org/c/:channel'
  path: string
  network: 'unthrottled' | 'throttled'
  cache: 'cold' | 'warm'
  runs: number
  ttfbMs: PercentileSummary
  fcpMs: PercentileSummary
  blankScreenMs: PercentileSummary
  assetsEndMs: PercentileSummary
  jsEndMs: PercentileSummary
  cssEndMs: PercentileSummary
  wasmEndMs: PercentileSummary
  appMountMs: PercentileSummary
  wsSubscribedMs: PercentileSummary
  timelineVisibleMs: PercentileSummary
  firstNamedRowMs: PercentileSummary | null
  directoryStartMs: PercentileSummary | null
  authorLookupStartMs: PercentileSummary | null
  assetsTransferBytes: PercentileSummary
  htmlTransferBytes: PercentileSummary
  apiByLabel: Record<
    string,
    {
      start: PercentileSummary
      end: PercentileSummary
      duration: PercentileSummary
      transferBytes: PercentileSummary
      latestEndedBefore: string | null
      startedBeforeTimelineCount: number
      completedBeforeTimelineCount: number
    }
  >
  channelReads: CellChannelReadSummary
  timingChain: string[]
}

function summarizeNumbers(values: number[]): PercentileSummary {
  return {
    p50: firstPaintPercentile(values, 50),
    p90: firstPaintPercentile(values, 90),
    p95: firstPaintPercentile(values, 95),
    max: firstPaintPercentile(values, 100),
  }
}

function summarizeOptionalNumbers(values: Array<number | null>): PercentileSummary | null {
  const present = values.filter((v): v is number => v !== null)
  return present.length > 0 ? summarizeNumbers(present) : null
}

export function summarizeCell(
  pathLabel: '/' | '/o/:org/c/:channel',
  path: string,
  network: 'unthrottled' | 'throttled',
  cache: 'cold' | 'warm',
  runs: RunMetrics[],
): CellSummary {
  const labels = new Set<string>()
  for (const r of runs) {
    for (const c of r.apiCalls) labels.add(c.label)
  }
  const apiByLabel: CellSummary['apiByLabel'] = {}
  for (const label of labels) {
    const matching = runs.flatMap((r) => r.apiCalls.filter((c) => c.label === label))
    if (matching.length === 0) continue
    apiByLabel[label] = {
      start: summarizeNumbers(matching.map((m) => m.start)),
      end: summarizeNumbers(matching.map((m) => m.end)),
      duration: summarizeNumbers(matching.map((m) => m.duration)),
      transferBytes: summarizeNumbers(matching.map((m) => m.transferBytes)),
      latestEndedBefore: matching[0].latestEndedBefore,
      startedBeforeTimelineCount: matching.filter((m) => m.startedBeforeTimeline).length,
      completedBeforeTimelineCount: matching.filter((m) => m.completedBeforeTimeline).length,
    }
  }
  return {
    pathLabel,
    path,
    network,
    cache,
    runs: runs.length,
    ttfbMs: summarizeNumbers(runs.map((r) => r.ttfbMs)),
    fcpMs: summarizeNumbers(runs.map((r) => r.fcpMs)),
    blankScreenMs: summarizeNumbers(runs.map((r) => r.blankScreenMs)),
    assetsEndMs: summarizeNumbers(runs.map((r) => r.assetsEndMs)),
    jsEndMs: summarizeNumbers(runs.map((r) => r.jsEndMs)),
    cssEndMs: summarizeNumbers(runs.map((r) => r.cssEndMs)),
    wasmEndMs: summarizeNumbers(runs.map((r) => r.wasmEndMs)),
    appMountMs: summarizeNumbers(runs.map((r) => r.appMountMs)),
    wsSubscribedMs: summarizeNumbers(runs.map((r) => r.wsSubscribedMs)),
    timelineVisibleMs: summarizeNumbers(runs.map((r) => r.timelineVisibleMs)),
    firstNamedRowMs: summarizeOptionalNumbers(runs.map((r) => r.firstNamedRowMs)),
    directoryStartMs: summarizeOptionalNumbers(runs.map((r) => r.directoryStartMs)),
    authorLookupStartMs: summarizeOptionalNumbers(runs.map((r) => r.authorLookupStartMs)),
    assetsTransferBytes: summarizeNumbers(runs.map((r) => r.assetsTransferBytes)),
    htmlTransferBytes: summarizeNumbers(runs.map((r) => r.htmlTransferBytes)),
    apiByLabel,
    channelReads: summarizeCellChannelReads(runs),
    timingChain: runs[0]?.timingChain ?? [],
  }
}
