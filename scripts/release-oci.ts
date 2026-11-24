// Release image layouts (#808): read and verify a per-platform OCI archive, build the index.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const imageRepository = 'ghcr.io/tkakkie/fukulow'
const sourceUrl = 'https://github.com/tkakkie/fukulow'
const manifestType = 'application/vnd.oci.image.manifest.v1+json'
export const indexType = 'application/vnd.oci.image.index.v1+json'
// UID/GID of the Dockerfile's fukulow user; the release must never run as root.
const imageUser = '10001:10001'

export type Descriptor = { mediaType: string, digest: string, size: number, platform?: { architecture: string, os: string } }
export type Blob = { digest: string, bytes: Buffer }
export type Layout = { manifest: Descriptor, manifestBytes: Buffer, blobs: Blob[], config: ImageConfig }
type ImageConfig = { architecture?: string, os?: string, config?: { User?: string, Labels?: Record<string, string> } }
export type Expected = { architecture: string, version: string, revision: string, license: string }

export const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function blob(directory: string, descriptor: Descriptor): Buffer {
  const match = /^sha256:([a-f0-9]{64})$/.exec(descriptor.digest)
  if (!match) throw new Error(`unsupported digest ${descriptor.digest}`)
  const bytes = readFileSync(join(directory, 'blobs', 'sha256', match[1]))
  if (sha256(bytes) !== descriptor.digest || bytes.length !== descriptor.size) throw new Error(`blob ${descriptor.digest} does not match its descriptor`)
  return bytes
}

const blobPath = (digest: string) => `blobs/sha256/${digest.slice('sha256:'.length)}`

// docker load on the runners' classic image store reads only manifest.json; it must name the checked image.
function dockerManifestFailure(directory: string, config: Descriptor, layers: Descriptor[]): string | undefined {
  const entries = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { Config?: string, Layers?: string[] }[]
  const expected = JSON.stringify({ Config: blobPath(config.digest), Layers: layers.map(layer => blobPath(layer.digest)) })
  if (entries.length !== 1 || JSON.stringify({ Config: entries[0].Config, Layers: entries[0].Layers }) !== expected) {
    return 'manifest.json must name exactly the image of index.json'
  }
}

// An extracted OCI layout holding exactly one image manifest (built with --provenance=false --sbom=false)
// plus the docker manifest.json of that image (buildx type=docker,oci-mediatypes=true).
export function readLayout(directory: string): Layout {
  const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')) as { manifests?: Descriptor[] }
  if (index.manifests?.length !== 1 || index.manifests[0].mediaType !== manifestType) {
    throw new Error('the layout must hold exactly one OCI image manifest')
  }
  const { mediaType, digest, size } = index.manifests[0]
  const manifest = { mediaType, digest, size }
  const manifestBytes = blob(directory, manifest)
  const parsed = JSON.parse(manifestBytes.toString('utf8')) as { config: Descriptor, layers: Descriptor[] }
  const configBytes = blob(directory, parsed.config)
  const failure = dockerManifestFailure(directory, parsed.config, parsed.layers)
  if (failure) throw new Error(failure)
  const blobs = [{ digest: parsed.config.digest, bytes: configBytes },
    ...parsed.layers.map(layer => ({ digest: layer.digest, bytes: blob(directory, layer) }))]
  return { manifest, manifestBytes, blobs, config: JSON.parse(configBytes.toString('utf8')) }
}

export function extractLayout(archive: string): Layout {
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-release-layout-'))
  try {
    execFileSync('tar', ['-xf', archive, '-C', directory])
    return readLayout(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function ociLabels(expected: Expected): Record<string, string> {
  return { 'org.opencontainers.image.source': sourceUrl, 'org.opencontainers.image.version': expected.version,
    'org.opencontainers.image.revision': expected.revision, 'org.opencontainers.image.licenses': expected.license }
}

export function imageFailures(layout: Layout, expected: Expected): string[] {
  const failures: string[] = []
  const { config } = layout
  if (config.os !== 'linux' || config.architecture !== expected.architecture) {
    failures.push(`platform ${config.os}/${config.architecture}, expected linux/${expected.architecture}`)
  }
  if (config.config?.User !== imageUser) failures.push(`image user ${JSON.stringify(config.config?.User)}, expected ${imageUser}`)
  for (const [key, value] of Object.entries(ociLabels(expected))) {
    if (config.config?.Labels?.[key] !== value) failures.push(`label ${key}=${JSON.stringify(config.config?.Labels?.[key])}, expected ${JSON.stringify(value)}`)
  }
  return failures
}

export function platformDescriptor(layout: Layout): Descriptor {
  return { ...layout.manifest, platform: { architecture: layout.config.architecture ?? '', os: layout.config.os ?? '' } }
}

export function buildIndex(manifests: Descriptor[], expected: Omit<Expected, 'architecture'>): Buffer {
  const platforms = manifests.map(manifest => `${manifest.platform?.os}/${manifest.platform?.architecture}`)
  if (new Set(platforms).size !== platforms.length) throw new Error(`duplicate platforms: ${platforms.join(', ')}`)
  return Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: indexType, manifests,
    annotations: ociLabels({ ...expected, architecture: '' }) }))
}

// The workspace license (#807) labels the image; a release without it fails.
export function workspaceLicense(cargoToml: string): string | undefined {
  const section = /^\[workspace\.package\]\n((?:(?!\[)[^\n]*\n?)*)/m.exec(cargoToml)?.[1]
  return section && /^license\s*=\s*"([^"]+)"\s*$/m.exec(section)?.[1]
}

if (import.meta.main) {
  const [command, archive, architecture, version, revision, license] = process.argv.slice(2)
  if (command === 'license') {
    const value = workspaceLicense(readFileSync('Cargo.toml', 'utf8'))
    if (!value) throw new Error('Cargo.toml [workspace.package] has no license')
    console.log(value)
  } else if (command === 'check') {
    const layout = extractLayout(archive)
    const failures = imageFailures(layout, { architecture, version, revision, license })
    if (failures.length) throw new Error(`release image ${archive}: ${failures.join('; ')}`)
    console.log(`digest=${layout.manifest.digest}`)
  } else {
    throw new Error('usage: release-oci.ts license | check <archive> <architecture> <version> <revision> <license>')
  }
}
