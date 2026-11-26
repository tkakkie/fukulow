/** Pure pairing and classification of startup Channel list reads for #983 Target 1. */

export const CHANNELS_API_PATH = '/api/v1/orgs/{org}/channels'
export const CHANNEL_READ_ID_HEADER = 'x-fukulow-read-id'
export const CHANNEL_READ_MARK_NAME = 'fukulow:read:channels'

export type ReadReason = 'initial' | 'notice' | 'access' | 'reconcile' | 'periodic'
export type ChannelReadClass = 'O5-only' | 'startup' | 'composite' | 'empty' | 'unknown'
export type InvalidRunReason =
  | 'marks_unavailable'
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
  invalidReasons: InvalidRunReason[]
  reads: ClassifiedChannelRead[]
  countsByClass: Record<ChannelReadClass, number>
  countedReads: number
}

export type CellChannelReadSummary = {
  validRuns: number
  invalidRuns: number
  invalidRunReasons: Array<{ run: number; reasons: InvalidRunReason[] }>
  countsByClass: Record<ChannelReadClass, number>
  maxCountedReadsPerValidRun: number | null
}

const VALID_REASONS = new Set<string>(['initial', 'notice', 'access', 'reconcile', 'periodic'])
const READ_ID_PATTERN = /^[A-Za-z0-9._-]+$/

export function isStartupChannelListRequest(req: Pick<CapturedChannelRequest, 'method' | 'path' | 'search'>): boolean {
  if (req.method.toUpperCase() !== 'GET' || req.path !== CHANNELS_API_PATH) return false
  const params = new URLSearchParams(req.search ?? '')
  return params.get('archived') !== 'true'
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

/** Pairs each startup Channel list request one-to-one with its performance mark by read id. */
export function classifyChannelReads(
  requests: readonly CapturedChannelRequest[],
  marks: readonly CapturedReadMark[] | null,
): ChannelReadSummary {
  const channelRequests = requests.filter(isStartupChannelListRequest)
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
    marksById.set(id, parseReasons(mark.reasons))
  }

  const requestIdCounts = new Map<string, number>()
  for (const req of channelRequests) {
    const id = parseReadId(req.readId)
    if (id === null) continue
    const next = (requestIdCounts.get(id) ?? 0) + 1
    requestIdCounts.set(id, next)
    if (next > 1) invalidReasons.add('duplicate_request_id')
  }

  for (const markId of marksById.keys()) {
    if (!requestIdCounts.has(markId)) invalidReasons.add('unmatched_mark')
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

  return {
    valid: invalidReasons.size === 0,
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
  const invalidRunReasons: Array<{ run: number; reasons: InvalidRunReason[] }> = []
  let validRuns = 0
  let maxCountedReadsPerValidRun: number | null = null

  for (const r of runs) {
    for (const key of Object.keys(countsByClass) as ChannelReadClass[]) {
      countsByClass[key] += r.channelReads.countsByClass[key]
    }
    if (r.channelReads.valid) {
      validRuns++
      maxCountedReadsPerValidRun =
        maxCountedReadsPerValidRun === null
          ? r.channelReads.countedReads
          : Math.max(maxCountedReadsPerValidRun, r.channelReads.countedReads)
    } else {
      invalidRunReasons.push({ run: r.run, reasons: r.channelReads.invalidReasons })
    }
  }

  return {
    validRuns,
    invalidRuns: invalidRunReasons.length,
    invalidRunReasons,
    countsByClass,
    maxCountedReadsPerValidRun,
  }
}
