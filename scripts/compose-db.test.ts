import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cwd, env, args, checkRestrictions } from './compose-test-helpers.ts'

test('both profiles require bundled passwords and keep owner credentials outside app', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const key of ['POSTGRES_APP_PASSWORD', 'POSTGRES_PASSWORD']) {
      for (const password of [undefined, '']) {
        const result = spawnSync('docker', args(profile), { cwd, env: { ...env, [key]: password }, encoding: 'utf8' })
        assert.notEqual(result.status, 0)
        assert.ok(result.stderr.includes(key))
      }
    }
    const { services: { app, migrate } } = JSON.parse(execFileSync('docker', args(profile), { cwd, env, encoding: 'utf8' }))
    assert.equal(app.environment.DATABASE_URL, `postgres://fukulow_app:${env.POSTGRES_APP_PASSWORD}@db:5432/fukulow`)
    assert.equal(app.environment.FUKULOW_SEARCH_ENGINE, 'disabled')
    assert.ok(!Object.values(app.environment).some(value => String(value).includes(env.POSTGRES_PASSWORD)))
    assert.equal(app.environment.POSTGRES_APP_PASSWORD, undefined)
    assert.equal(app.environment.POSTGRES_PASSWORD, undefined)
    assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
    assert.deepEqual(Object.keys(migrate.networks), ['backend'])
    assert.equal(migrate.environment.DATABASE_URL, `postgres://fukulow:${env.POSTGRES_PASSWORD}@db:5432/fukulow`)
    assert.equal(migrate.depends_on.db.condition, 'service_healthy')
    assert.deepEqual(migrate.entrypoint, ['fukulow-server', 'migrate'])
    assert.deepEqual(migrate.command, [])
    assert.equal(migrate.restart, 'no')
  }
})

test('leftover external database URLs block bundled startup for either proxy', () => {
  const checkHealth = (db: { healthcheck: { test: string[] } }) => {
    const [mode, command] = db.healthcheck.test
    assert.equal(mode, 'CMD-SHELL')
    return spawnSync('/bin/sh', ['-c', `pg_isready() { return 0; }; ${command}`], { encoding: 'utf8' })
  }
  const leftoverUrl = 'postgres://user:leftover-db-test-only@postgres.example.test/chat'
  for (const profile of ['caddy', 'nginx']) {
    const bundled = JSON.parse(execFileSync('docker', args(profile), { cwd, env, encoding: 'utf8' }))
    assert.equal(checkHealth(bundled.services.db).status, 0)
    for (const [urlKey, passwordKey] of [
      ['FUKULOW_APP_DATABASE_URL', 'POSTGRES_APP_PASSWORD'],
      ['FUKULOW_MIGRATE_DATABASE_URL', 'POSTGRES_PASSWORD'],
    ] as const) {
      for (const password of [env[passwordKey], undefined, '']) {
        const result = spawnSync('docker', args(profile), {
          cwd, env: { ...env, [urlKey]: leftoverUrl, [passwordKey]: password }, encoding: 'utf8',
        })
        if (result.status !== 0) {
          assert.match(result.stderr, new RegExp(`${urlKey}|${passwordKey}`))
          continue
        }
        const { app, db, migrate } = JSON.parse(result.stdout).services
        assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
        assert.equal(migrate.depends_on.db.condition, 'service_healthy')
        assert.ok(!JSON.stringify(db).includes('leftover-db-test-only'))
        const health = checkHealth(db)
        assert.equal(health.status, 1)
        assert.match(health.stderr, new RegExp(urlKey))
      }
    }
  }
})

test('external PostgreSQL removes bundled resources and requires separate URLs for either proxy', () => {
  const externalEnv = {
    PATH: env.PATH, COMPOSE_PROJECT_NAME: env.COMPOSE_PROJECT_NAME, FUKULOW_SETUP_TOKEN: env.FUKULOW_SETUP_TOKEN, FUKULOW_VERSION: env.FUKULOW_VERSION,
    FUKULOW_APP_DATABASE_URL: 'postgres://fukulow_app:external-app-test-only@postgres.example.test:1532/chat?sslmode=verify-full',
    FUKULOW_MIGRATE_DATABASE_URL: 'postgres://owner:external-owner-test-only@postgres.example.test:1532/chat?sslmode=verify-full',
  }
  for (const profile of ['caddy', 'nginx']) {
    const { services, volumes } = JSON.parse(execFileSync('docker', args(profile, true), { cwd, env: externalEnv, encoding: 'utf8' }))
    assert.deepEqual(Object.keys(services).sort(), ['app', 'migrate', profile].sort())
    assert.equal(volumes.postgres_data, undefined)
    const { app, migrate } = services
    assert.equal(app.environment.DATABASE_URL, externalEnv.FUKULOW_APP_DATABASE_URL)
    assert.equal(app.environment.FUKULOW_SEARCH_ENGINE, 'disabled')
    assert.equal(migrate.environment.DATABASE_URL, externalEnv.FUKULOW_MIGRATE_DATABASE_URL)
    assert.equal(migrate.depends_on, undefined)
    assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
    for (const [service, forbidden] of [[app, 'external-owner-test-only'], [migrate, 'external-app-test-only']] as const) {
      assert.ok(!Object.values(service.environment).some(value => String(value).includes(forbidden)))
      assert.equal(service.environment.POSTGRES_PASSWORD, undefined)
      assert.equal(service.environment.POSTGRES_APP_PASSWORD, undefined)
      assert.equal(service.environment.PGSSLMODE, 'verify-full')
      assert.equal(service.ports, undefined)
      checkRestrictions(service)
    }
    for (const key of ['FUKULOW_APP_DATABASE_URL', 'FUKULOW_MIGRATE_DATABASE_URL']) {
      for (const url of [undefined, '']) {
        const result = spawnSync('docker', args(profile, true), { cwd, env: { ...env, ...externalEnv, [key]: url }, encoding: 'utf8' })
        assert.notEqual(result.status, 0)
        assert.ok(result.stderr.includes(key))
      }
    }
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
