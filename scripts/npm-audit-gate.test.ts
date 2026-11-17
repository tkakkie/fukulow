import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluate, exceptions, parseAudit } from './npm-audit-gate.ts'

const today = '2026-11-18'
const id = exceptions[0].id
const advisory = (name = 'picomatch', ghsa = id, severity = 'high') => ({
  name, severity, url: `https://github.com/advisories/${ghsa}`,
})
const report = (via: unknown[] = [advisory()], fixAvailable: unknown = false) => ({
  vulnerabilities: { picomatch: { via, fixAvailable } },
})
const check = (audit: unknown) => evaluate([audit], exceptions, today)

test('the scoped exception covers the advisory and logs its package, id, severity and expiry', () => {
  const result = check(report())
  assert.equal(result.ok, true)
  assert.match(result.findings[0], /picomatch GHSA-fc5q-39xc-vjpf high.*#565.*2026-12-18/)
})

test('another high advisory fails, including a different package with the same id', () => {
  for (const other of [advisory('other'), advisory('picomatch', 'GHSA-aaaa-bbbb-cccc')]) {
    const result = check(report([advisory(), other]))
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /Unexcepted high advisory/)
  }
})

test('critical fails while moderate, low and info do not fail the severity gate', () => {
  for (const severity of ['critical', 'moderate', 'low', 'info']) {
    const result = check(report([advisory(), advisory('other', 'GHSA-aaaa-bbbb-cccc', severity)]))
    assert.equal(result.ok, severity !== 'critical')
  }
})

test('expiry is inclusive of the UTC expiry date; the next day requires a new decision', () => {
  assert.equal(evaluate([report()], exceptions, '2026-12-18').ok, true)
  const result = evaluate([report()], exceptions, '2026-12-19')
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /GHSA-fc5q-39xc-vjpf.*expired.*re-decide in #565/)
})

test('non-major fixes require updating and removing the exception; major-only fixes do not', () => {
  for (const fix of [true, { name: 'picomatch', version: '4.0.8', isSemVerMajor: false }]) {
    const result = check(report(undefined, fix))
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /update and remove the exception/)
  }
  assert.equal(check(report(undefined, { name: 'vitest', version: '3.1.4', isSemVerMajor: true })).ok, true)
})

test('a fix on a transitive parent does not trigger removal for the excepted package', () => {
  const audit = { vulnerabilities: {
    ...report().vulnerabilities,
    vite: { via: ['picomatch'], fixAvailable: true },
  } }
  assert.equal(check(audit).ok, true)
})

test('staleness uses the union of prefixes, independently of their order', () => {
  const empty = { vulnerabilities: {} }
  assert.equal(evaluate([report(), empty], exceptions, today).ok, true)
  assert.equal(evaluate([empty, report()], exceptions, today).ok, true)
  const result = evaluate([empty, empty], exceptions, today)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /remove the stale exception/)
  assert.equal(evaluate([], exceptions, today).ok, false)
})

test('malformed JSON and missing or malformed vulnerabilities fail closed', () => {
  for (const json of ['', 'not JSON', '{']) {
    assert.throws(() => parseAudit(json), /no parsable JSON/)
  }
  for (const audit of [null, {}, { vulnerabilities: null }, { vulnerabilities: [] },
    { vulnerabilities: {}, error: { code: 'EAUDIT' } },
    { vulnerabilities: { other: {} } }, report([null]), report([{ name: 'other' }])]) {
    const result = evaluate([report(), audit], exceptions, today)
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /Invalid npm audit/)
  }
  assert.equal(check(parseAudit(JSON.stringify(report()))).ok, true)
})

test('high advisories without a GitHub GHSA URL fail', () => {
  for (const url of [undefined, 'https://example.com/advisories/' + id,
    'https://github.com/advisories/' + id + '/unrelated']) {
    const result = check(report([advisory(), { ...advisory(), url }]))
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /Unexcepted high advisory.*no GHSA URL/)
  }
})

test('transitive string references are evaluated through their advisory nodes', () => {
  const audit = { vulnerabilities: {
    ...report().vulnerabilities,
    fdir: { via: ['picomatch'], severity: 'high', fixAvailable: false },
  } }
  assert.equal(check(audit).ok, true)
  const unexcepted = { vulnerabilities: {
    ...audit.vulnerabilities,
    other: { via: [advisory('other')], fixAvailable: false },
  } }
  assert.equal(check(unexcepted).ok, false)
})
