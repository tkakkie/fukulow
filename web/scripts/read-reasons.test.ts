import { describe, expect, it } from 'vitest'
import {
  CHANNELS_API_PATH,
  classifyChannelReads,
  classifyReasons,
  isCountedClass,
  isStartupChannelListRequest,
  parseReadId,
  summarizeCellChannelReads,
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

  it('counts unknown reads (no header, unparsable header, or no mark for the id)', () => {
    const result = classifyChannelReads(
      [
        req(1, null),
        req(2, '   '),
        req(3, 'bad header!'),
        req(4, 'ch-missing'),
      ],
      [],
    )
    expect(result.valid).toBe(true)
    expect(result.reads.map((r) => r.classification)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    expect(result.reads.every((r) => r.counted)).toBe(true)
    expect(result.countsByClass).toEqual({ 'O5-only': 0, startup: 0, composite: 0, empty: 0, unknown: 4 })
    expect(result.countedReads).toBe(4)
  })

  it('pairs strictly one-to-one by id regardless of order and excludes ?archived=true and non-channel paths', () => {
    const result = classifyChannelReads(
      [
        req(1, 'ch-2', '?history_generation=g1'),
        req(2, null, '?archived=true'),
        { seq: 3, method: 'POST', path: CHANNELS_API_PATH, readId: null },
        { seq: 4, method: 'GET', path: '/api/v1/orgs/{org}/members', readId: null },
        req(5, 'ch-1'),
        req(6, 'ch-3'),
      ],
      [
        mark('ch-1', ['initial']),
        mark('ch-3', ['periodic']),
        mark('ch-2', ['reconcile']),
      ],
    )
    expect(result.valid).toBe(true)
    expect(result.reads).toEqual([
      { seq: 1, readId: 'ch-2', reasons: ['reconcile'], classification: 'startup', counted: true },
      { seq: 5, readId: 'ch-1', reasons: ['initial'], classification: 'startup', counted: true },
      { seq: 6, readId: 'ch-3', reasons: ['periodic'], classification: 'O5-only', counted: false },
    ])
    expect(result.countedReads).toBe(2)
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

  it('summarizes cell channel reads and reports invalid runs separately', () => {
    const run1 = classifyChannelReads(
      [req(1, 'ch-1'), req(2, 'ch-2'), req(3, 'ch-3')],
      [mark('ch-1', ['initial']), mark('ch-2', ['reconcile']), mark('ch-3', ['periodic'])],
    )
    const run2 = classifyChannelReads([req(1, 'ch-4')], null)
    const summary = summarizeCellChannelReads([
      { run: 1, channelReads: run1 },
      { run: 2, channelReads: run2 },
    ])
    expect(summary).toEqual({
      validRuns: 1,
      invalidRuns: 1,
      invalidRunReasons: [{ run: 2, reasons: ['marks_unavailable'] }],
      countsByClass: { 'O5-only': 1, startup: 2, composite: 0, empty: 0, unknown: 1 },
      maxCountedReadsPerValidRun: 2,
    })
  })

  it('exposes exact helpers for request filtering, id parsing, and class counting', () => {
    expect(isStartupChannelListRequest({ method: 'GET', path: CHANNELS_API_PATH, search: '' })).toBe(true)
    expect(isStartupChannelListRequest({ method: 'GET', path: CHANNELS_API_PATH, search: '?archived=true' })).toBe(false)
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
