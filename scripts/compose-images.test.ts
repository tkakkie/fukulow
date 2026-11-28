import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { cwd, env, args } from './compose-test-helpers.ts'

function checkBaseImages(dockerfile: string) {
  const stages = new Set<string>()
  for (const [, image, stage] of dockerfile.matchAll(/^FROM (\S+)(?: AS (\S+))?$/gmi)) {
    if (!stages.has(image.toLowerCase())) assert.match(image, /^\w+:[\w.-]+@sha256:[a-f0-9]{64}$/, 'base image must pin tag and digest')
    if (stage) stages.add(stage.toLowerCase())
  }
}

// The release image is selected by the operator's FUKULOW_VERSION (an immutable SemVer tag,
// optionally with the digest from its release notes); every other external image pins tag and digest.
const releaseImage = /^ghcr\.io\/tkakkie\/fukulow:\d+\.\d+\.\d+(?:-[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/
function checkImagesAndLogs(services: Record<string, { build?: unknown, image: string, logging: unknown }>) {
  const builtImages = new Set(Object.values(services).filter(service => service.build).map(service => service.image))
  for (const [name, service] of Object.entries(services)) {
    const release = ['app', 'migrate'].includes(name) && releaseImage.test(service.image)
    if (!builtImages.has(service.image) && !release) assert.match(service.image, /^[\w/.-]+:[\w.-]+@sha256:[a-f0-9]{64}$/, `${name} must pin tag and digest`)
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
      if (file === 'compose.yml') {
        // Only app and migrate may use the release image, and only with a SemVer tag.
        for (const [name, image] of [['app', 'ghcr.io/tkakkie/fukulow:latest'], ['app', 'ghcr.io/tkakkie/fukulow'],
          ['app', 'ghcr.io/other/fukulow:1.2.3'], ['db', 'ghcr.io/tkakkie/fukulow:1.2.3']]) {
          const broken = structuredClone(config.services)
          broken[name].image = image
          assert.throws(() => checkImagesAndLogs(broken), /must pin/, `${name} ${image}`)
        }
      }
    }
  }
})

test('base image check rejects an unpinned Dockerfile base', () => {
  for (const source of ['FROM debian:bookworm-slim\n', 'FROM missing AS server',
    'FROM base AS server\nFROM debian:bookworm-slim AS base',
    'FROM debian:bookworm-slim AS base\nFROM base AS server']) {
    assert.throws(() => checkBaseImages(source), /base image must pin tag and digest/)
  }
  checkBaseImages('FROM rust:1.99.1-slim@sha256:' + 'a'.repeat(64) + ' AS base\nFROM base AS wasm\nFROM wasm AS server')
})

test('deployment Compose runs the required FUKULOW_VERSION release and builds from source only through compose.dev.yml', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const version of [undefined, '']) {
      const result = spawnSync('docker', args(profile), { cwd, env: { ...env, FUKULOW_VERSION: version }, encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /FUKULOW_VERSION/)
    }
    const release = JSON.parse(execFileSync('docker', args(profile), { cwd, env, encoding: 'utf8' })).services
    for (const name of ['app', 'migrate']) assert.equal(release[name].image, 'ghcr.io/tkakkie/fukulow:1.2.3', name)
    for (const [name, service] of Object.entries(release)) assert.equal((service as { build?: unknown }).build, undefined, `${name} must not build`)
    const pinned = `1.2.3@sha256:${'a'.repeat(64)}`
    const digest = JSON.parse(execFileSync('docker', args(profile), { cwd, env: { ...env, FUKULOW_VERSION: pinned }, encoding: 'utf8' })).services
    assert.equal(digest.app.image, `ghcr.io/tkakkie/fukulow:${pinned}`)
    const devArgs = [...args(profile).slice(0, 5), '-f', 'compose.dev.yml', ...args(profile).slice(5)]
    const dev = JSON.parse(execFileSync('docker', devArgs, { cwd, env, encoding: 'utf8' })).services
    assert.equal(dev.app.build.context, cwd.replace(/\/$/, ''))
    for (const name of ['app', 'migrate']) assert.equal(dev[name].image, 'fukulow-app', name)
  }
  // The shipped example leaves the version empty, so copying it never starts an implicit release.
  const example = spawnSync('docker', ['compose', '--env-file', '.env.example', '-f', 'compose.yml', '--profile', 'caddy', 'config'],
    { cwd, env: { PATH: process.env.PATH, POSTGRES_APP_PASSWORD: env.POSTGRES_APP_PASSWORD, FUKULOW_SETUP_TOKEN: env.FUKULOW_SETUP_TOKEN }, encoding: 'utf8' })
  assert.notEqual(example.status, 0)
  assert.match(example.stderr, /FUKULOW_VERSION/)
  // The disposable load stack still builds the app from source.
  const load = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', 'load/compose.yml', 'config', '--format', 'json'],
    { cwd, env: { PATH: process.env.PATH, LOAD_PROJECT: 'release-config-test', LOAD_PORT: '18195', LOAD_DB_PASSWORD: 'owner-test-only',
      LOAD_APP_PASSWORD: 'app-test-only', LOAD_SETUP_TOKEN: 'setup-test-only' }, encoding: 'utf8' })).services
  assert.equal(load.app.build.context, cwd.replace(/\/$/, ''))
})
