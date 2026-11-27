import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultRetryDelayMs, discordAttempts, discordOutcome, maxRetryDelayMs, retryAfterDelayMs } from './backup-discord-retry.ts'

const fixedNow = Date.parse('2026-11-28T00:00:00Z')
const noClock = () => { throw new Error('clock read for a delta-seconds value') }

test('Discord status outcome: 2xx delivers, 4xx except 429 rejects, 1xx/3xx is a response error, others retry', () => {
  for (const status of [200, 204, 299]) assert.equal(discordOutcome(status), 'delivered')
  for (const status of [400, 401, 404, 413, 499]) assert.equal(discordOutcome(status), 'rejected')
  for (const status of [100, 199, 300, 301, 399]) assert.equal(discordOutcome(status), 'response')
  for (const status of [0, 429, 500, 503, 599, 600, Number.NaN]) assert.equal(discordOutcome(status), 'retry')
  assert.equal(discordAttempts, 3)
})

test('Retry-After delta-seconds converts to ms, allows fractions and caps at 30 s without reading the clock', () => {
  assert.equal(retryAfterDelayMs('0', noClock), 0)
  assert.equal(retryAfterDelayMs('2', noClock), 2000)
  assert.equal(retryAfterDelayMs('1.5', noClock), 1500)
  assert.equal(retryAfterDelayMs('30', noClock), maxRetryDelayMs)
  assert.equal(retryAfterDelayMs('9999', noClock), maxRetryDelayMs)
  assert.equal(maxRetryDelayMs, 30_000)
})

test('Retry-After HTTP-date is relative to now, clamped to 0..30 s', () => {
  const now = () => fixedNow
  assert.equal(retryAfterDelayMs('Sat, 28 Nov 2026 00:00:05 GMT', now), 5000)
  assert.equal(retryAfterDelayMs('Sat, 28 Nov 2026 01:00:00 GMT', now), maxRetryDelayMs)
  assert.equal(retryAfterDelayMs('Fri, 27 Nov 2026 23:59:00 GMT', now), 0)
})

test('Retry-After missing, empty or unparsable keeps the 1 s default', () => {
  const now = () => fixedNow
  assert.equal(defaultRetryDelayMs, 1000)
  for (const value of [undefined, null, '', 'soon', '1e3', 'Infinity']) {
    assert.equal(retryAfterDelayMs(value, now), defaultRetryDelayMs, String(value))
  }
})

test('Retry-After that is not delta-seconds falls back to Date.parse, so a past date (or negative value) clamps to 0', () => {
  const now = () => fixedNow
  // Not delta-seconds; the engine's lenient Date.parse may read these as past dates (V8 does).
  for (const value of ['-5', '.5', '1.', ' 2']) {
    assert.equal(retryAfterDelayMs(value, now), Number.isFinite(Date.parse(value)) ? 0 : defaultRetryDelayMs, value)
  }
})
