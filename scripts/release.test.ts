import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gateFailures, requiredWorkflows, type WorkflowRun } from './release-gate.ts'
import { buildIndex, imageFailures, imageRepository, indexType, readLayout, sha256, workspaceLicense, type Expected } from './release-oci.ts'
import { publish, registryClient } from './release-registry.ts'
import { releaseNotes } from './release-notes.ts'
import { compareVersions, parseTag, planRelease } from './release-version.ts'

test('release tags must be SemVer vX.Y.Z or vX.Y.Z-pre without build metadata', () => {
  for (const tag of ['v0.1.0', 'v1.2.3', 'v10.20.30', 'v1.0.0-rc.1', 'v1.0.0-alpha-1', 'v1.0.0-0.3.7', 'v1.0.0-x.7.z.92']) {
    assert.equal(parseTag(tag).version, tag.slice(1))
  }
  for (const tag of ['1.2.3', 'v1.2', 'v1.2.3.4', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3-', 'v1.2.3-01', 'v1.2.3-rc..1',
    'v1.2.3+build', 'v1.2.3-rc.1+build', 'v1.2.3-ü', 'vlatest', 'v1.2.3 ', `v1.2.3-${'a'.repeat(124)}`, 'v99999999999999999.0.0']) {
    assert.throws(() => parseTag(tag), /release tag/, tag)
  }
})

test('SemVer precedence ranks pre-releases below their release', () => {
  const ordered = ['v1.0.0-alpha', 'v1.0.0-alpha.1', 'v1.0.0-alpha.beta', 'v1.0.0-beta', 'v1.0.0-beta.2', 'v1.0.0-beta.11',
    'v1.0.0-rc.1', 'v1.0.0', 'v1.0.1', 'v1.1.0', 'v2.0.0']
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareVersions(parseTag(ordered[index - 1]), parseTag(ordered[index])), -1, ordered[index])
    assert.equal(compareVersions(parseTag(ordered[index]), parseTag(ordered[index - 1])), 1, ordered[index])
  }
})

test('a release moves X.Y and latest only forward; a pre-release never moves them', () => {
  assert.deepEqual(planRelease('v0.1.0', []), { version: '0.1.0', prerelease: false, tags: ['0.1.0', '0.1', 'latest'], latest: true })
  const existing = ['v0.1.0', 'v0.2.0-rc.1', 'v0.2.0', 'v0.3.0', 'not-a-version', 'v0.3.1-rc.1']
  assert.deepEqual(planRelease('v0.2.1', existing),
    { version: '0.2.1', prerelease: false, tags: ['0.2.1', '0.2'], latest: false, previous: 'v0.2.0' })
  assert.deepEqual(planRelease('v0.3.1', existing),
    { version: '0.3.1', prerelease: false, tags: ['0.3.1', '0.3', 'latest'], latest: true, previous: 'v0.3.0' })
  assert.deepEqual(planRelease('v0.4.0-rc.1', existing),
    { version: '0.4.0-rc.1', prerelease: true, tags: ['0.4.0-rc.1'], latest: false, previous: 'v0.3.1-rc.1' })
  assert.deepEqual(planRelease('v0.1.1', [...existing, 'v0.1.2']).tags, ['0.1.1'])
  // A re-run of the same tag plans the same tags.
  assert.deepEqual(planRelease('v0.3.0', existing).tags, ['0.3.0', '0.3', 'latest'])
})

const sha = 'a'.repeat(40)
const passing = (): WorkflowRun[] => requiredWorkflows.map((path, index) =>
  ({ id: index + 10, path, event: 'push', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success' }))

test('publishing requires the commit on main and successful main push CI', () => {
  assert.deepEqual(gateFailures(sha, 'ahead', passing()), [])
  assert.deepEqual(gateFailures(sha, 'identical', passing()), [])
  for (const status of ['diverged', 'behind']) assert.match(gateFailures(sha, status, passing()).join(), /not on main/)
  for (const path of requiredWorkflows) {
    assert.match(gateFailures(sha, 'ahead', passing().filter(run => run.path !== path)).join(), /no main push run/, path)
    for (const change of [{ conclusion: 'failure' }, { conclusion: null, status: 'in_progress' }, { conclusion: 'cancelled' }]) {
      const runs = passing().map(run => run.path === path ? { ...run, ...change } : run)
      assert.match(gateFailures(sha, 'ahead', runs).join(), /not completed\/success/, `${path} ${JSON.stringify(change)}`)
    }
    // Runs from a pull request, another branch or another commit never count.
    for (const change of [{ event: 'pull_request' }, { head_branch: 'feature' }, { head_sha: 'b'.repeat(40) }]) {
      const runs = passing().map(run => run.path === path ? { ...run, ...change } : run)
      assert.match(gateFailures(sha, 'ahead', runs).join(), /no main push run/, `${path} ${JSON.stringify(change)}`)
    }
  }
  // The newest run (a re-run after a failure) decides.
  const rerun = [...passing().map(run => ({ ...run, conclusion: 'failure' })), ...passing().map(run => ({ ...run, id: run.id + 100 }))]
  assert.deepEqual(gateFailures(sha, 'ahead', rerun), [])
  assert.equal(gateFailures(sha, 'ahead', rerun.map(run => run.id > 100 ? { ...run, conclusion: 'failure' } : run)).length, 4)
})

const expected: Expected = { architecture: 'amd64', version: '1.2.3', revision: sha, license: 'MIT OR Apache-2.0' }

function writeBlob(directory: string, bytes: Buffer, mediaType: string) {
  writeFileSync(join(directory, 'blobs', 'sha256', sha256(bytes).slice(7)), bytes)
  return { mediaType, digest: sha256(bytes), size: bytes.length }
}

function layout(architecture: string, change: (config: Record<string, any>) => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'release-layout-test-'))
  mkdirSync(join(directory, 'blobs', 'sha256'), { recursive: true })
  const labels = { 'org.opencontainers.image.source': 'https://github.com/tkakkie/fukulow', 'org.opencontainers.image.version': '1.2.3',
    'org.opencontainers.image.revision': sha, 'org.opencontainers.image.licenses': 'MIT OR Apache-2.0' }
  const config = { architecture, os: 'linux', config: { User: '10001:10001', Labels: labels } }
  change(config)
  const configDescriptor = writeBlob(directory, Buffer.from(JSON.stringify(config)), 'application/vnd.oci.image.config.v1+json')
  const layer = writeBlob(directory, Buffer.from(`layer-${architecture}`), 'application/vnd.oci.image.layer.v1.tar+gzip')
  const manifest = writeBlob(directory, Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: configDescriptor, layers: [layer] })), 'application/vnd.oci.image.manifest.v1+json')
  writeFileSync(join(directory, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...manifest, annotations: { 'org.opencontainers.image.ref.name': 'x' } }] }))
  return directory
}

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

test('the image license comes from the workspace package and is required', () => {
  assert.equal(workspaceLicense('[workspace]\nmembers = []\n\n[workspace.package]\nedition = "2024"\nlicense = "MIT OR Apache-2.0"\n'), 'MIT OR Apache-2.0')
  assert.equal(workspaceLicense('[workspace]\nmembers = []\n'), undefined)
  assert.equal(workspaceLicense('[workspace.package]\nedition = "2024"\n[package]\nlicense = "MIT"\n'), undefined)
})

type Stored = { blobs: Map<string, Buffer>, manifests: Map<string, Buffer>, requests: string[], tokenRequests: string[] }

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

// A minimal OCI distribution registry with bearer-token auth, enough for the release push.
async function withRegistry(run: (origin: string, stored: Stored) => Promise<void>, realm?: string) {
  const stored: Stored = { blobs: new Map(), manifests: new Map(), requests: [], tokenRequests: [] }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://registry')
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    if (url.pathname === '/token') {
      stored.tokenRequests.push(`${request.headers.authorization} ${url.searchParams.get('scope')}`)
      response.end(JSON.stringify({ token: 'push-token' }))
      return
    }
    if (request.headers.authorization !== 'Bearer push-token') {
      response.writeHead(401, { 'WWW-Authenticate': `Bearer realm="${realm ?? origin + '/token'}",service="registry"` }).end()
      return
    }
    stored.requests.push(`${request.method} ${url.pathname}`)
    const prefix = '/v2/tkakkie/fukulow'
    const data = await body(request)
    const blob = url.pathname.match(/\/blobs\/(sha256:[a-f0-9]{64})$/)?.[1]
    const manifest = url.pathname.match(/\/manifests\/([^/]+)$/)?.[1]
    if (request.method === 'HEAD' && blob) response.writeHead(stored.blobs.has(blob) ? 200 : 404).end()
    else if (request.method === 'POST' && url.pathname === `${prefix}/blobs/uploads/`) response.writeHead(202, { Location: `${prefix}/blobs/uploads/1?state=x` }).end()
    else if (request.method === 'PUT' && url.pathname === `${prefix}/blobs/uploads/1`) {
      const digest = url.searchParams.get('digest')!
      assert.equal(url.searchParams.get('state'), 'x')
      assert.equal(sha256(data), digest)
      stored.blobs.set(digest, data)
      response.writeHead(201).end()
    } else if (request.method === 'HEAD' && manifest) {
      const bytes = stored.manifests.get(manifest)
      response.writeHead(bytes ? 200 : 404, bytes ? { 'Docker-Content-Digest': sha256(bytes) } : {}).end()
    } else if (request.method === 'PUT' && manifest) {
      if (manifest.startsWith('sha256:')) assert.equal(sha256(data), manifest)
      const parsed = JSON.parse(data.toString('utf8'))
      for (const child of [...(parsed.manifests ?? []), parsed.config, ...(parsed.layers ?? [])].filter(Boolean)) {
        assert.ok(stored.blobs.has(child.digest) || stored.manifests.has(child.digest), `missing ${child.digest}`)
      }
      stored.manifests.set(manifest, data)
      response.writeHead(201, { 'Docker-Content-Digest': sha256(data) }).end()
    } else response.writeHead(400).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`, stored)
  } finally {
    server.close()
  }
}

const release = { version: '1.2.3', revision: sha, license: 'MIT OR Apache-2.0', tags: ['1.2.3', '1.2', 'latest'] }

test('publish pushes both platforms by digest, then one index under every planned tag', async () => {
  await withRegistry(async (origin, stored) => {
    const layouts = [readLayout(layout('amd64')), readLayout(layout('arm64', config => { config.architecture = 'arm64' }))]
    const registry = registryClient(origin, 'tkakkie/fukulow', { user: 'actor', password: 'token-test-only' })
    const result = await publish(registry, layouts, release)
    assert.deepEqual(Object.keys(result.platforms), ['amd64', 'arm64'])
    for (const layout of layouts) assert.deepEqual(stored.manifests.get(layout.manifest.digest), layout.manifestBytes)
    const index = stored.manifests.get(result.index)!
    for (const tag of release.tags) assert.deepEqual(stored.manifests.get(tag), index)
    const parsed = JSON.parse(index.toString('utf8'))
    assert.deepEqual(parsed.manifests.map((manifest: { platform: unknown }) => manifest.platform),
      [{ architecture: 'amd64', os: 'linux' }, { architecture: 'arm64', os: 'linux' }])
    assert.equal(parsed.annotations['org.opencontainers.image.revision'], sha)
    // Tags are written only after every platform manifest and the index exist by digest.
    const firstTag = stored.requests.indexOf('PUT /v2/tkakkie/fukulow/manifests/1.2.3')
    assert.ok(stored.requests.slice(0, firstTag).includes(`PUT /v2/tkakkie/fukulow/manifests/${result.index}`))
    assert.deepEqual(stored.tokenRequests, [`Basic ${Buffer.from('actor:token-test-only').toString('base64')} repository:tkakkie/fukulow:pull,push`])
    // A re-run with the same content completes; other content under the version tag is refused.
    assert.deepEqual(await publish(registry, layouts, release), result)
    const other = [readLayout(layout('amd64', config => { config.config.Labels.extra = '1' })), layouts[1]]
    const before = stored.manifests.get('latest')
    await assert.rejects(() => publish(registry, other, release), /already published/)
    assert.deepEqual(stored.manifests.get('latest'), before)
  })
})

test('publish refuses a misordered tag list, duplicate platforms and a token realm on another host', async () => {
  await withRegistry(async origin => {
    const registry = registryClient(origin, 'tkakkie/fukulow', { user: 'actor', password: 'token-test-only' })
    const amd64 = readLayout(layout('amd64'))
    await assert.rejects(() => publish(registry, [amd64], { ...release, tags: ['latest', '1.2.3'] }), /version tag must come first/)
    await assert.rejects(() => publish(registry, [amd64, amd64], release), /duplicate platforms/)
  })
  await withRegistry(async origin => {
    const registry = registryClient(origin, 'tkakkie/fukulow', { user: 'actor', password: 'token-test-only' })
    await assert.rejects(() => publish(registry, [readLayout(layout('amd64'))], release), /realm must be on the registry origin/)
  }, 'http://127.0.0.2:9/token')
})

test('the index is deterministic and names the repository Compose pulls', () => {
  const amd64 = readLayout(layout('amd64'))
  const descriptor = { ...amd64.manifest, platform: { architecture: 'amd64', os: 'linux' } }
  assert.deepEqual(buildIndex([descriptor], release), buildIndex([descriptor], release))
  assert.match(readFileSync(new URL('../compose.yml', import.meta.url), 'utf8'),
    new RegExp(`^    image: ${imageRepository.replaceAll('.', '\\.')}:\\$\\{FUKULOW_VERSION:\\?`, 'm'))
})

test('release notes list the digests, new migrations, config changes and the rollback limit', () => {
  const index = `sha256:${'1'.repeat(64)}`
  const base = { tag: 'v1.2.3', version: '1.2.3', tags: ['1.2.3', '1.2', 'latest'], index,
    platforms: { amd64: `sha256:${'2'.repeat(64)}`, arm64: `sha256:${'3'.repeat(64)}` }, previous: 'v1.2.2', configChanges: [] }
  const withMigration = releaseNotes({ ...base, migrations: ['server/migrations/202612010000_x.sql'], configChanges: ['.env.example'] })
  assert.match(withMigration, new RegExp(`FUKULOW_VERSION=1\\.2\\.3@${index}`))
  for (const digest of Object.values(base.platforms)) assert.ok(withMigration.includes(digest))
  assert.match(withMigration, /`server\/migrations\/202612010000_x.sql`/)
  assert.match(withMigration, /`\.env\.example`/)
  assert.match(withMigration, /since v1\.2\.2/)
  assert.match(withMigration, /rolling back needs a restore of the pre-upgrade backup/)
  const without = releaseNotes({ ...base, migrations: [] })
  assert.match(without, /adds no migration/)
  assert.doesNotMatch(without, /restore of the pre-upgrade backup/)
})
