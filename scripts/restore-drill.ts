import { randomUUID } from 'node:crypto'
import { accessSync, constants, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { diagnostic, safeFailure, type Stage } from './backup-safety.ts'
import { psql, run } from './compose-harness.ts'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

// Read only the tracked file: invoking Compose here could load deployment secrets.
export function postgresImageFromCompose(compose = readFileSync(new URL('../compose.yml', import.meta.url), 'utf8')): string {
  const database = compose.match(/^  db:\n((?: {4}[^\n]*\n|\n)*)/m)?.[1]
  const image = database?.match(/^    image: (\S+)$/m)?.[1]
  if (!image || !/^postgres:18(?:\.\d+)?@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('Compose db must use a literal PostgreSQL 18 tag and sha256 digest')
  }
  return image
}

export function restoreDrill(archive: string): void {
  const env = { ...process.env }
  delete env.DATABASE_URL
  const dockerOptions = { cwd: repositoryRoot, env }
  const runDocker = (args: string[], captureStdout = false) => {
    const command = captureStdout ? 'exec docker "$@" 2>/dev/null' : 'exec docker "$@" 2>/dev/null >/dev/null'
    return run('/bin/sh', ['-c', command, 'restore-drill', ...args], dockerOptions)
  }
  let stage: Stage = 'image'
  const started = performance.now()
  const name = `fukulow-restore-drill-${randomUUID()}`
  let created = false
  try {
    const image = postgresImageFromCompose()
    stage = 'start'
    // No Compose, host ports, bind mounts, shared volumes or production connection string.
    runDocker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=fukulow',
      '-e', 'POSTGRES_DB=fukulow', image])
    created = true
    stage = 'ready'
    const exec = ['exec', '-i', name]
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        runDocker([...exec, 'pg_isready', '-U', 'fukulow', '-d', 'fukulow'])
        // The entrypoint also briefly runs a temporary server. Wait for the final PID 1.
        ready = runDocker([...exec, 'cat', '/proc/1/comm'], true).stdout.trim() === 'postgres'
      } catch { /* startup still in progress */ }
      if (ready) break
      awaitStartupPause()
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready')
    const readArchive = (args: string[]) => {
      // Preserve the filesystem error code for the stage diagnostic.
      accessSync(archive, constants.R_OK)
      // Open the archive relative to the caller and stream it without buffering the dump or its listing.
      run('/bin/sh', ['-c', 'archive=$1; root=$2; shift 2; { cd "$root" && exec docker "$@"; } 2>/dev/null < "$archive" >/dev/null',
        'restore-drill', archive, repositoryRoot, ...exec, ...args], { env })
    }
    stage = 'list'
    readArchive(['pg_restore', '--list'])
    stage = 'restore'
    readArchive(['pg_restore', '-U', 'fukulow', '-d', 'fukulow', '--exit-on-error',
      '--single-transaction', '--no-owner', '--no-acl'])
    stage = 'sessions'
    const input = readFileSync(new URL('../server/src/auth/end-all-sessions.sql', import.meta.url))
    // The shared psql helper captures both streams. Keep diagnostics suppressed regardless of their size.
    psql(exec, ['-U', 'fukulow', '-d', 'fukulow'], { ...dockerOptions, input, maxBuffer: Infinity })
    stage = 'integrity'
    runDocker([...exec, 'pg_amcheck', '-U', 'fukulow', '-d', 'fukulow', '--install-missing', '--heapallindexed'])
    console.log(`Restore drill passed in ${((performance.now() - started) / 1000).toFixed(2)} seconds (startup, restore, session end, heap/index checks; cleanup follows).`)
  } catch (error) {
    throw safeFailure(stage, error)
  } finally {
    try { if (created) runDocker(['rm', '-f', '-v', name]) } catch (error) { throw safeFailure('cleanup', error) }
  }
}

function awaitStartupPause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/restore-drill.ts archive.dump')
    restoreDrill(process.argv[2])
  } catch (error) {
    console.error(`Restore drill failed ${diagnostic(error)}. Diagnostics suppressed.`)
    process.exitCode = 1
  }
}
