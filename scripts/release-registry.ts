// Release push (#808): upload verified OCI layouts by digest, then the index and its tags.
// Build jobs stay read-only; only the publish job runs this with a packages:write token.
import { appendFileSync } from 'node:fs'
import { buildIndex, extractLayout, imageRepository, indexType, platformDescriptor, sha256, type Layout } from './release-oci.ts'

const accept = [indexType, 'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ')

export type Credentials = { user: string, password: string }

export function registryClient(origin: string, repository: string, credentials: Credentials, fetchImpl: typeof fetch = fetch) {
  let token: string | undefined
  async function authenticate(challenge: string | null) {
    const realm = /realm="([^"]+)"/.exec(challenge ?? '')?.[1]
    const service = /service="([^"]+)"/.exec(challenge ?? '')?.[1]
    // Never send the credentials to a host other than the registry.
    if (!realm || new URL(realm).origin !== origin) throw new Error('registry token realm must be on the registry origin')
    const url = new URL(realm)
    if (service) url.searchParams.set('service', service)
    url.searchParams.set('scope', `repository:${repository}:pull,push`)
    const basic = Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')
    const response = await fetchImpl(url, { headers: { Authorization: `Basic ${basic}` } })
    if (!response.ok) throw new Error(`registry token: HTTP ${response.status}`)
    const body = await response.json() as { token?: string, access_token?: string }
    token = body.token ?? body.access_token
    if (!token) throw new Error('registry token response has no token')
  }
  async function request(method: string, path: string, headers: Record<string, string> = {}, body?: Buffer) {
    const url = new URL(path, origin)
    if (url.origin !== origin) throw new Error(`refusing a registry request to ${url.origin}`)
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, { method, body: body && new Uint8Array(body), headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
      if (response.status !== 401 || attempt > 0) return response
      await response.arrayBuffer()
      await authenticate(response.headers.get('www-authenticate'))
    }
  }
  const expect = async (response: Response, statuses: number[], what: string) => {
    if (!statuses.includes(response.status)) throw new Error(`${what}: HTTP ${response.status}`)
    await response.arrayBuffer()
    return response
  }
  const base = `/v2/${repository}`
  return {
    async pushBlob(digest: string, bytes: Buffer) {
      const head = await request('HEAD', `${base}/blobs/${digest}`)
      if (head.status === 200) return
      await expect(head, [404], `blob ${digest} lookup`)
      const started = await expect(await request('POST', `${base}/blobs/uploads/`), [202], `blob ${digest} upload start`)
      const header = started.headers.get('location')
      // Uploads go to the registry origin only; a missing or foreign Location is refused.
      const location = header ? new URL(header, origin) : undefined
      if (!location || location.origin !== origin) throw new Error(`blob ${digest} upload location must be on the registry origin`)
      location.searchParams.set('digest', digest)
      await expect(await request('PUT', location.pathname + location.search,
        { 'Content-Type': 'application/octet-stream' }, bytes), [201], `blob ${digest} upload`)
    },
    async manifestDigest(reference: string): Promise<string | undefined> {
      const response = await request('HEAD', `${base}/manifests/${reference}`, { Accept: accept })
      if (response.status === 404) return undefined
      await expect(response, [200], `manifest ${reference} lookup`)
      return response.headers.get('docker-content-digest') ?? undefined
    },
    async putManifest(reference: string, mediaType: string, bytes: Buffer) {
      const response = await expect(await request('PUT', `${base}/manifests/${reference}`, { 'Content-Type': mediaType }, bytes),
        [201], `manifest ${reference} upload`)
      const digest = response.headers.get('docker-content-digest')
      if (digest && digest !== sha256(bytes)) throw new Error(`registry stored ${reference} as ${digest}, expected ${sha256(bytes)}`)
    },
  }
}

export type Registry = ReturnType<typeof registryClient>
export type Release = { version: string, revision: string, license: string, tags: string[] }

// The version tag is immutable: a re-run may complete it, never replace it with other content.
export async function publish(registry: Registry, layouts: Layout[], release: Release) {
  if (release.tags[0] !== release.version) throw new Error('the version tag must come first')
  const index = buildIndex(layouts.map(platformDescriptor), release)
  const indexDigest = sha256(index)
  const existing = await registry.manifestDigest(release.version)
  if (existing && existing !== indexDigest) throw new Error(`${release.version} is already published as ${existing}; publish a new version instead`)
  for (const layout of layouts) {
    for (const { digest, bytes } of layout.blobs) await registry.pushBlob(digest, bytes)
    await registry.putManifest(layout.manifest.digest, layout.manifest.mediaType, layout.manifestBytes)
  }
  await registry.putManifest(indexDigest, indexType, index)
  for (const tag of release.tags) await registry.putManifest(tag, indexType, index)
  return { index: indexDigest, platforms: Object.fromEntries(layouts.map(layout => [layout.config.architecture, layout.manifest.digest])) }
}

if (import.meta.main) {
  const [version, revision, license, tags, ...archives] = process.argv.slice(2)
  const { REGISTRY_USER: user, REGISTRY_PASSWORD: password, GITHUB_OUTPUT: output } = process.env
  if (!user || !password || !output || !archives.length) {
    throw new Error('usage: REGISTRY_USER REGISTRY_PASSWORD GITHUB_OUTPUT release-registry.ts <version> <revision> <license> <tags> <archive>...')
  }
  const [host, ...path] = imageRepository.split('/')
  const result = await publish(registryClient(`https://${host}`, path.join('/'), { user, password }),
    archives.map(extractLayout), { version, revision, license, tags: tags.split(',') })
  appendFileSync(output, `index-digest=${result.index}\n${Object.entries(result.platforms)
    .map(([architecture, digest]) => `${architecture}-digest=${digest}\n`).join('')}`)
  console.log(`published ${imageRepository}@${result.index} as ${tags}`)
}
