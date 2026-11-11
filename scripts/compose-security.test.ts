import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const env = { PATH: process.env.PATH, POSTGRES_PASSWORD: 'compose-config-test-only', FUKULOW_SETUP_TOKEN: 'setup-config-test-only' }
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
    LOAD_DB_PASSWORD: 'load-db-test-only', LOAD_SETUP_TOKEN: 'load-setup-test-only' }
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
      { cwd, env: { PATH: process.env.PATH }, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FUKULOW_SETUP_TOKEN/)
  }
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
