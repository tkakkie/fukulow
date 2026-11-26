import { describe, expect, it } from 'vitest'
import {
  CHANNELS_API_PATH,
  classifyChannelReads,
  classifyReasons,
  isChannelListRequest,
  isCountedClass,
  parseReadId,
  summarizeCellChannelReads,
  summarizeReportChannelReads,
  type CapturedChannelRequest,
  type CapturedReadMark,
} from './read-reasons.ts'

const req = (seq: number, readId: string | null | undefined, search = ''): CapturedChannelRequest => ({
  seq,
  method: 'GET',
  path: CHANNELS_API_PATH,
  search,
  readId,
})

const mark = (id: unknown, reasons: unknown): CapturedReadMark => ({ id, reasons })

describe('read-reasons classification (#983)', () => {
  it('excludes O5-only reads ({periodic}) from Target 1 counted reads', () => {
    const result = classifyChannelReads([req(1, 'ch-1')], [mark('ch-1', ['periodic'])])
    expect(result.valid).toBe(true)
    expect(result.status).toBe('valid')
    expect(result.invalidReasons).toEqual([])
    expect(result.reads).toEqual([
      { seq: 1, readId: 'ch-1', reasons: ['periodic'], classification: 'O5-only', counted: false },
    ])
    expect(result.countsByClass).toEqual({ 'O5-only': 1, startup: 0, composite: 0, empty: 0, unknown: 0 })
    expect(result.countedReads).toBe(0)
  })

  it('counts startup reads (non-empty reasons without periodic)', () => {
    const result = classifyChannelReads(
      [req(1, 'ch-1'), req(2, 'ch-2'), req(3, 'ch-3')],
      [
        mark('ch-1', ['initial']),
        mark('ch-2', ['reconcile']),
        mark('ch-3', ['notice', 'access']),
      ],
    )
    expect(result.valid).toBe(true)
    expect(result.reads.map((r) => r.classification)).toEqual(['startup', 'startup', 'startup'])
    expect(result.reads.every((r) => r.counted)).toBe(true)
    expect(result.countsByClass).toEqual({ 'O5-only': 0, startup: 3, composite: 0, empty: 0, unknown: 0 })
    expect(result.countedReads).toBe(3)
  })

  it('counts composite reads (periodic plus any other reason)', () => {
    const result = classifyChannelReads(
      [req(1, 'ch-1'), req(2, 'ch-2')],
      [
        mark('ch-1', ['periodic', 'reconcile']),
        mark('ch-2', ['notice', 'periodic']),
      ],
    )
    expect(result.valid).toBe(true)
    expect(result.reads.map((r) => r.classification)).toEqual(['composite', 'composite'])
    expect(result.reads.every((r) => r.counted)).toBe(true)
    expect(result.countsByClass).toEqual({ 'O5-only': 0, startup: 0, composite: 2, empty: 0, unknown: 0 })
    expect(result.countedReads).toBe(2)
  })

  it('counts empty reads (paired with empty reason set)', () => {
    const result = classifyChannelReads([req(1, 'ch-1')], [mark('ch-1', [])])
    expect(result.valid).toBe(true)
    expect(result.reads).toEqual([
      { seq: 1, readId: 'ch-1', reasons: [], classification: 'empty', counted: true },
    ])
    expect(result.countsByClass).toEqual({ 'O5-only': 0, startup: 0, composite: 0, empty: 1, unknown: 0 })
    expect(result.countedReads).toBe(1)
  })

  it('counts unknown reads AND marks the run invalid on missing/malformed headers or missing marks', () => {
    const result = classifyChannelReads(
      [
        req(1, null),
        req(2, '   '),
        req(3, 'bad header!'),
        req(4, 'ch-missing'),
      ],
      [],
    )
    expect(result.valid).toBe(false)
    expect(result.status).toBe('invalid')
    expect(new Set(result.invalidReasons)).toEqual(new Set(['missing_or_malformed_request_id', 'unmatched_request']))
    expect(result.reads.map((r) => r.classification)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    expect(result.reads.every((r) => r.counted)).toBe(true)
    expect(result.countsByClass).toEqual({ 'O5-only': 0, startup: 0, composite: 0, empty: 0, unknown: 4 })
    expect(result.countedReads).toBe(4)

    const missingIdOnly = classifyChannelReads([req(1, null)], [])
    expect(missingIdOnly.valid).toBe(false)
    expect(missingIdOnly.invalidReasons).toEqual(['missing_or_malformed_request_id'])
    expect(missingIdOnly.countedReads).toBe(1)

    const unmatchedReqOnly = classifyChannelReads([req(1, 'ch-missing')], [])
    expect(unmatchedReqOnly.valid).toBe(false)
    expect(unmatchedReqOnly.invalidReasons).toEqual(['unmatched_request'])
    expect(unmatchedReqOnly.countedReads).toBe(1)

    const malformedReasons = classifyChannelReads([req(1, 'ch-bad')], [mark('ch-bad', ['bogus'])])
    expect(malformedReasons.valid).toBe(false)
    expect(malformedReasons.invalidReasons).toEqual(['malformed_mark_reasons'])
    expect(malformedReasons.reads[0]?.classification).toBe('unknown')
    expect(malformedReasons.countedReads).toBe(1)
  })

  it('pairs strictly one-to-one by id regardless of order and classifies ?archived=true while ignoring non-channel paths', () => {
    const result = classifyChannelReads(
      [
        req(1, 'ch-2', '?history_generation=g1'),
        req(2, 'ch-archived', '?archived=true'),
        { seq: 3, method: 'POST', path: CHANNELS_API_PATH, readId: null },
        { seq: 4, method: 'GET', path: '/api/v1/orgs/{org}/members', readId: null },
        req(5, 'ch-1'),
        req(6, 'ch-3'),
      ],
      [
        mark('ch-1', ['initial']),
        mark('ch-3', ['periodic']),
        mark('ch-2', ['reconcile']),
        mark('ch-archived', ['reconcile']),
      ],
    )
    expect(result.valid).toBe(true)
    expect(result.reads).toEqual([
      { seq: 1, readId: 'ch-2', reasons: ['reconcile'], classification: 'startup', counted: true },
      { seq: 2, readId: 'ch-archived', reasons: ['reconcile'], classification: 'startup', counted: true },
      { seq: 5, readId: 'ch-1', reasons: ['initial'], classification: 'startup', counted: true },
      { seq: 6, readId: 'ch-3', reasons: ['periodic'], classification: 'O5-only', counted: false },
    ])
    expect(result.countedReads).toBe(3)
  })

  it('marks a run invalid when a mark id matches no request', () => {
    const result = classifyChannelReads(
      [req(1, 'ch-1')],
      [mark('ch-1', ['initial']), mark('ch-orphan', ['periodic'])],
    )
    expect(result.valid).toBe(false)
    expect(result.invalidReasons).toEqual(['unmatched_mark'])
    expect(result.countedReads).toBe(1)
  })

  it('marks a run invalid when a read id is duplicated among requests', () => {
    const result = classifyChannelReads(
      [req(1, 'ch-1'), req(2, 'ch-1')],
      [mark('ch-1', ['periodic'])],
    )
    expect(result.valid).toBe(false)
    expect(result.invalidReasons).toEqual(['duplicate_request_id'])
    // Duplicated request ids cannot be paired one-to-one and are counted as unknown.
    expect(result.reads.map((r) => r.classification)).toEqual(['unknown', 'unknown'])
    expect(result.countedReads).toBe(2)
  })

  it('marks a run invalid when a read id is duplicated among marks', () => {
    const result = classifyChannelReads(
      [req(1, 'ch-1')],
      [mark('ch-1', ['periodic']), mark('ch-1', ['initial'])],
    )
    expect(result.valid).toBe(false)
    expect(result.invalidReasons).toEqual(['duplicate_mark_id'])
    expect(result.reads.map((r) => r.classification)).toEqual(['unknown'])
    expect(result.countedReads).toBe(1)
  })

  it('marks a run invalid when marks could not be collected', () => {
    const result = classifyChannelReads([req(1, 'ch-1'), req(2, 'ch-2')], null)
    expect(result.valid).toBe(false)
    expect(result.invalidReasons).toEqual(['marks_unavailable'])
    expect(result.reads.map((r) => r.classification)).toEqual(['unknown', 'unknown'])
    expect(result.countedReads).toBe(2)
  })

  it('marks cell and report invalid when any run is invalid and still reports a 3-counted-read invalid run', () => {
    const run1 = classifyChannelReads(
      [req(1, 'ch-1'), req(2, 'ch-2'), req(3, 'ch-3')],
      [mark('ch-1', ['initial']), mark('ch-2', ['reconcile']), mark('ch-3', ['periodic'])],
    )
    const run2 = classifyChannelReads(
      [req(1, 'ch-4'), req(2, 'ch-5'), req(3, 'ch-unpaired')],
      [mark('ch-4', ['initial']), mark('ch-5', ['reconcile'])],
    )
    expect(run1.status).toBe('valid')
    expect(run1.countedReads).toBe(2)
    expect(run2.valid).toBe(false)
    expect(run2.status).toBe('invalid')
    expect(run2.countedReads).toBe(3)

    const cellSummary = summarizeCellChannelReads([
      { run: 1, channelReads: run1 },
      { run: 2, channelReads: run2 },
    ])
    expect(cellSummary).toEqual({
      valid: false,
      status: 'invalid',
      validRuns: 1,
      invalidRuns: 1,
      invalidRunReasons: [{ run: 2, reasons: ['unmatched_request'], countedReads: 3 }],
      countsByClass: { 'O5-only': 1, startup: 4, composite: 0, empty: 0, unknown: 1 },
      maxCountedReadsPerRun: 3,
    })

    const validCell = summarizeCellChannelReads([{ run: 1, channelReads: run1 }])
    expect(validCell.valid).toBe(true)
    expect(validCell.status).toBe('valid')
    expect(validCell.maxCountedReadsPerRun).toBe(2)

    const reportSummary = summarizeReportChannelReads([
      { cell: '/|unthrottled|cold', channelReads: validCell },
      { cell: '/|throttled|cold', channelReads: cellSummary },
    ])
    expect(reportSummary).toEqual({
      valid: false,
      status: 'invalid',
      validCells: 1,
      invalidCells: [
        {
          cell: '/|throttled|cold',
          invalidRuns: 1,
          invalidRunReasons: [{ run: 2, reasons: ['unmatched_request'], countedReads: 3 }],
        },
      ],
      countsByClass: { 'O5-only': 2, startup: 6, composite: 0, empty: 0, unknown: 1 },
    })
  })

  it('exposes exact helpers for request matching, id parsing, and class counting', () => {
    expect(isChannelListRequest({ method: 'GET', path: CHANNELS_API_PATH })).toBe(true)
    expect(isChannelListRequest({ method: 'POST', path: CHANNELS_API_PATH })).toBe(false)
    expect(isChannelListRequest({ method: 'GET', path: '/api/v1/orgs/{org}/members' })).toBe(false)
    expect(parseReadId('ch-42')).toBe('ch-42')
    expect(parseReadId('')).toBeNull()
    expect(parseReadId('has space')).toBeNull()
    expect(classifyReasons(['periodic'])).toBe('O5-only')
    expect(classifyReasons(['initial'])).toBe('startup')
    expect(classifyReasons(['periodic', 'notice'])).toBe('composite')
    expect(classifyReasons([])).toBe('empty')
    expect(isCountedClass('O5-only')).toBe(false)
    expect(isCountedClass('startup')).toBe(true)
    expect(isCountedClass('composite')).toBe(true)
    expect(isCountedClass('empty')).toBe(true)
    expect(isCountedClass('unknown')).toBe(true)
  })
})
