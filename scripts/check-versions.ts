import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export function checkVersions(files: { rust: string, node: string, webNode: string, loadNode: string, dockerfile: string }): void {
  const rust = files.rust.match(/^channel = "([^"]+)"$/m)?.[1]
  const node = files.node.trim()
  assert.ok(rust && /^\d+\.\d+\.\d+$/.test(rust), 'Rust must name an exact patch version')
  assert.match(node, /^\d+\.\d+\.\d+$/, 'Node must name an exact patch version')
  for (const [image, version] of [['rust', rust], ['node', node]]) {
    const from = files.dockerfile.split('\n').filter(line => line.startsWith(`FROM ${image}:`))
    assert.equal(from.length, 1, `Dockerfile must have exactly one ${image} base`)
    const reference = from[0].split(/\s+/)[1]
    assert.equal(reference.split('@')[0], `${image}:${version}-slim`, `${image} version must agree with the toolchain`)
    assert.match(reference, /^[^@]+(?:@sha256:[a-f0-9]{64})?$/, `${image} digest must be sha256 with 64 hex digits`)
  }
  assert.equal(files.webNode, node, 'web engines.node must agree with .node-version')
  assert.equal(files.loadNode, node, 'load engines.node must agree with .node-version')
}

if (import.meta.main) {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  checkVersions({ rust: read('rust-toolchain.toml'), node: read('.node-version'),
    webNode: JSON.parse(read('web/package.json')).engines.node,
    loadNode: JSON.parse(read('load/package.json')).engines.node, dockerfile: read('Dockerfile') })
}
