import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Never surface Docker/Compose/Postgres diagnostics: they can contain credentials or data.
export function docker(args: string[], input: number | 'ignore' = 'ignore', output: number | 'ignore' | 'pipe' = 'ignore'): string {
  const env = { ...process.env }
  delete env.DATABASE_URL
  const result = spawnSync('docker', args, { env, stdio: [input, output, 'ignore'], encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Docker operation failed (diagnostics suppressed)')
  return typeof result.stdout === 'string' ? result.stdout.trim() : ''
}

export function backup(directory: string): string {
  const destination = resolve(directory)
  mkdirSync(destination, { mode: 0o700, recursive: true })
  const info = lstatSync(destination)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new Error('Backup directory must be owned by this user, mode 0700, and not a symlink')
  }
  const compose = ['compose', '-f', 'compose.yml', 'exec', '-T', 'db']
  if (!/^pg_dump \(PostgreSQL\) 18\./.test(docker([...compose, 'pg_dump', '--version'], 'ignore', 'pipe'))) {
    throw new Error('PostgreSQL 18 pg_dump is required')
  }
  const temporary = mkdtempSync(join(destination, '.partial-'))
  try {
    const archive = join(temporary, 'archive')
    const output = openSync(archive, 'wx', 0o600)
    try {
      docker([...compose, 'pg_dump', '-U', 'fukulow', '-d', 'fukulow', '--format=custom'], 'ignore', output)
      fsyncSync(output)
    } finally {
      closeSync(output)
    }
    const input = openSync(archive, 'r')
    try {
      docker([...compose, 'pg_restore', '--list'], input)
    } finally {
      closeSync(input)
    }
    const name = `fukulow-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.dump`
    const artifact = join(destination, name)
    renameSync(archive, artifact)
    return artifact
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/backup.ts /absolute/private/backup-directory')
    console.log(backup(process.argv[2]))
  } catch {
    console.error('Backup failed; no new verified artifact published. Check directory permissions, Compose project and PostgreSQL 18 availability. Diagnostics suppressed to protect secrets.')
    process.exitCode = 1
  }
}
