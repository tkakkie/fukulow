// Regression tests for verifying that the Playwright smoke suite runs unfiltered in PR CI.
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { checkRows, collectKnownTests } from './check-invariants.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Playwright invariant PR CI coverage', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/e2e.yml'), 'utf8')
  const config = "import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: './e2e', reporter: [['./scripts/e2e-reporter.ts']], projects: [{ name: 'chromium' }] })\n"
  const plain = "import { test } from '@playwright/test'\ntest('runs', async () => {})\n"
  const fixture = (run: (root: string, put: (path: string, text: string) => void) => void) => {
    const root = mkdtempSync(join(tmpdir(), 'inv-playwright-'))
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    try {
      mkdirSync(join(root, 'server'))
      put('.github/workflows/e2e.yml', workflow)
      put('web/playwright.config.ts', config)
      put('web/e2e/x.spec.ts', plain)
      run(root, put)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  const check = (root: string, file = 'web/e2e/x.spec.ts', title = 'runs') => checkRows([
    { line: 3, rule: 'browser rule', names: [`${file}::${title}`], todo: false },
  ], collectKnownTests(root))

  it('accepts a plain smoke test and the real discovery config', () => fixture((root, put) => {
    expect(check(root)).toEqual([])
    put('web/playwright.config.ts', readFileSync(resolve(import.meta.dirname, '../playwright.config.ts'), 'utf8'))
    expect(check(root)).toEqual([])
  }))

  it.each(['skip', 'fixme', 'fail'])('refuses testInfo.%s and destructured callback methods', method => fixture((root, put) => {
    for (const callback of [
      `async ({ page }, testInfo) => { testInfo.${method}(true) }`,
      `async ({ page }, { ${method} }) => { ${method}(true) }`,
      `async ({ page }, info) => { const { ${method}: annotate } = info; annotate(true) }`,
    ]) {
      put('web/e2e/x.spec.ts', `import { test } from '@playwright/test'\ntest('runs', ${callback})`)
      expect(check(root)[0]).toMatch(/at most one parameter|may receive TestInfo/)
    }
  }))

  it.each([
    ["import { gate } from '../src/helper.ts'", 'web/src/helper.ts'],
    ["import * as h from '../src/helper.ts'", 'web/src/helper.ts'],
    ["import { gate } from '../../scripts/gate.ts'", 'scripts/gate.ts'],
    ["import { gate } from 'some-package'", ''],
    ["export { gate } from '../src/helper.ts'", 'web/src/helper.ts'],
    ["const { gate } = await import('./local.ts')", ''],
    ["const { gate } = require('./local.ts')", ''],
  ])('refuses runtime dependencies outside web/e2e: %s', (line, helper) => fixture((root, put) => {
    // The helper skips at runtime; it is outside the scanned smoke directory.
    if (helper) put(helper, "import { test } from '@playwright/test'\nexport function gate() { test.skip(true) }\n")
    put('web/e2e/x.spec.ts', `import { test } from '@playwright/test'\n${line}\ntest('runs', async () => {})\n`)
    expect(check(root)[0]).toContain('cannot be verified')
    // Also refused when only a smoke helper imports it.
    put('web/e2e/x.spec.ts', "import { test } from '@playwright/test'\nimport { local } from './local.ts'\ntest('runs', async () => { local() })\n")
    put('web/e2e/local.ts', `${line}\nexport function local() {}\n`)
    expect(check(root)[0]).toContain('cannot be verified')
  }))

  it('accepts type-only imports, node builtins and smoke-local helpers', () => fixture((root, put) => {
    put('web/src/api-schema.d.ts', 'export type components = {}\n')
    put('web/e2e/helpers.ts', "import type { components } from '../src/api-schema.d.ts'\nimport { type components as C } from '../src/api-schema.d.ts'\nexport type { components }\nexport const h = (_: C | components) => 1\n")
    put('web/e2e/x.spec.ts', "import { test } from '@playwright/test'\nimport { randomUUID } from 'node:crypto'\nimport { h } from './helpers.ts'\ntest('runs', async () => { h({}); randomUUID() })\n")
    expect(check(root)).toEqual([])
  }))

  it('refuses even an unused second callback parameter', () => fixture((root, put) => {
    put('web/e2e/x.spec.ts', plain.replace('async ()', 'async ({ page }, unused)'))
    expect(check(root)[0]).toMatch(/at most one parameter|may receive TestInfo/)
  }))

  it.each([
    "{ annotation: { type: 'skip' } }",
    "{ annotation: { type: 'fixme' } }",
    "{ annotation: { type: 'fail' } }",
    "{ tag: '@slow' }",
  ])('refuses three-argument test and describe details: %s', details => fixture((root, put) => {
    put('web/e2e/x.spec.ts', plain.replace("'runs',", `'runs', ${details},`))
    expect(check(root)[0]).toMatch(/literal title and inline callback|details or options/)
    put('web/e2e/x.spec.ts', `import { test } from '@playwright/test'\ntest.describe('suite', ${details}, () => { test('runs', () => {}) })`)
    expect(check(root)[0]).toMatch(/literal title and inline callback|details or options/)
  }))

  it.each([
    "import { test as t } from '@playwright/test'; t.skip(true)",
    "import { test, test as t } from '@playwright/test'; t.skip(true)",
    "import { test as t } from '@playwright/test'; t.describe.configure({ mode: 'serial' })",
    "import * as pw from '@playwright/test'; pw.test.skip(true)",
    "import pw from '@playwright/test'; pw.test.skip(true)",
    "import '@playwright/test'",
    'const t = test; t.skip(true)',
    'const { skip } = test; skip(true)',
    'register(test)',
    'const describe = test.describe; register(describe)',
    'register(test.describe)',
  ])('refuses import/local aliases and escaped test values: %s', code => fixture((root, put) => {
    for (const file of ['web/e2e/x.spec.ts', 'web/e2e/helpers.ts']) {
      put(file, plain + code)
      expect(check(root)[0]).toContain('entire smoke suite unverifiable')
      put(file, plain)
    }
  }))

  it.each([
    "test[('sk' + 'ip') as 'skip'](true)",
    "const k = 'skip'; test[k](true)",
    "test[`sk${'ip'}`](true)",
    "test[('on' + 'ly') as 'only']('focused', () => {})",
    "test.describe[('sk' + 'ip') as 'skip']('suite', () => {})",
    "test.describe[('on' + 'ly') as 'only']('suite', () => {})",
    "test[('fix' + 'me') as 'fixme'](true)",
    "test['describe'][('sk' + 'ip') as 'skip']('suite', () => {})",
    'test.info().skip()',
    "test.info()[('sk' + 'ip') as 'skip']()",
    'const t = test.extend({}); t.skip(true)',
    "eval('test.skip(true)')",
    "import { _baseTest } from '@playwright/test'",
  ])('refuses dynamic or unlisted Playwright test access, in specs and helpers: %s', code => fixture((root, put) => {
    // Each of these can skip or focus at runtime while the name never appears literally (#440).
    for (const file of ['web/e2e/x.spec.ts', 'web/e2e/helpers.ts']) {
      put(file, plain + code + '\n')
      expect(check(root)[0], `${file}: ${code}`).toContain('entire smoke suite unverifiable')
      put(file, plain)
    }
  }))

  it.each([
    // TestInfo reached without test.info() (#440 review, round 2).
    "export const f = () => expect.getState().currentTestInfo[('sk' + 'ip') as 'skip'](true)",
    "export const f = () => { (expect as any)['get' + 'State']() }",
    "test.beforeEach(async ({ page }, info) => { info[('sk' + 'ip') as 'skip'](true) })",
    "test.afterAll(async ({}, info) => { info.expectedStatus = 'skipped' })",
    "test.use({ page: async ({ page }, use, info) => { await use(page) } })",
    "const opts = { locale: 'ja-JP' }; test.use(opts)",
    "export const f = () => test.step('s', async step => { step[('sk' + 'ip') as 'skip']() })",
    "test.describe('suite', { annotation: { type: 'skip' } }, () => {})",
    "test('helper', { tag: '@slow' }, async () => {})",
    "const e = expect; e.poll(() => 1)",
    "expect.extend({})",
    "const o = { get skip() { return 1 } }",
    "const o = { skip() {} }",
    "import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)('@playwright/test')",
    "import vm from 'node:vm'\nvm.runInThisContext('1')",
  ])('refuses TestInfo handles, unsafe callbacks and loaders: %s', code => fixture((root, put) => {
    for (const file of ['web/e2e/x.spec.ts', 'web/e2e/helpers.ts']) {
      put(file, "import { expect, test } from '@playwright/test'\ntest('runs', async () => {})\n" + code + '\n')
      // A modifier-named method in a spec refuses that file; in a helper, the whole suite.
      expect(check(root)[0], `${file}: ${code}`).toMatch(/entire smoke suite unverifiable|unsupported Playwright \.skip/)
      put(file, plain)
    }
  }))

  it('accepts the listed test members and literal keys in a helper', () => fixture((root, put) => {
    // A helper is checked by the suite-wide scan only (spec files also go through tsTests, which is stricter).
    put('web/e2e/helpers.ts', "import { expect, test } from '@playwright/test'\nimport { readFile } from 'node:fs/promises'\n" + [
      "test.describe('suite', () => {})",
      'test.beforeEach(async ({ page }) => { await page.goto("/") })',
      "export const poll = async () => { await expect.poll(() => readFile('x')).toBeTruthy(); expect(1).toBe(1) }",
      'test.beforeEach(async () => {})', 'test.afterEach(async () => {})',
      'test.beforeAll(async () => {})', 'test.afterAll(async () => {})',
      "test.use({ locale: 'ja-JP' })", 'test.setTimeout(60_000)',
      "export const step = () => test.step('s', async () => {})",
      "const mime: Record<string, string> = { '.js': 'text/javascript' }; const k = '.js'; mime[k]",
    ].join('\n') + '\n')
    expect(check(root)).toEqual([])
  }))

  it.each(['ts', 'mts', 'cts', 'js', 'mjs', 'tsx', 'cjs', 'jsx', 'custom'])('scans helper modifier access and bindings in .%s files', extension => fixture((root, put) => {
    for (const modifier of ['skip', 'fixme', 'fail', 'only', 'configure', 'slow']) {
      for (const code of [
        `test.${modifier}(true)`,
        `test['${modifier}'](true)`,
        `test[\`${modifier}\`](true)`,
        `const f = alias.${modifier}; f(true)`,
        `const { ${modifier} } = alias`,
        `const { ${modifier}: f } = alias; f(true)`,
        `const { ['${modifier}']: f } = alias`,
        `const { [\`${modifier}\`]: f } = alias`,
        `let f; ({ ${modifier}: f } = alias)`,
        `let ${modifier}; ({ ${modifier} } = alias)`,
      ]) {
        put(`web/e2e/nested/helpers.${extension}`, code)
        expect(check(root)[0], code).toContain('entire smoke suite unverifiable')
      }
    }
    put(`web/e2e/nested/helpers.${extension}`, "export const skipOnCi = () => test.skip(true)")
    expect(check(root)[0]).toContain('entire smoke suite unverifiable')
    put(`web/e2e/nested/helpers.${extension}`, "test.describe.configure({ mode: 'serial' })")
    expect(check(root)[0]).toContain('entire smoke suite unverifiable')
  }))

  it.each(['dist', 'target', 'node_modules'])('also checks helpers in normally excluded %s directories', directory => fixture((root, put) => {
    put(`web/e2e/${directory}/helper.js`, 'alias.only("focus", () => {})')
    expect(check(root)[0]).toContain('entire smoke suite unverifiable')
  }))

  it.each([
    'test[`only`]("focus", () => {})',
    'const f = test.only; f("focus", () => {})',
    'const { only } = test; only("focus", () => {})',
  ])('refuses focus in another spec: %s', code => fixture((root, put) => {
    put('web/e2e/other.spec.ts', code)
    expect(check(root)[0]).toContain('entire smoke suite unverifiable')
  }))

  it('keeps serial configuration local to its spec', () => fixture((root, put) => {
    put('web/e2e/serial.spec.ts', plain + "test.describe.configure({ mode: 'serial' })")
    expect(check(root)).toEqual([])
    expect(check(root, 'web/e2e/serial.spec.ts')[0]).toContain('unsupported Playwright')
  }))

  it('still refuses Vitest files importing Playwright types', () => fixture((root, put) => {
    put('web/src/vitest.test.ts', "import type { Page } from '@playwright/test'\nit('runs', () => {})")
    expect(check(root, 'web/src/vitest.test.ts')[0]).toContain('outside smoke testDir')
  }))

  it.each(['skip', 'fixme', 'fail'])('refuses a Playwright %s declaration', modifier => fixture((root, put) => {
    put('web/e2e/x.spec.ts', plain.replace("test('runs'", `test.${modifier}('runs'`))
    expect(check(root)[0]).toContain(`Playwright .${modifier} access or binding`)
  }))

  it.each(['skip', 'fixme'])('refuses every title inside describe.%s', modifier => fixture((root, put) => {
    put('web/e2e/x.spec.ts', `import { test } from '@playwright/test'\ntest.describe.${modifier}('outer', () => { test.describe('inner', () => { test('runs', () => {}) }) })`)
    expect(check(root)[0]).toContain(`Playwright .${modifier} access or binding`)
  }))

  it.each([
    "test.skip(process.env.CI, 'reason')",
    'test.fixme(true)',
    "test.skip(({ browserName }) => browserName === 'chromium')",
    'test.skip()',
    'test.fail()',
  ])('refuses a whole file with runtime/conditional annotation: %s', annotation => fixture((root, put) => {
    put('web/e2e/x.spec.ts', plain + `test('other', () => { ${annotation} })`)
    expect(check(root)[0]).toContain('runtime/conditional Playwright skip/fixme/fail')
  }))

  it.each(['test.only', 'test.describe.only'])('refuses a whole file with %s', call => fixture((root, put) => {
    put('web/e2e/x.spec.ts', plain + `${call}('focused', () => {})`)
    expect(check(root)[0]).toContain('Playwright .only')
  }))

  it.each(['test.only', 'test.describe.only', "alias['only']"])('refuses other files when a helper focuses the suite with %s', call => fixture((root, put) => {
    put('web/e2e/helpers.ts', `${call}('focused', () => {})`)
    expect(check(root)[0]).toContain('entire smoke suite unverifiable')
  }))

  it.each([
    "test.describe.configure({ mode: 'serial' })",
    "if (process.env.CI) test('conditional', () => {})",
    "test('callback', handler)",
    "test['skip'](true)",
    "test.describe.serial('suite', () => {})",
    "test.concurrent('invalid', () => {})",
  ])('refuses unsupported or conditional declarations: %s', code => fixture((root, put) => {
    put('web/e2e/x.spec.ts', plain + code)
    expect(check(root)[0]).toMatch(/unsupported Playwright|conditional\/nested|inline callback/)
  }))

  it('refuses a test imported from an unverifiable fixture module', () => fixture((root, put) => {
    put('web/e2e/x.spec.ts', plain.replace('@playwright/test', './fixtures'))
    expect(check(root)[0]).toContain('imported directly without an alias')
  }))

  it('refuses duplicate titles when a definition is skipped', () => fixture((root, put) => {
    put('web/e2e/x.spec.ts', plain + "test.skip('runs', () => {})")
    expect(check(root)[0]).toContain('Playwright .skip access or binding')
  }))

  it('refuses a browser file outside testDir', () => fixture((root, put) => {
    put('web/elsewhere/x.spec.ts', plain)
    expect(check(root, 'web/elsewhere/x.spec.ts')[0]).toContain('outside smoke testDir')
  }))

  it('preserves Vitest discovery when Playwright imports appear only in fixture strings or comments', () => fixture((root, put) => {
    put('web/src/vitest.test.ts', `// import { test } from '@playwright/test'\nconst example = ${JSON.stringify(plain)}\nit('runs', () => {})`)
    expect(check(root, 'web/src/vitest.test.ts')).toEqual([])
  }))

  it('refuses Compose-only acceptance even with valid PR smoke CI', () => fixture((root, put) => {
    put('web/e2e-compose/x.spec.ts', plain)
    expect(check(root, 'web/e2e-compose/x.spec.ts')[0]).toContain('Compose-only')
  }))

  it('refuses a missing workflow', () => fixture(root => {
    rmSync(join(root, '.github/workflows/e2e.yml'))
    expect(check(root)[0]).toContain('workflow e2e.yml is missing')
  }))

  it.each(['push:', 'pull_request:\n    paths: [web/**]'])('refuses a non-PR or filtered trigger: %s', trigger => fixture((root, put) => {
    put('.github/workflows/e2e.yml', workflow.replace('pull_request:', trigger))
    expect(check(root)[0]).toContain('pull_request trigger is absent or filtered')
  }))

  it.each(['push', 'workflow_dispatch'])('refuses an extra %s trigger before or after pull_request', trigger => fixture((root, put) => {
    for (const triggers of [`  ${trigger}:\n  pull_request:`, `  pull_request:\n  ${trigger}:`]) {
      put('.github/workflows/e2e.yml', workflow.replace('  pull_request:', triggers))
      expect(check(root)[0]).toContain('pull_request trigger is absent or filtered')
    }
  }))

  it.each(['extra', '"extra"'])('refuses an extra job %s before or after smoke', name => fixture((root, put) => {
    const job = `  ${name}:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo extra\n`
    for (const changed of [workflow.replace('  smoke:', job + '  smoke:'), workflow + job]) {
      put('.github/workflows/e2e.yml', changed)
      expect(check(root)[0]).toContain('smoke job execution cannot be verified')
    }
  }))

  it.each([' x.spec.ts', ' --grep smoke', ' --project chromium', ' --config other.ts', ' --shard 1/2'])('refuses a CLI filter/override: %s', flag => fixture((root, put) => {
    put('.github/workflows/e2e.yml', workflow.replace('cli.js test', `cli.js test${flag}`))
    expect(check(root)[0]).toContain('smoke CLI must run unfiltered')
  }))

  it('refuses a changed working directory', () => fixture((root, put) => {
    put('.github/workflows/e2e.yml', workflow.replace('--workdir "$GITHUB_WORKSPACE/web"', '--workdir "$GITHUB_WORKSPACE"'))
    expect(check(root)[0]).toContain('smoke CLI must run unfiltered')
  }))

  const runtimeStep = '      - name: Verify named E2E invariants passed\n        run: node web/scripts/check-e2e-invariants.ts\n'
  it.each([
    '      - run: echo intervening\n',
    '      - name: Overwrite invariant results\n        run: echo \'{}\' > web/test-results/ci-diagnostics/invariants.json\n',
  ])('refuses an intervening step before the runtime check: %s', intervening => fixture((root, put) => {
    put('.github/workflows/e2e.yml', workflow.replace(runtimeStep, intervening + runtimeStep))
    expect(check(root)[0]).toContain('runtime invariants check must run unconditionally')
  }))

  it.each([
    ['removed', ''],
    ['conditional', runtimeStep.replace('        run:', '        if: false\n        run:')],
    ['continue-on-error', runtimeStep.replace('        run:', '        continue-on-error: true\n        run:')],
    ['failure swallowed', runtimeStep.replace('.ts\n', '.ts || true\n')],
  ])('refuses a runtime check that is %s', (_label, replacement) => fixture((root, put) => {
    expect(workflow).toContain(runtimeStep)
    put('.github/workflows/e2e.yml', workflow.replace(runtimeStep, replacement))
    expect(check(root)[0]).toContain('runtime invariants check must run unconditionally after Playwright')
  }))

  it('refuses a runtime check before Playwright', () => fixture((root, put) => {
    put('.github/workflows/e2e.yml', workflow.replace(runtimeStep, '')
      .replace('      - name: Run smoke', runtimeStep + '      - name: Run smoke'))
    expect(check(root)[0]).toContain('runtime invariants check must run unconditionally after Playwright')
  }))

  it.each([
    '',
    "reporter: 'list',",
    "reporter: process.env.CI ? 'list' : [['./scripts/e2e-reporter.ts']],",
  ])('refuses a missing CI reporter: %s', reporter => fixture((root, put) => {
    put('web/playwright.config.ts', config.replace("reporter: [['./scripts/e2e-reporter.ts']],", reporter))
    expect(check(root)[0]).toContain('CI reporter must include ./scripts/e2e-reporter.ts')
  }))

  it('refuses a conditional smoke job', () => fixture((root, put) => {
    put('.github/workflows/e2e.yml', workflow.replace('  smoke:', '  smoke:\n    if: false'))
    expect(check(root)[0]).toContain('smoke job execution cannot be verified')
  }))

  it.each([
    ['grep: /smoke/,', 'config grep'],
    ['grepInvert: /smoke/,', 'config grepInvert'],
    ["testIgnore: ['**/x.spec.ts'],", 'config testIgnore'],
    ["testMatch: '**/other.spec.ts',", 'config testMatch'],
    ['forbidOnly: false,', 'forbidOnly'],
    ['...other,', 'literal defineConfig object'],
  ])('refuses config exclusion or unverifiable property %s', (property, reason) => fixture((root, put) => {
    put('web/playwright.config.ts', config.replace("testDir: './e2e',", `testDir: './e2e', ${property}`))
    expect(check(root)[0]).toContain(reason)
  }))

  it('refuses missing and nonliteral configs', () => fixture((root, put) => {
    rmSync(join(root, 'web/playwright.config.ts'))
    expect(check(root)[0]).toContain('discovery config is missing')
    put('web/playwright.config.ts', 'export default defineConfig(options)')
    expect(check(root)[0]).toContain('literal defineConfig object')
  }))

  it('refuses a config with another testDir', () => fixture((root, put) => {
    put('web/playwright.config.ts', config.replace('./e2e', './other'))
    expect(check(root)[0]).toContain("testDir must be './e2e'")
  }))

  it('refuses multiple projects', () => fixture((root, put) => {
    put('web/playwright.config.ts', config.replace("[{ name: 'chromium' }]", "[{ name: 'chromium' }, { name: 'firefox' }]"))
    expect(check(root)[0]).toContain('exactly one literal project')
  }))

  it.each(['testDir', 'testMatch', 'grep', 'grepInvert', 'testIgnore'])('refuses per-project %s', key => fixture((root, put) => {
    put('web/playwright.config.ts', config.replace("name: 'chromium'", `name: 'chromium', ${key}: 'other'`))
    expect(check(root)[0]).toContain(`project ${key}`)
  }))
})
