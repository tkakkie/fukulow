import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdtempSync, openSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLocalLock, assertLocalLock, diagnostic, privateDirectory, safeFailure, sweepPartials, syncDirectory, type Stage } from './backup-safety.ts'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const composeFile = join(repositoryRoot, 'compose.yml')

// Never surface Docker/Compose/Postgres diagnostics: they can contain credentials or data.
export function docker(args: string[], input: number | 'ignore' = 'ignore', output: number | 'ignore' | 'pipe' = 'ignore'): string {
  const env = { ...process.env }
  delete env.DATABASE_URL
  const result = spawnSync('docker', args, { cwd: repositoryRoot, env, stdio: [input, output, 'ignore'], encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Docker operation failed (diagnostics suppressed)')
  return typeof result.stdout === 'string' ? result.stdout.trim() : ''
}

export function backup(directory: string, capture?: () => void, options: {
  localLock?: () => void; syncDirectory?: typeof syncDirectory
} = {}): string {
  let stage: Stage = 'directory', temporary: string | undefined, release: (() => void) | undefined
  try {
    const destination = privateDirectory(directory)
    stage = 'lock'
    if (options.localLock) assertLocalLock(destination, options.localLock)
    else release = acquireLocalLock(destination)
    stage = 'sweep'
    sweepPartials(destination)
    const compose = ['compose', '-f', composeFile, 'exec', '-T', 'db']
    stage = 'version'
    if (!/^pg_dump \(PostgreSQL\) 18\./.test(docker([...compose, 'pg_dump', '--version'], 'ignore', 'pipe'))) {
      throw new Error('PostgreSQL 18 pg_dump is required')
    }
    temporary = mkdtempSync(join(destination, '.partial-'))
    const archive = join(temporary, 'archive')
    const output = openSync(archive, 'wx', 0o600)
    try {
      capture?.()
      stage = 'dump'
      docker([...compose, 'pg_dump', '-U', 'fukulow', '-d', 'fukulow', '--format=custom'], 'ignore', output)
      stage = 'archive-sync'
      fsyncSync(output)
    } finally {
      closeSync(output)
    }
    const input = openSync(archive, 'r')
    try {
      stage = 'list'
      docker([...compose, 'pg_restore', '--list'], input)
    } finally {
      closeSync(input)
    }
    const name = `fukulow-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.dump`
    const artifact = join(destination, name)
    stage = 'publish'
    renameSync(archive, artifact)
    stage = 'directory-sync'
    ;(options.syncDirectory ?? syncDirectory)(destination)
    return artifact
  } catch (error) {
    throw safeFailure(stage, error)
  } finally {
    try {
      if (temporary) rmSync(temporary, { recursive: true, force: true })
    } catch (error) { throw safeFailure('cleanup', error) }
    finally {
      try { release?.() } catch (error) { throw safeFailure('lock', error) }
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/backup.ts /absolute/private/backup-directory')
    backup(process.argv[2])
    console.log('Backup passed.')
  } catch (error) {
    console.error(`Backup failed ${diagnostic(error)}; publication durability is unconfirmed. Diagnostics suppressed.`)
    process.exitCode = 1
  }
}
