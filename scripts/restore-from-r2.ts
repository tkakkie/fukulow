import { spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inventory, parseManifest, sha256, type ReadBucket } from './backup-r2-model.ts'
import { curlRunner, fileDigest, objectTransport, privateCurlConfig, readPrivateFile } from './backup-r2.ts'
import { diagnostic, safeFailure } from './backup-safety.ts'
import { restoreDrill } from './restore-drill.ts'

export async function restoreFromR2(options: {
  bucket: ReadBucket; identityFile: string; prefix?: string; now?: () => number
  drill?: (archive: string) => void | Promise<void>
  decrypt?: (archive: string, target: string, identity: string) => void
}) {
  let directory: string | undefined
  try {
    // The offline identity follows the private-file custody rule: owned, 0600, no symlink, outside the checkout.
    const identityFile = await privateCurlConfig(options.identityFile)
    const data = await inventory(options.bucket, (options.now ?? Date.now)())
    const generation = options.prefix ? data.verified.find(g => g.prefix === options.prefix) : data.verified[0]
    if (!generation) throw new Error('No verified restore source')
    directory = await mkdtemp(join(tmpdir(), 'backup-restore-'))
    const archive = join(directory, 'archive.dump.age'), dump = join(directory, 'archive.dump')
    const manifest = await options.bucket.get(generation.prefix + 'manifest.json')
    const bytes = await options.bucket.get(generation.prefix + 'archive.dump.age')
    // Verify the exact selected manifest too: a replacement after inventory is unsafe.
    if (!isDeepStrictEqual(parseManifest(manifest), generation.manifest) ||
      bytes.length !== generation.manifest.ciphertext.size || sha256(bytes) !== generation.manifest.ciphertext.sha256) throw new Error('Integrity check failed')
    await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' })
    await writeFile(join(directory, 'manifest.json'), manifest, { mode: 0o600, flag: 'wx' })
    const decrypt = options.decrypt ?? ((source, target, identity) => {
      const output = openSync(target, 'wx', 0o600)
      try {
        const result = spawnSync('age', ['-d', '-i', identity, source], { stdio: ['ignore', output, 'ignore'] })
        if (result.status !== 0) throw new Error('Decryption failed')
      } finally { closeSync(output) }
    })
    decrypt(archive, dump, identityFile)
    const plaintext = await fileDigest(dump)
    if (plaintext.size !== generation.manifest.plaintext.size || plaintext.sha256 !== generation.manifest.plaintext.sha256) throw new Error('Plaintext integrity check failed')
    await (options.drill ?? restoreDrill)(dump)
  } catch (error) { throw safeFailure('restore', error) }
  finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }) }
    catch (error) { throw safeFailure('cleanup', error) }
  }
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error()
    const config = JSON.parse(await readPrivateFile(process.argv[2]))
    const bucket = objectTransport(await curlRunner(config.curlConfigFile, config.baseUrl))
    if (typeof config.identityFile !== 'string' || (config.prefix !== undefined && typeof config.prefix !== 'string')) throw new Error()
    await restoreFromR2({ bucket, identityFile: config.identityFile, prefix: config.prefix })
    console.log('R2 restore drill passed.')
  } catch (error) {
    console.error(`R2 restore failed ${diagnostic(error)}. Diagnostics suppressed.`)
    process.exitCode = 1
  }
}
