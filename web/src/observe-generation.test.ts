import { describe, expect, it, vi } from 'vitest'
import type { ReadPosition, Result } from './api'
import { observeGeneration } from './observe-generation'

const generation = '00000000-0000-4000-8000-000000000515'
const success: Result<ReadPosition> = { ok: true, data: { history_generation: generation, read_seq: 1 } }

describe('observeGeneration', () => {
  it.each([
    { accepts: true, expected: 'accepted' },
    { accepts: false, expected: 'stale' },
  ])('returns $expected for a success when sync accepts it = $accepts', ({ accepts, expected }) => {
    const sync = { observeHistoryGeneration: vi.fn(() => accepts) }
    expect(observeGeneration(sync, success)).toBe(expected)
    expect(sync.observeHistoryGeneration.mock.calls).toEqual([[generation]])
  })

  it('observes a generation conflict with zero arguments and treats it as stale', () => {
    const sync = { observeHistoryGeneration: vi.fn(() => true) }
    const result: Result<unknown> = { ok: false, kind: 'http', status: 409, error: 'history_generation_changed' }
    expect(observeGeneration(sync, result)).toBe('stale')
    expect(sync.observeHistoryGeneration.mock.calls).toEqual([[]])
  })

  it.each<Result<unknown>>([
    { ok: false, kind: 'http', status: 409, error: 'snapshot_expired' },
    { ok: false, kind: 'http', status: 404, error: 'history_generation_changed' },
    { ok: false, kind: 'network', error: 'history_generation_changed' },
  ])('ignores unrelated error %j', result => {
    const sync = { observeHistoryGeneration: vi.fn() }
    expect(observeGeneration(sync, result)).toBe('not-a-generation-result')
    expect(sync.observeHistoryGeneration).not.toHaveBeenCalled()
  })

  it.each([
    { read_seq: 1 },
    { history_generation: null },
    null,
  ])('skips a success without a string generation in %j', data => {
    const sync = { observeHistoryGeneration: vi.fn() }
    expect(observeGeneration(sync, { ok: true, data })).toBe('not-a-generation-result')
    expect(sync.observeHistoryGeneration).not.toHaveBeenCalled()
  })

  it('forwards an explicit undefined argument when the reader requests it', () => {
    const sync = { observeHistoryGeneration: vi.fn(() => false) }
    expect(observeGeneration(sync, { ok: true, data: {} }, () => ({ generation: undefined }))).toBe('stale')
    expect(sync.observeHistoryGeneration.mock.calls).toEqual([[undefined]])
  })
})
