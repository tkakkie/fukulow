import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Entry } from './check-versions.ts'
import { addMonths, gather, marker, newer, newestLine, report, type Release } from './version-report.ts'

const base = { file: 'f', pattern: '', class: 'patch-minor', updates: 'dependabot' }
const entries: Entry[] = [
  { ...base, component: 'Node.js', version: '26.13.1', support: '2029-04-30', endoflife: 'nodejs', updates: 'weekly-check', class: 'toolchain',
    latest: { endoflife: 'nodejs', lts: true } },
  { ...base, component: 'Debian', version: 'trixie', cycle: '13', support: '2030-06-30', endoflife: 'debian' },
  { ...base, component: 'Old', version: '1.2.3', support: '2027-01-31', endoflife: 'old' },
  { ...base, component: 'Gone', version: '0.9.0', support: 'latest only', endoflife: 'gone' },
  { ...base, component: 'k6', version: '1.8.2', support: 'latest only', updates: 'weekly-check', latest: { github: 'grafana/k6' } },
  { ...base, component: 'Tool', version: '2.0.0', support: 'latest only', updates: 'weekly-check', latest: { github: 'down/tool' } },
  { ...base, component: 'Missing', version: '3.0.0', support: 'latest only', endoflife: 'unlisted' },
]
const pages: Record<string, unknown> = {
  'https://endoflife.date/api/v1/products/nodejs/': { result: { releases: [
    { name: '27', eolFrom: '2028-06-01', ltsFrom: null, latest: { name: '27.1.0' } },
    { name: '26', eolFrom: '2029-04-30', ltsFrom: '2026-10-28', latest: { name: '26.14.0' } }] } },
  'https://endoflife.date/api/v1/products/debian/': { result: { releases: [{ name: '13', eolFrom: '2030-06-30' }] } },
  'https://endoflife.date/api/v1/products/old/': { result: { releases: [{ name: '1.2', eolFrom: '2027-02-01' }, { name: '1', eolFrom: '2026-01-01' }] } },
  'https://endoflife.date/api/v1/products/gone/': { result: { releases: [{ name: '0.9', eolFrom: '2026-10-01' }] } },
  'https://api.github.com/repos/grafana/k6/releases/latest': { tag_name: 'v2.0.0' },
}
const fake = async (url: string) => {
  if (url.includes('down/tool')) throw new Error('network unreachable')
  return { status: url in pages ? 200 : 404, json: async () => pages[url] }
}

test('report lists newer versions, near and past support ends, failures and notes', async () => {
  const today = '2026-11-17'
  const { body, actionable } = report(entries, await gather(entries, fake, today), today)
  assert.equal(actionable, true)
  assert.ok(body.startsWith(marker))
  const section = (title: string) => body.split(`## ${title}\n`)[1].split('\n\n')[0]
  assert.equal(section('Newer versions available'), '- Node.js: 26.13.1 -> 26.14.0 (`f`, toolchain)\n- k6: 1.8.2 -> 2.0.0 (`f`, patch-minor, new major: one Issue, maintainer decides)')
  assert.equal(section('Support ends within 6 months'), '- Old 1.2.3: support ends 2027-02-01 (endoflife.date)')
  assert.equal(section('Past support end'), '- Gone 0.9.0: support ended 2026-10-01 (endoflife.date)')
  assert.match(section('Upstream failures (not checked this run)'), /^- Tool: Error: network unreachable$/)
  assert.match(section('Notes'), /Old: versions.json says 2027-01-31, endoflife.date says 2027-02-01/)
  assert.match(section('Notes'), /Missing: unlisted is not on endoflife.date/)
  assert.doesNotMatch(body, /27\.1\.0/, 'Node follows LTS lines only')
})

test('upstream HTTP errors are reported, never skipped', async () => {
  const failing = async () => ({ status: 503, json: async () => ({}) })
  const facts = await gather(entries, failing, '2026-11-17')
  assert.deepEqual(facts.get('k6')?.failures, ['Error: GitHub grafana/k6: HTTP 503'])
  assert.deepEqual(facts.get('Node.js')?.failures, ['Error: endoflife.date nodejs: HTTP 503', 'Error: endoflife.date nodejs: HTTP 503'])
  const { body } = report(entries, facts, '2026-11-17')
  assert.match(body, /- Debian: Error: endoflife.date debian: HTTP 503/)
})

test('version comparison and month arithmetic', () => {
  assert.ok(newer('1.100.0', '1.99.1'))
  assert.ok(!newer('1.99.1', '1.99.1'))
  assert.ok(!newer('1.9', '1.10.0'))
  assert.equal(addMonths('2026-11-17', 6), '2027-05-17')
})

test('month arithmetic clamps to the end of shorter months', () => {
  assert.equal(addMonths('2026-08-31', 6), '2027-02-28')
  assert.equal(addMonths('2027-08-31', 6), '2028-02-29', 'leap year')
  assert.equal(addMonths('2026-12-31', 6), '2027-06-30')
  assert.equal(addMonths('2026-05-31', 6), '2026-11-30')
  assert.equal(addMonths('2026-07-31', 6), '2027-01-31', 'year rollover, no clamp')
  assert.equal(addMonths('2026-02-28', 6), '2026-08-28')
  assert.equal(addMonths('2028-02-29', 12), '2029-02-28')
})

test('latest line is chosen by version, whatever the API order', () => {
  const lines: Release[] = [
    { name: '20', eolFrom: '2026-04-30', ltsFrom: '2023-10-24', latest: { name: '20.19.5' } },
    { name: '26', eolFrom: '2029-04-30', ltsFrom: '2026-10-28', latest: { name: '26.14.0' } },
    { name: '27', eolFrom: '2028-06-01', ltsFrom: null, latest: { name: '27.1.0' } },
    { name: '24', eolFrom: '2028-04-30', ltsFrom: '2025-10-28', latest: { name: '24.11.0' } },
    { name: '28', eolFrom: '2031-04-30', ltsFrom: '2027-10-26', latest: { name: '28.0.0' } },
  ]
  const orders = [lines, [...lines].reverse(), [lines[2], lines[0], lines[4], lines[3], lines[1]]]
  for (const order of orders) {
    assert.equal(newestLine(order, true, '2026-11-17')?.latest?.name, '26.14.0', 'newest LTS already in LTS')
    assert.equal(newestLine(order, false, '2026-11-17')?.latest?.name, '28.0.0', 'without lts, highest version')
  }
  assert.equal(newestLine(lines, true, '2027-10-26')?.latest?.name, '28.0.0', 'LTS start day counts')
  assert.equal(newestLine(lines, true, '2023-01-01'), undefined)
})

test('current versions with no support deadlines produce an all-clear report', async () => {
  const entry = entries[0]
  const today = '2026-11-17'
  const current = { ...entry, version: '26.14.0' }
  const { body, ...findings } = report([current], await gather([current], fake, today), today)
  assert.deepEqual(findings, { newer: [], soon: [], past: [], failures: [], notes: [], actionable: false })
  assert.equal(body.match(/^- none$/gm)?.length, 5)
})

test('each finding category alone makes a report actionable', () => {
  const today = '2026-11-17'
  const entry = entries[4]
  const cases = [
    { category: 'newer', fact: { latest: '2.0.0' }, row: {
      component: 'k6', pinned: '1.8.2', latest: '2.0.0', file: 'f', class: 'patch-minor', newMajor: true,
    } },
    { category: 'soon', fact: { support: '2027-05-17' }, row: {
      component: 'k6', version: '1.8.2', end: '2027-05-17', source: 'endoflife.date',
    } },
    { category: 'past', fact: { support: '2026-11-16' }, row: {
      component: 'k6', version: '1.8.2', end: '2026-11-16', source: 'endoflife.date',
    } },
    { category: 'notes', fact: { notes: ['release cycle needs a check'] }, row: {
      component: 'k6', message: 'release cycle needs a check',
    } },
  ] as const
  for (const { category, fact, row } of cases) {
    const facts = { failures: [], ...fact, notes: 'notes' in fact ? [...fact.notes] : [] }
    const findings = report([entry], new Map([[entry.component, facts]]), today)
    assert.equal(findings.actionable, true, category)
    assert.deepEqual(findings[category], [row])
    assert.equal(findings.body.match(/^- none$/gm)?.length, 4, category)
  }
})

test('a fetch failure alone is actionable and appears in JSON and Markdown', async () => {
  const today = '2026-11-17'
  const failed = [entries[5]]
  const findings = report(failed, await gather(failed, fake, today), today)
  assert.equal(findings.actionable, true)
  assert.deepEqual(findings.failures, [{ component: 'Tool', message: 'Error: network unreachable' }])
  assert.match(findings.body, /- Tool: Error: network unreachable/)
  assert.equal(findings.body.match(/^- none$/gm)?.length, 4)
})
