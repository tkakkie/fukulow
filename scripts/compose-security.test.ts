import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const env = { PATH: process.env.PATH, POSTGRES_PASSWORD: 'compose-config-test-only', POSTGRES_APP_PASSWORD: 'app-config-test-only', FUKULOW_SETUP_TOKEN: 'setup-config-test-only' }
const args = (profile: string) => ['compose', '--env-file', '/dev/null', '-f', 'compose.yml', '--profile', profile, 'config', '--format', 'json']

function checkBaseImages(dockerfile: string) {
  const bases = dockerfile.matchAll(/^FROM (\S+)/gm)
  for (const [, image] of bases) assert.match(image, /^\w+:[\w.-]+@sha256:[a-f0-9]{64}$/, 'base image must pin tag and digest')
}

function checkImagesAndLogs(services: Record<string, { build?: unknown, image: string, logging: unknown }>) {
  const builtImages = new Set(Object.values(services).filter(service => service.build).map(service => service.image))
  for (const [name, service] of Object.entries(services)) {
    if (!builtImages.has(service.image)) assert.match(service.image, /^[\w/.-]+:[\w.-]+@sha256:[a-f0-9]{64}$/, `${name} must pin tag and digest`)
    assert.deepEqual(service.logging, { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } }, `${name} must rotate logs`)
  }
}

test('all base images and external Compose images are pinned; every deployment/load service rotates logs', () => {
  checkBaseImages(readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8'))
  const loadEnv = { ...env, LOAD_PROJECT: 'config-test-only', LOAD_PORT: '18080',
    LOAD_DB_PASSWORD: 'load-db-test-only', LOAD_APP_PASSWORD: 'load-app-test-only', LOAD_SETUP_TOKEN: 'load-setup-test-only' }
  for (const file of ['compose.yml', 'load/compose.yml']) {
    for (const profileArgs of file === 'compose.yml' ? [['--profile', 'caddy'], ['--profile', 'nginx']] : [[]]) {
      const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', file,
        ...profileArgs, 'config', '--format', 'json'], { cwd, env: loadEnv, encoding: 'utf8' }))
      checkImagesAndLogs(config.services)
      for (const mutation of ['pin', 'rotation']) {
        const broken = structuredClone(config.services)
        if (mutation === 'pin') broken.db.image = broken.db.image.split('@')[0]
        else delete broken.db.logging.options['max-file']
        assert.throws(() => checkImagesAndLogs(broken), mutation === 'pin' ? /must pin/ : /must rotate/)
      }
    }
  }
})

test('base image check rejects an unpinned Dockerfile base', () => {
  assert.throws(() => checkBaseImages('FROM debian:bookworm-slim\n'), /base image must pin tag and digest/)
})

test('upgrade rehearsal pins both old images for the post-merge Compose shape', () => {
  // HEAD is available even in CI's shallow checkout and has the post-merge shape.
  const output = execFileSync(process.execPath, ['scripts/check-db-upgrade.ts', '--check-config'],
    { cwd, env: { PATH: process.env.PATH, CHECK_UPGRADE_REVISION: 'HEAD' }, encoding: 'utf8' })
  assert.match(output, /PASS old stack images: app=.+ migrate=true/)
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
      { cwd, env: { PATH: process.env.PATH, POSTGRES_APP_PASSWORD: env.POSTGRES_APP_PASSWORD }, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FUKULOW_SETUP_TOKEN/)
  }
})

test('both profiles require an app password and keep owner credentials outside app', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const password of [undefined, '']) {
      const result = spawnSync('docker', args(profile), { cwd, env: { ...env, POSTGRES_APP_PASSWORD: password }, encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /POSTGRES_APP_PASSWORD/)
    }
    const { services: { app, migrate } } = JSON.parse(execFileSync('docker', args(profile), { cwd, env, encoding: 'utf8' }))
    assert.equal(app.environment.DATABASE_URL, `postgres://fukulow_app:${env.POSTGRES_APP_PASSWORD}@db:5432/fukulow`)
    assert.ok(!Object.values(app.environment).some(value => String(value).includes(env.POSTGRES_PASSWORD)))
    assert.equal(app.environment.POSTGRES_APP_PASSWORD, undefined)
    assert.equal(app.environment.POSTGRES_PASSWORD, undefined)
    assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
    assert.deepEqual(Object.keys(migrate.networks), ['backend'])
    assert.equal(migrate.environment.DATABASE_URL, `postgres://fukulow:${env.POSTGRES_PASSWORD}@db:5432/fukulow`)
    assert.deepEqual(migrate.entrypoint, ['fukulow-server', 'migrate'])
    assert.deepEqual(migrate.command, [])
    assert.equal(migrate.restart, 'no')
  }
})

test('the disposable load stack also separates owner migrations from app credentials', () => {
  const loadEnv = { PATH: process.env.PATH, LOAD_PROJECT: 'roles-config-test', LOAD_PORT: '18194',
    LOAD_DB_PASSWORD: 'load-owner-config-test-only', LOAD_APP_PASSWORD: 'load-app-config-test-only',
    LOAD_SETUP_TOKEN: 'load-setup-config-test-only' }
  const loadArgs = ['compose', '--env-file', '/dev/null', '-f', 'load/compose.yml', 'config', '--format', 'json']
  const { services: { app, migrate } } = JSON.parse(execFileSync('docker', loadArgs, { cwd, env: loadEnv, encoding: 'utf8' }))
  assert.equal(app.environment.DATABASE_URL, `postgres://fukulow_app:${loadEnv.LOAD_APP_PASSWORD}@db:5432/fukulow`)
  assert.equal(migrate.environment.DATABASE_URL, `postgres://fukulow:${loadEnv.LOAD_DB_PASSWORD}@db:5432/fukulow`)
  assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
  const result = spawnSync('docker', loadArgs, { cwd, env: { ...loadEnv, LOAD_APP_PASSWORD: undefined }, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /LOAD_APP_PASSWORD/)
})

test('the send limit keeps the production default unless the environment overrides it', () => {
  const unset = JSON.parse(execFileSync('docker', args('caddy'), { cwd, env, encoding: 'utf8' })).services.app
  assert.equal(String(unset.environment.FUKULOW_SEND_BURST), '10')
  assert.equal(String(unset.environment.FUKULOW_SEND_REFILL_PER_SECOND), '1')
  const raised = JSON.parse(execFileSync('docker', args('caddy'), { cwd, env: { ...env, FUKULOW_SEND_BURST: '10000', FUKULOW_SEND_REFILL_PER_SECOND: '1000' }, encoding: 'utf8' })).services.app
  assert.equal(String(raised.environment.FUKULOW_SEND_BURST), '10000')
  assert.equal(String(raised.environment.FUKULOW_SEND_REFILL_PER_SECOND), '1000')
})

test('both profiles isolate the database and trust only the fixed proxy IP, including custom prefixes', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const prefix of ['172.30.94', '172.29.193']) {
      const config = JSON.parse(execFileSync('docker', args(profile), { cwd, env: { ...env, FUKULOW_EDGE_PREFIX: prefix }, encoding: 'utf8' }))
      const { app, db } = config.services
      assert.equal(app.ports, undefined)
      assert.deepEqual(Object.keys(app.networks).sort(), ['backend', 'edge'])
      assert.equal(app.networks.edge.ipv4_address, `${prefix}.3`)
      assert.deepEqual(Object.keys(db.networks), ['backend'])
      assert.equal(db.ports, undefined)
      assert.deepEqual(Object.keys(config.services[profile].networks), ['edge'])
      assert.equal(config.services[profile].networks.edge.ipv4_address, `${prefix}.2`)
      assert.equal(app.environment.FUKULOW_TRUSTED_PROXIES, `${prefix}.2`)
      assert.equal(app.environment.FUKULOW_CLIENT_IP_HEADER, 'x-forwarded-for')
      assert.deepEqual(config.networks.edge.ipam.config, [{ subnet: `${prefix}.0/29`, gateway: `${prefix}.1`, ip_range: `${prefix}.4/30` }])
    }
  }
})

test('app pool settings forward defaults, overrides and invalid empty values only to app', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const overrides of [{}, { FUKULOW_DB_MAX_CONNECTIONS: '3', FUKULOW_DB_ACQUIRE_TIMEOUT_MS: '250' },
      { FUKULOW_DB_MAX_CONNECTIONS: '', FUKULOW_DB_ACQUIRE_TIMEOUT_MS: '' }]) {
      const config = JSON.parse(execFileSync('docker', args(profile),
        { cwd, env: { ...env, ...overrides }, encoding: 'utf8' }))
      for (const [name, fallback] of [['FUKULOW_DB_MAX_CONNECTIONS', '20'], ['FUKULOW_DB_ACQUIRE_TIMEOUT_MS', '1000']]) {
        assert.equal(config.services.app.environment[name], overrides[name as keyof typeof overrides] ?? fallback)
        assert.equal(config.services.migrate.environment[name], undefined)
      }
    }
  }
})
