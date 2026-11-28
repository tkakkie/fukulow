import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cwd, env, args, checkRestrictions } from './compose-test-helpers.ts'

test('deployment and load app and migrate enforce container restrictions with removal and weakening denials', () => {
  for (const file of ['compose.yml', 'load/compose.yml']) {
    for (const profileArgs of file === 'compose.yml' ? [['--profile', 'caddy'], ['--profile', 'nginx']] : [[]]) {
      const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', file,
        ...profileArgs, 'config', '--format', 'json'], { cwd, env: { ...env, LOAD_PROJECT: 'restrictions-test', LOAD_PORT: '18080',
          LOAD_DB_PASSWORD: 'owner-test-only', LOAD_APP_PASSWORD: 'app-test-only', LOAD_SETUP_TOKEN: 'setup-test-only' }, encoding: 'utf8' }))
      for (const name of ['app', 'migrate']) {
        const service = config.services[name]
        checkRestrictions(service)
        for (const [key, weakened] of [['read_only', false], ['cap_drop', ['NET_RAW']], ['security_opt', ['no-new-privileges:false']]] as const) {
          const removed = structuredClone(service)
          delete removed[key]
          assert.throws(() => checkRestrictions(removed), undefined, `${file} ${name} removed ${key}`)
          assert.throws(() => checkRestrictions({ ...service, [key]: weakened }), undefined, `${file} ${name} weakened ${key}`)
        }
        for (const mutation of [{ privileged: true }, { cap_add: ['NET_RAW'] }, { volumes: ['/tmp:/tmp'] }, { tmpfs: ['/tmp'] }]) {
          assert.throws(() => checkRestrictions({ ...service, ...mutation }))
        }
      }
    }
  }
})

test('both profiles require a nonempty setup token before starting containers', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const token of [undefined, '']) {
      const result = spawnSync('docker', args(profile), { cwd, env: { ...env, FUKULOW_SETUP_TOKEN: token }, encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /FUKULOW_SETUP_TOKEN/)
    }
  }
})

test('the shipped deployment example cannot start either profile without a setup token', () => {
  for (const profile of ['caddy', 'nginx']) {
    const result = spawnSync('docker', ['compose', '--env-file', '.env.example', '-f', 'compose.yml', '--profile', profile, 'config'],
      { cwd, env: { PATH: process.env.PATH, POSTGRES_APP_PASSWORD: env.POSTGRES_APP_PASSWORD, FUKULOW_VERSION: env.FUKULOW_VERSION }, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FUKULOW_SETUP_TOKEN/)
  }
})

test('the send limit keeps the production default unless the environment overrides it', () => {
  const unset = JSON.parse(execFileSync('docker', args('caddy'), { cwd, env, encoding: 'utf8' })).services.app
  assert.equal(String(unset.environment.FUKULOW_SEND_BURST), '10')
  assert.equal(String(unset.environment.FUKULOW_SEND_REFILL_PER_SECOND), '1')
  const raised = JSON.parse(execFileSync('docker', args('caddy'), { cwd, env: { ...env, FUKULOW_SEND_BURST: '10000', FUKULOW_SEND_REFILL_PER_SECOND: '1000' }, encoding: 'utf8' })).services.app
  assert.equal(String(raised.environment.FUKULOW_SEND_BURST), '10000')
  assert.equal(String(raised.environment.FUKULOW_SEND_REFILL_PER_SECOND), '1000')
})

test('app pool settings forward defaults, overrides and invalid empty values only to app', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const overrides of [{}, { FUKULOW_DB_MAX_CONNECTIONS: '3', FUKULOW_DB_ACQUIRE_TIMEOUT_MS: '250' },
      { FUKULOW_DB_MAX_CONNECTIONS: '', FUKULOW_DB_ACQUIRE_TIMEOUT_MS: '' }]) {
      const config = JSON.parse(execFileSync('docker', args(profile),
        { cwd, env: { ...env, ...overrides }, encoding: 'utf8' }))
      for (const [name, fallback] of [['FUKULOW_DB_MAX_CONNECTIONS', '20'], ['FUKULOW_DB_ACQUIRE_TIMEOUT_MS', '5000']]) {
        assert.equal(config.services.app.environment[name], overrides[name as keyof typeof overrides] ?? fallback)
        assert.equal(config.services.migrate.environment[name], undefined)
      }
    }
  }
})
