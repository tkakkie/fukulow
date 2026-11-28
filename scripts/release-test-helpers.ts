import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from './release-oci.ts'

export const sha = 'a'.repeat(40)

function writeBlob(directory: string, bytes: Buffer, mediaType: string) {
  writeFileSync(join(directory, 'blobs', 'sha256', sha256(bytes).slice(7)), bytes)
  return { mediaType, digest: sha256(bytes), size: bytes.length }
}

export function layout(architecture: string, change: (config: Record<string, any>) => void = () => {}) {
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
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify([{ Config: `blobs/sha256/${configDescriptor.digest.slice(7)}`,
    RepoTags: [`fukulow-release:${architecture}`], Layers: [`blobs/sha256/${layer.digest.slice(7)}`] }]))
  return directory
}

export const release = { version: '1.2.3', revision: sha, license: 'MIT OR Apache-2.0', tags: ['1.2.3', '1.2', 'latest'] }
