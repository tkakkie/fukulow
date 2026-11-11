import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkVersions } from './check-versions.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const files = { rust: read('rust-toolchain.toml'), node: read('.node-version'),
  webNode: JSON.parse(read('web/package.json')).engines.node,
  loadNode: JSON.parse(read('load/package.json')).engines.node, dockerfile: read('Dockerfile'),
  playwright: JSON.parse(read('web/package.json')).devDependencies['@playwright/test'],
  webLock: read('web/package-lock.json'), e2e: read('.github/workflows/e2e.yml') }

test('versions agree with tag-only and tag-plus-digest Docker bases', () => {
  checkVersions(files)
  checkVersions({ ...files, dockerfile: files.dockerfile.replaceAll(/@sha256:[a-f0-9]{64}/g, '') })
})

test('digest suffix cannot hide a mismatched Node or Rust version', () => {
  for (const image of ['node', 'rust']) {
    assert.throws(() => checkVersions({ ...files,
      dockerfile: files.dockerfile.replace(new RegExp(`FROM ${image}:[^@ ]+`), `FROM ${image}:0.0.0-slim`) }), /version must agree/)
  }
})

test('version check rejects malformed digests, duplicate bases and engine drift', () => {
  assert.throws(() => checkVersions({ ...files, dockerfile: files.dockerfile.replace(/@sha256:[a-f0-9]{64}/, '@sha256:bad') }), /digest must/)
  assert.throws(() => checkVersions({ ...files, dockerfile: `${files.dockerfile}\nFROM node:0.0.0-slim AS duplicate` }), /exactly one node/)
  for (const engine of ['webNode', 'loadNode']) {
    assert.throws(() => checkVersions({ ...files, [engine]: '0.0.0' }), /engines.node must agree/)
  }
})

test('Playwright image rejects version drift, floating tags and a different Ubuntu base', () => {
  for (const tag of ['v0.0.0-noble', 'latest', `v${files.playwright}-jammy`]) {
    assert.throws(() => checkVersions({ ...files,
      e2e: files.e2e.replace(/mcr\.microsoft\.com\/playwright:\S+/, `mcr.microsoft.com/playwright:${tag}`) }), /Playwright image must agree/)
  }
  assert.throws(() => checkVersions({ ...files, playwright: `^${files.playwright}` }), /exact patch version/)
  assert.throws(() => checkVersions({ ...files, e2e: '' }), /exactly one PLAYWRIGHT_IMAGE/)
  assert.throws(() => checkVersions({ ...files, e2e: `${files.e2e}\n      PLAYWRIGHT_IMAGE: duplicate` }), /exactly one PLAYWRIGHT_IMAGE/)
})

test('Playwright image requires a valid sha256 digest', () => {
  for (const digest of ['', '@sha256:bad', `@sha256:${'a'.repeat(63)}`, `@sha256:${'a'.repeat(65)}`, `@sha256:${'g'.repeat(64)}`, `@sha512:${'a'.repeat(64)}`]) {
    assert.throws(() => checkVersions({ ...files,
      e2e: files.e2e.replace(/mcr\.microsoft\.com\/playwright:\S+/, `mcr.microsoft.com/playwright:v${files.playwright}-noble${digest}`) }), /Playwright image digest must/)
  }
})

test('Playwright manifest and installed lockfile versions cannot drift', () => {
  const lock = JSON.parse(files.webLock)
  lock.packages[''].devDependencies['@playwright/test'] = '0.0.0'
  assert.throws(() => checkVersions({ ...files, webLock: JSON.stringify(lock) }), /lockfile declaration must agree/)
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    const changed = JSON.parse(files.webLock)
    changed.packages[`node_modules/${name}`].version = '0.0.0'
    assert.throws(() => checkVersions({ ...files, webLock: JSON.stringify(changed) }), /lockfile version must agree/)
  }
})
