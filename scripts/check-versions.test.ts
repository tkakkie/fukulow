import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkInventory, checkVersions, type Entry } from './check-versions.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const files = { rust: read('rust-toolchain.toml'), node: read('.node-version'),
  webNode: JSON.parse(read('web/package.json')).engines.node,
  loadNode: JSON.parse(read('load/package.json')).engines.node, dockerfile: read('Dockerfile'),
  playwright: JSON.parse(read('web/package.json')).devDependencies['@playwright/test'],
  webLock: read('web/package-lock.json'), e2e: read('.github/workflows/e2e.yml'),
  makefile: read('Makefile'), dmsRecord: read('load/dms-record.ts'),
  compose: read('compose.yml'), acme: read('scripts/compose-acme.ts'), core: read('client-core/Cargo.toml'), wasmBuild: read('scripts/build-wasm.ts'), ci: read('.github/workflows/ci.yml') }

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

test('k6 pins must agree on tag and digest', () => {
  assert.throws(() => checkVersions({ ...files,
    dmsRecord: files.dmsRecord.replace(/grafana\/k6:\d+\.\d+\.\d+@/, 'grafana/k6:0.0.0@') }), /k6 image must match/)
  assert.throws(() => checkVersions({ ...files,
    dmsRecord: files.dmsRecord.replace(/@sha256:[a-f0-9]{64}/, `@sha256:${'0'.repeat(64)}`) }), /k6 image must match/)
  assert.throws(() => checkVersions({ ...files,
    makefile: files.makefile.replace(/@sha256:[a-f0-9]{64}/, ''),
    dmsRecord: files.dmsRecord.replace(/@sha256:[a-f0-9]{64}/, '') }), /must pin exact tag and digest/)
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

test('nginx ACME ABI and Pebble require exact matching pins', () => {
  for (const image of ['nginx:latest', 'nginx:1.31.8', `nginx:1.31.8@sha256:bad`]) {
    assert.throws(() => checkVersions({ ...files, compose: files.compose.replace(/nginx:\d+\.\d+\.\d+@sha256:[a-f0-9]+/, image) }), /nginx image must pin/)
  }
  for (const version of ['1.0.0+0.4.1-1~trixie', '1.31.8+latest-1~trixie', 'latest']) {
    assert.throws(() => checkVersions({ ...files, compose: files.compose.replace(/NGINX_ACME_PACKAGE_VERSION: \S+/, `NGINX_ACME_PACKAGE_VERSION: ${version}`) }), /ACME package/)
  }
  assert.throws(() => checkVersions({ ...files, compose: files.compose.replace(/\s+NGINX_ACME_PACKAGE_VERSION: \S+/, '') }), /exactly one ACME/)
  assert.throws(() => checkVersions({ ...files, compose: files.compose + '\n    NGINX_ACME_PACKAGE_VERSION: duplicate\n' }), /exactly one ACME/)
  for (const pin of ['latest', '2.8.0', '2.8.0@sha256:bad', `2.8.0@sha256:${'a'.repeat(65)}`]) {
    assert.throws(() => checkVersions({ ...files, acme: files.acme.replace(/ghcr\.io\/letsencrypt\/pebble:[^']+/, `ghcr.io/letsencrypt/pebble:${pin}`) }), /Pebble must pin/)
  }
})

test('wasm target must stay pinned in the Rust toolchain', () => {
  for (const rust of [files.rust.replace(/^targets = .*$/m, ''), files.rust.replace('wasm32-unknown-unknown', 'wasm32-wasip1')]) {
    assert.throws(() => checkVersions({ ...files, rust }), /targets must include wasm32-unknown-unknown/)
  }
})

test('wasm-bindgen library and locked CLI installs must agree', () => {
  assert.throws(() => checkVersions({ ...files, core: files.core.replace('=0.2.130', '^0.2.130') }), /exact version/)
  for (const name of ['dockerfile', 'ci', 'e2e'] as const) {
    const source = files[name]
    assert.throws(() => checkVersions({ ...files, [name]: source.replaceAll('--version 0.2.130', '--version 0.2.129').replaceAll('wasm-bindgen@0.2.130', 'wasm-bindgen@0.2.129') }), /CLI must agree/)
    assert.throws(() => checkVersions({ ...files, [name]: source.replaceAll(/cargo install wasm-bindgen-cli[^\n]+/g, '').replaceAll(/tool: wasm-bindgen@[^\n]+/g, '') }), /must install/)
  }
  for (const name of ['ci', 'e2e'] as const) {
    // An unpinned tool or a leftover source build must not hide behind one pinned install.
    assert.throws(() => checkVersions({ ...files, [name]: files[name].replace('tool: wasm-bindgen@0.2.130 }', 'tool: wasm-bindgen }') }), /must install|pinned form/)
    assert.throws(() => checkVersions({ ...files, [name]: `${files[name]}\n      - run: cargo install wasm-bindgen-cli` }), /pinned form/)
  }
  assert.throws(() => checkVersions({ ...files, wasmBuild: files.wasmBuild.replaceAll("'--locked'", '') }), /must use --locked/)
})

const inventory: Entry[] = JSON.parse(read('versions.json')).entries

test('inventory versions agree with their pinned files', () => {
  checkInventory(inventory, read)
})

test('inventory rejects version drift, ambiguous patterns and missing components', () => {
  const changed = (index: number, change: Partial<Entry>) => inventory.map((entry, at) => at === index ? { ...entry, ...change } : entry)
  for (const index of inventory.keys()) {
    assert.throws(() => checkInventory(changed(index, { version: '0.0.0-drift' }), read), /version must agree/)
  }
  const rust = inventory.findIndex(entry => entry.component === 'Rust')
  assert.throws(() => checkInventory(inventory, path => path === 'rust-toolchain.toml' ? 'channel = "0.0.1"\n' : read(path)), /version must agree/)
  assert.throws(() => checkInventory(changed(rust, { pattern: '"' }), read), /exactly once/)
  assert.throws(() => checkInventory(changed(rust, { pattern: 'no such pin (\\S+)' }), read), /exactly once/)
  assert.throws(() => checkInventory(inventory.filter(entry => entry.component !== 'k6'), read), /must cover k6/)
  assert.throws(() => checkInventory([...inventory, inventory[0]], read), /unique/)
  assert.throws(() => checkInventory(changed(rust, { support: 'soon' }), read), /support must be/)
  assert.throws(() => checkInventory(changed(rust, { updates: 'renovate' }), read), /unknown updates/)
  assert.throws(() => checkInventory(changed(rust, { class: 'minor' }), read), /unknown update class/)
  assert.throws(() => checkInventory(changed(rust, { latest: undefined }), read), /weekly-check entries/)
  const caddy = inventory.findIndex(entry => entry.component === 'Caddy')
  assert.throws(() => checkInventory(changed(caddy, { latest: { github: 'caddyserver/caddy' } }), read), /weekly-check entries/)
})
