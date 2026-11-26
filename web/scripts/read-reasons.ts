/** Pure pairing and classification of startup Channel list reads for #983 Target 1. */

export const CHANNELS_API_PATH = '/api/v1/orgs/{org}/channels'
export const CHANNEL_READ_ID_HEADER = 'x-fukulow-read-id'
export const CHANNEL_READ_MARK_NAME = 'fukulow:read:channels'

export type ReadReason = 'initial' | 'notice' | 'access' | 'reconcile' | 'periodic'
export type ChannelReadClass = 'O5-only' | 'startup' | 'composite' | 'empty' | 'unknown'
export type ChannelReadMeasurementStatus = 'valid' | 'invalid'
export type InvalidRunReason =
  | 'marks_unavailable'
  | 'missing_or_malformed_request_id'
  | 'unmatched_request'
  | 'malformed_mark_reasons'
  | 'duplicate_request_id'
  | 'duplicate_mark_id'
  | 'unmatched_mark'

export type CapturedChannelRequest = {
  seq: number
  method: string
  path: string
  search?: string
  readId?: string | null
}

export type CapturedReadMark = {
  id: unknown
  reasons: unknown
}

export type ClassifiedChannelRead = {
  seq: number
  readId: string | null
  reasons: ReadReason[] | null
  classification: ChannelReadClass
  counted: boolean
}

export type ChannelReadSummary = {
  valid: boolean
  status: ChannelReadMeasurementStatus
  invalidReasons: InvalidRunReason[]
  reads: ClassifiedChannelRead[]
  countsByClass: Record<ChannelReadClass, number>
  countedReads: number
}

export type CellChannelReadSummary = {
  valid: boolean
  status: ChannelReadMeasurementStatus
  validRuns: number
  invalidRuns: number
  invalidRunReasons: Array<{ run: number; reasons: InvalidRunReason[]; countedReads: number }>
  countsByClass: Record<ChannelReadClass, number>
  maxCountedReadsPerRun: number | null
}

export type ReportChannelReadSummary = {
  valid: boolean
  status: ChannelReadMeasurementStatus
  validCells: number
  invalidCells: Array<{
    cell: string
    invalidRuns: number
    invalidRunReasons: CellChannelReadSummary['invalidRunReasons']
  }>
  countsByClass: Record<ChannelReadClass, number>
}

const VALID_REASONS = new Set<string>(['initial', 'notice', 'access', 'reconcile', 'periodic'])
const READ_ID_PATTERN = /^[A-Za-z0-9._-]+$/

export function isChannelListRequest(req: Pick<CapturedChannelRequest, 'method' | 'path'>): boolean {
  return req.method.toUpperCase() === 'GET' && req.path === CHANNELS_API_PATH
}

export function parseReadId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || !READ_ID_PATTERN.test(trimmed)) return null
  return trimmed
}

export function parseReasons(raw: unknown): ReadReason[] | null {
  if (!Array.isArray(raw)) return null
  const unique = new Set<ReadReason>()
  for (const item of raw) {
    if (typeof item !== 'string' || !VALID_REASONS.has(item)) return null
    unique.add(item as ReadReason)
  }
  return [...unique]
}

export function classifyReasons(reasons: readonly ReadReason[]): ChannelReadClass {
  if (reasons.length === 0) return 'empty'
  const hasPeriodic = reasons.includes('periodic')
  if (hasPeriodic && reasons.length === 1) return 'O5-only'
  if (hasPeriodic) return 'composite'
  return 'startup'
}

export function isCountedClass(classification: ChannelReadClass): boolean {
  return classification !== 'O5-only'
}

function emptyCounts(): Record<ChannelReadClass, number> {
  return { 'O5-only': 0, startup: 0, composite: 0, empty: 0, unknown: 0 }
}

/** Pairs each Channel list request one-to-one with its performance mark by read id. */
export function classifyChannelReads(
  requests: readonly CapturedChannelRequest[],
  marks: readonly CapturedReadMark[] | null,
): ChannelReadSummary {
  const channelRequests = requests.filter(isChannelListRequest)
  const invalidReasons = new Set<InvalidRunReason>()
  const countsByClass = emptyCounts()

  if (marks === null) {
    invalidReasons.add('marks_unavailable')
    const reads: ClassifiedChannelRead[] = channelRequests.map((req) => {
      countsByClass.unknown++
      return {
        seq: req.seq,
        readId: parseReadId(req.readId),
        reasons: null,
        classification: 'unknown',
        counted: isCountedClass('unknown'),
      }
    })
    return {
      valid: false,
      status: 'invalid',
      invalidReasons: [...invalidReasons],
      reads,
      countsByClass,
      countedReads: reads.filter((r) => r.counted).length,
    }
  }

  const marksById = new Map<string, ReadReason[] | null>()
  const duplicateMarkIds = new Set<string>()
  for (const mark of marks) {
    const id = parseReadId(mark.id)
    if (id === null) {
      invalidReasons.add('unmatched_mark')
      continue
    }
    if (marksById.has(id)) {
      invalidReasons.add('duplicate_mark_id')
      duplicateMarkIds.add(id)
      continue
    }
    const parsedReasons = parseReasons(mark.reasons)
    if (parsedReasons === null) invalidReasons.add('malformed_mark_reasons')
    marksById.set(id, parsedReasons)
  }

  const requestIdCounts = new Map<string, number>()
  for (const req of channelRequests) {
    const id = parseReadId(req.readId)
    if (id === null) {
      invalidReasons.add('missing_or_malformed_request_id')
      continue
    }
    const next = (requestIdCounts.get(id) ?? 0) + 1
    requestIdCounts.set(id, next)
    if (next > 1) invalidReasons.add('duplicate_request_id')
  }

  for (const markId of marksById.keys()) {
    if (!requestIdCounts.has(markId)) invalidReasons.add('unmatched_mark')
  }

  for (const reqId of requestIdCounts.keys()) {
    if (!marksById.has(reqId)) invalidReasons.add('unmatched_request')
  }

  const reads: ClassifiedChannelRead[] = channelRequests.map((req) => {
    const id = parseReadId(req.readId)
    let reasons: ReadReason[] | null = null
    let classification: ChannelReadClass = 'unknown'

    if (
      id !== null &&
      marksById.has(id) &&
      !duplicateMarkIds.has(id) &&
      (requestIdCounts.get(id) ?? 0) === 1
    ) {
      const parsed = marksById.get(id) ?? null
      if (parsed !== null) {
        reasons = parsed
        classification = classifyReasons(parsed)
      }
    }

    countsByClass[classification]++
    return {
      seq: req.seq,
      readId: id,
      reasons,
      classification,
      counted: isCountedClass(classification),
    }
  })

  const valid = invalidReasons.size === 0
  return {
    valid,
    status: valid ? 'valid' : 'invalid',
    invalidReasons: [...invalidReasons],
    reads,
    countsByClass,
    countedReads: reads.filter((r) => r.counted).length,
  }
}

export function summarizeCellChannelReads(
  runs: ReadonlyArray<{ run: number; channelReads: ChannelReadSummary }>,
): CellChannelReadSummary {
  const countsByClass = emptyCounts()
  const invalidRunReasons: CellChannelReadSummary['invalidRunReasons'] = []
  let validRuns = 0
  let maxCountedReadsPerRun: number | null = null

  for (const r of runs) {
    for (const key of Object.keys(countsByClass) as ChannelReadClass[]) {
      countsByClass[key] += r.channelReads.countsByClass[key]
    }
    maxCountedReadsPerRun =
      maxCountedReadsPerRun === null
        ? r.channelReads.countedReads
        : Math.max(maxCountedReadsPerRun, r.channelReads.countedReads)
    if (r.channelReads.valid) {
      validRuns++
    } else {
      invalidRunReasons.push({
        run: r.run,
        reasons: r.channelReads.invalidReasons,
        countedReads: r.channelReads.countedReads,
      })
    }
  }

  const valid = invalidRunReasons.length === 0
  return {
    valid,
    status: valid ? 'valid' : 'invalid',
    validRuns,
    invalidRuns: invalidRunReasons.length,
    invalidRunReasons,
    countsByClass,
    maxCountedReadsPerRun,
  }
}

export function summarizeReportChannelReads(
  cells: ReadonlyArray<{ cell: string; channelReads: CellChannelReadSummary }>,
): ReportChannelReadSummary {
  const countsByClass = emptyCounts()
  const invalidCells: ReportChannelReadSummary['invalidCells'] = []
  let validCells = 0

  for (const c of cells) {
    for (const key of Object.keys(countsByClass) as ChannelReadClass[]) {
      countsByClass[key] += c.channelReads.countsByClass[key]
    }
    if (c.channelReads.valid) {
      validCells++
    } else {
      invalidCells.push({
        cell: c.cell,
        invalidRuns: c.channelReads.invalidRuns,
        invalidRunReasons: c.channelReads.invalidRunReasons,
      })
    }
  }

  const valid = invalidCells.length === 0
  return {
    valid,
    status: valid ? 'valid' : 'invalid',
    validCells,
    invalidCells,
    countsByClass,
  }
}
