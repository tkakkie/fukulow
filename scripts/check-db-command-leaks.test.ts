import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

const argSecret = 'fixture-private-argument'
const inputSecret = 'fixture-private-stdin'
const stdoutSecret = 'fixture-private-stdout'
const stderrSecret = 'fixture-private-stderr'
const cacheToken = 'fixture-private-cache-token'
const cacheUrl = 'https://fixture-private-cache.invalid'
const passwords = {
  POSTGRES_PASSWORD: 'fixture-private-owner-password',
  POSTGRES_APP_PASSWORD: 'fixture-private-app-password',
  FUKULOW_SETUP_TOKEN: 'fixture-private-setup-token',
}
const roles = new URL('./check-db-roles.ts', import.meta.url).href
const upgrade = new URL('./check-db-upgrade.ts', import.meta.url).href

type Fixture = {
  call: string
  args: string[]
  input?: boolean
  cache?: boolean
  backup?: boolean
  status?: number
  diagnostic?: string
}
type Outcome = 'failure' | 'timeout' | 'expected' | 'noisy'

function checkSuppression(t: TestContext, fixture: Fixture, outcome: Outcome, error?: RegExp) {
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-db-command-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const reached = join(directory, 'reached')
  const archive = join(directory, 'backup.dump')
  const executable = join(directory, fixture.backup ? 'backup-node' : 'docker')
  writeFileSync(archive, inputSecret)
  writeFileSync(executable, `#!/usr/bin/env node
    const assert = require('node:assert/strict')
    const { readFileSync, writeFileSync, writeSync } = require('node:fs')
    const args = process.argv.slice(2)
    for (const arg of ${JSON.stringify(fixture.args)}) assert.ok(args.includes(arg))
    const input = ${!!fixture.input} ? readFileSync(0, 'utf8') : ''
    if (${!!fixture.input}) assert.equal(input, ${JSON.stringify(inputSecret)})
    const values = ${JSON.stringify(Object.keys(passwords))}.map(key => {
      assert.equal(process.env[key], ${JSON.stringify(passwords)}[key])
      return process.env[key]
    })
    if (${!!fixture.cache}) {
      assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, ${JSON.stringify(cacheToken)})
      assert.equal(process.env.ACTIONS_RESULTS_URL, ${JSON.stringify(cacheUrl)})
      values.push(process.env.ACTIONS_RUNTIME_TOKEN, process.env.ACTIONS_RESULTS_URL)
    }
    if (${outcome !== 'expected'}) writeSync(1, [${JSON.stringify(stdoutSecret)}, ...args, input, ...values].join('\\n'))
    writeSync(2, [${JSON.stringify(stderrSecret)}, ...args, input, ...values,
      ${JSON.stringify(outcome === 'expected' || outcome === 'noisy' ? fixture.diagnostic ?? '' : '')}].join('\\n'))
    // A timeout must happen after both writes for the partial-output check to count.
    writeFileSync(${JSON.stringify(reached)}, 'wrote diagnostics')
    if (${outcome === 'timeout'}) setTimeout(() => {}, 3000)
    process.exitCode = ${fixture.status ?? 42}
  `, { mode: 0o700 })

  const parent = `
    import { closeSync, openSync, writeSync } from 'node:fs'
    import { inspect } from 'node:util'
    import { appRead } from ${JSON.stringify(roles)}
    import { upgradeCommands } from ${JSON.stringify(upgrade)}
    const env = process.env
    const timeout = 1000
    ${fixture.backup ? `process.execPath = ${JSON.stringify(executable)}` : ''}
    const commands = upgradeCommands(['compose', '-f', ${JSON.stringify(argSecret)}], env, timeout)
    const input = openSync(${JSON.stringify(archive)}, 'r')
    try {
      ${fixture.call}
    } catch (error) {
      writeSync(3, inspect(error, { showHidden: true, depth: null }))
      process.exitCode = 1
    } finally {
      closeSync(input)
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', parent], {
    env: {
      PATH: [directory, dirname(process.execPath)].join(delimiter), ...passwords,
      TEST_ARGUMENT: argSecret, TEST_INPUT: inputSecret,
      ...(fixture.cache ? { CHECK_UPGRADE_CACHE_FROM: 'type=gha,scope=docker',
        ACTIONS_RUNTIME_TOKEN: cacheToken, ACTIONS_RESULTS_URL: cacheUrl } : {}),
    },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 5000,
  })
  assert.equal(result.error, undefined)
  assert.equal(readFileSync(reached, 'utf8'), 'wrote diagnostics')
  const thrown = result.output[3]
  assert.ok(typeof thrown === 'string')
  for (const [channel, output] of [['stdout', result.stdout], ['stderr', result.stderr], ['thrown error', thrown]]) {
    for (const secret of [argSecret, inputSecret, stdoutSecret, stderrSecret, cacheToken, cacheUrl, ...Object.values(passwords)]) {
      assert.ok(!output.includes(secret), `secret leaked into ${channel}`)
    }
  }
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(result.status, error ? 1 : 0)
  if (error) assert.match(thrown, error)
  else assert.equal(thrown, '')
}

const appPasswordArg = `PGPASSWORD=${passwords.POSTGRES_APP_PASSWORD}`
const failed = /^Error: Command exited with status 42\n/
const timedOut = /^Error: Command failed to complete\n/

for (const outcome of ['failure', 'timeout'] as const) {
  test(`check-db-roles appRead suppresses secrets on ${outcome}`, t => checkSuppression(t, {
    call: 'appRead(env.TEST_ARGUMENT, env.POSTGRES_APP_PASSWORD, { env, input: env.TEST_INPUT, timeout })',
    args: [appPasswordArg, argSecret, 'psql', '-X', 'ON_ERROR_STOP=1', 'SELECT count(*) > 0 FROM _sqlx_migrations'],
    input: true,
  }, outcome, outcome === 'failure' ? failed : timedOut))
}

const upgradeFixtures: Record<string, Fixture> = {
  'Compose config': { call: "commands.dc('config', '--format', 'json')", args: [argSecret, 'config'] },
  'owner SQL': {
    call: "commands.sql(env.TEST_ARGUMENT, ['exec', 'old-db'])",
    args: ['old-db', 'psql', '-X', 'ON_ERROR_STOP=1', argSecret],
  },
  'cache-enabled old image build': {
    call: "commands.buildOldImage('source', env.TEST_ARGUMENT, env)",
    args: ['buildx', '--cache-from', 'type=gha,scope=docker', argSecret], cache: true,
  },
  'current image build': { call: 'commands.buildCurrentImage()', args: [argSecret, 'build', 'app'] },
  'archive restore': {
    call: 'commands.restoreArchive(input)',
    args: [argSecret, 'pg_restore', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction'], input: true,
  },
  'restored role grants': {
    call: 'commands.restoreRoles()',
    args: [argSecret, `DATABASE_URL=postgres://fukulow:${passwords.POSTGRES_PASSWORD}@db:5432/fukulow_restore`, 'roles'],
  },
  'restored app read': {
    call: "commands.restoredApp('SELECT count(*) FROM messages')",
    args: [argSecret, appPasswordArg, 'psql', '-X', 'ON_ERROR_STOP=1', 'fukulow_restore'],
  },
}

for (const [command, fixture] of Object.entries(upgradeFixtures)) {
  for (const outcome of ['failure', 'timeout'] as const) {
    test(`check-db-upgrade ${command} suppresses secrets on ${outcome}`, t =>
      checkSuppression(t, fixture, outcome, outcome === 'failure' ? failed : timedOut))
  }
}

const denialFixtures = [
  {
    command: 'migration mismatch',
    call: "commands.checkMigrationMismatch('project', env.TEST_ARGUMENT)",
    args: [argSecret, `DATABASE_URL=postgres://fukulow_app:${passwords.POSTGRES_APP_PASSWORD}@db:5432/fukulow`,
      `FUKULOW_SETUP_TOKEN=${passwords.FUKULOW_SETUP_TOKEN}`],
    status: 1, diagnostic: 'migration version/checksum/state mismatch', assertion: /Expected the migration mismatch diagnostic/,
  },
  {
    command: 'app role denial',
    call: 'commands.checkAppRoleDenial(env.TEST_ARGUMENT)',
    args: [argSecret, appPasswordArg, 'psql', '-X', 'ON_ERROR_STOP=1'],
    status: 1, diagnostic: 'permission denied', assertion: /Expected a PostgreSQL privilege denial/,
  },
]
for (const fixture of denialFixtures) {
  test(`check-db-upgrade ${fixture.command} checks stderr privately`, t => {
    checkSuppression(t, fixture, 'expected')
    checkSuppression(t, fixture, 'failure', fixture.assertion)
    checkSuppression(t, { ...fixture, status: 0 }, 'expected', /^Error: Command exited with status 0\n/)
    checkSuppression(t, fixture, 'timeout', timedOut)
  })
}

test('check-db-upgrade migration mismatch rejects unexpected stdout privately', t => {
  checkSuppression(t, denialFixtures[0], 'noisy', /Migration mismatch must produce no stdout/)
})

test('check-db-upgrade suppresses backup child failure diagnostics', t => {
  const fixture = { call: 'commands.backup(env.TEST_ARGUMENT)', args: ['scripts/backup.ts', argSecret], backup: true }
  checkSuppression(t, fixture, 'failure', failed)
  checkSuppression(t, fixture, 'timeout', timedOut)
  checkSuppression(t, { ...fixture, status: 0 }, 'noisy', /Expected backup confirmation/)
})

test('check-db-upgrade suppresses cleanup failure output and continues', t => {
  const fixture = { call: "commands.cleanup(['compose', '-p', env.TEST_ARGUMENT, 'down'])", args: [argSecret, 'down'] }
  checkSuppression(t, fixture, 'failure')
  checkSuppression(t, fixture, 'timeout')
})
