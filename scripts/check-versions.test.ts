import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkVersions } from './check-versions.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const files = { rust: read('rust-toolchain.toml'), node: read('.node-version'),
  webNode: JSON.parse(read('web/package.json')).engines.node,
  loadNode: JSON.parse(read('load/package.json')).engines.node, dockerfile: read('Dockerfile') }

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
