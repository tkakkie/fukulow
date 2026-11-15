import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkE2EInvariants } from './check-e2e-invariants.ts'
import { collectKnownTests } from './check-invariants.ts'

const name = 'web/e2e/example.spec.ts::named guard'
const passed = { file: 'web/e2e/example.spec.ts', titlePath: ['suite', 'named guard'], status: 'passed', annotations: [] }

function fixture(run: (root: string, report: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-invariants-'))
  try {
    mkdirSync(join(root, 'docs/invariants'), { recursive: true })
    mkdirSync(join(root, 'web/e2e'), { recursive: true })
    mkdirSync(join(root, 'server'))
    writeFileSync(join(root, 'web/e2e/example.spec.ts'), "import { test } from '@playwright/test'\ntest.describe('suite', () => { test('named guard', () => {}) })")
    writeFileSync(join(root, 'docs/invariants/web.md'), `| Rule | Test |\n| --- | --- |\n| Named rule | \`${name}\` |\n`)
    run(root, join(root, 'report.json'))
  } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('runtime E2E invariants', () => {
  it('accepts the static collector identity, using leaf titles within suites', () => fixture((root, report) => {
    expect(collectKnownTests(root).has(name)).toBe(true)
    writeFileSync(report, JSON.stringify({ version: 1, tests: [passed] }))
    expect(checkE2EInvariants(root, report)).toEqual([])
  }))

  it.each([
    ['missing (grep/only/conditional registration)', []],
    ['skipped', [{ ...passed, status: 'skipped' }]],
    ['skip annotation', [{ ...passed, annotations: [{ type: 'skip' }] }]],
    ['fixme', [{ ...passed, status: 'skipped', annotations: [{ type: 'fixme' }] }]],
    ['fixme annotation on a pass', [{ ...passed, annotations: [{ type: 'fixme' }] }]],
    ['failed', [{ ...passed, status: 'failed' }]],
    ['interrupted', [{ ...passed, status: 'interrupted' }]],
    ['timedOut', [{ ...passed, status: 'timedOut' }]],
    ['duplicated title in separate suites', [passed, { ...passed, titlePath: ['other suite', 'named guard'] }]],
    ['existing file with different title', [{ ...passed, titlePath: ['different title'] }]],
    ['same title in different file', [{ ...passed, file: 'web/e2e/other.spec.ts' }]],
    ['unknown runtime identity', [{ ...passed, titlePath: null }]],
  ])('refuses %s and names the row', (_label, tests) => fixture((root, report) => {
    writeFileSync(report, JSON.stringify({ version: 1, tests }))
    expect(checkE2EInvariants(root, report)).toEqual([expect.stringContaining(`docs/invariants/web.md:3 (Named rule): ${name}:`)])
  }))

  it.each([undefined, '{', '{}', '{"version":1,"tests":{}}', '{"version":1,"tests":[{}]}',
    JSON.stringify({ version: 1, tests: [{ ...passed, annotations: null }] }),
    JSON.stringify({ version: 1, tests: [{ ...passed, status: 'unknown' }] }),
  ])('fails closed and names the row for missing/malformed report %s', contents => fixture((root, report) => {
    if (contents !== undefined) writeFileSync(report, contents)
    expect(checkE2EInvariants(root, report)).toContainEqual(expect.stringContaining(`${name}: missing or malformed`))
  }))
})
