import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildIndex, imageFailures, imageRepository, indexType, readLayout, workspaceLicense, type Expected } from './release-oci.ts'
import { sha, layout, release } from './release-test-helpers.ts'

const expected: Expected = { architecture: 'amd64', version: '1.2.3', revision: sha, license: 'MIT OR Apache-2.0' }

test('release images are linux, non-root and carry source, version, revision and license labels', () => {
  assert.deepEqual(imageFailures(readLayout(layout('amd64')), expected), [])
  const broken: [string, (config: Record<string, any>) => void, RegExp][] = [
    ['root user', config => { delete config.config.User }, /image user/],
    ['uid 0', config => { config.config.User = '0:0' }, /image user/],
    ['wrong arch', config => { config.architecture = 'arm64' }, /platform/],
    ['wrong os', config => { config.os = 'windows' }, /platform/],
    ['no revision', config => { delete config.config.Labels['org.opencontainers.image.revision'] }, /label org.opencontainers.image.revision/],
    ['other license', config => { config.config.Labels['org.opencontainers.image.licenses'] = 'GPL-3.0' }, /licenses/],
    ['other version', config => { config.config.Labels['org.opencontainers.image.version'] = '1.2.4' }, /version/],
    ['other source', config => { config.config.Labels['org.opencontainers.image.source'] = 'https://example.com/x' }, /source/],
  ]
  for (const [name, change, pattern] of broken) assert.match(imageFailures(readLayout(layout('amd64', change)), expected).join(), pattern, name)
})

test('a layout with a tampered blob, several manifests or a nested index is rejected', () => {
  const tampered = layout('amd64')
  const index = JSON.parse(readFileSync(join(tampered, 'index.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(tampered, 'blobs', 'sha256', index.manifests[0].digest.slice(7)), 'utf8'))
  writeFileSync(join(tampered, 'blobs', 'sha256', manifest.layers[0].digest.slice(7)), 'changed')
  assert.throws(() => readLayout(tampered), /does not match/)
  const two = layout('amd64')
  const twoIndex = JSON.parse(readFileSync(join(two, 'index.json'), 'utf8'))
  writeFileSync(join(two, 'index.json'), JSON.stringify({ ...twoIndex, manifests: [...twoIndex.manifests, ...twoIndex.manifests] }))
  assert.throws(() => readLayout(two), /exactly one/)
  writeFileSync(join(two, 'index.json'), JSON.stringify({ ...twoIndex, manifests: [{ ...twoIndex.manifests[0], mediaType: indexType }] }))
  assert.throws(() => readLayout(two), /exactly one/)
})

test('docker load must load the checked image: manifest.json names exactly the index.json image', () => {
  const other = layout('arm64', config => { config.architecture = 'arm64' })
  const otherEntries = readFileSync(join(other, 'manifest.json'), 'utf8')
  const directory = layout('amd64')
  const entries = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  for (const changed of [JSON.parse(otherEntries), [...entries, ...entries], [{ ...entries[0], Layers: [] }],
    [{ ...entries[0], Config: entries[0].Layers[0] }]]) {
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(changed))
    assert.throws(() => readLayout(directory), /manifest.json must name exactly/)
  }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(entries))
  assert.equal(readLayout(directory).config.architecture, 'amd64')
})

test('the image license comes from the workspace package and is required', () => {
  assert.equal(workspaceLicense('[workspace]\nmembers = []\n\n[workspace.package]\nedition = "2024"\nlicense = "MIT OR Apache-2.0"\n'), 'MIT OR Apache-2.0')
  assert.equal(workspaceLicense('[workspace]\nmembers = []\n'), undefined)
  assert.equal(workspaceLicense('[workspace.package]\nedition = "2024"\n[package]\nlicense = "MIT"\n'), undefined)
})

test('the index is deterministic and names the repository Compose pulls', () => {
  const amd64 = readLayout(layout('amd64'))
  const descriptor = { ...amd64.manifest, platform: { architecture: 'amd64', os: 'linux' } }
  assert.deepEqual(buildIndex([descriptor], release), buildIndex([descriptor], release))
  assert.match(readFileSync(new URL('../compose.yml', import.meta.url), 'utf8'),
    new RegExp(`^    image: ${imageRepository.replaceAll('.', '\\.')}:\\$\\{FUKULOW_VERSION:\\?`, 'm'))
})
