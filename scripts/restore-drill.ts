import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { docker } from './backup.ts'
import { diagnostic, safeFailure, type Stage } from './backup-safety.ts'

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
  let stage: Stage = 'image'
  const started = performance.now()
  const name = `fukulow-restore-drill-${randomUUID()}`
  let created = false
  try {
    const image = postgresImageFromCompose()
    stage = 'start'
    // No Compose, host ports, bind mounts, shared volumes or production connection string.
    docker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=fukulow',
      '-e', 'POSTGRES_DB=fukulow', image])
    created = true
    stage = 'ready'
    const exec = ['exec', '-i', name]
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        docker([...exec, 'pg_isready', '-U', 'fukulow', '-d', 'fukulow'])
        // The entrypoint also briefly runs a temporary server. Wait for the final PID 1.
        ready = docker([...exec, 'cat', '/proc/1/comm'], 'ignore', 'pipe') === 'postgres'
      } catch { /* startup still in progress */ }
      if (ready) break
      awaitStartupPause()
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready')
    const readArchive = (args: string[]) => {
      const input = openSync(archive, 'r')
      try { docker([...exec, ...args], input) } finally { closeSync(input) }
    }
    stage = 'list'
    readArchive(['pg_restore', '--list'])
    stage = 'restore'
    readArchive(['pg_restore', '-U', 'fukulow', '-d', 'fukulow', '--exit-on-error',
      '--single-transaction', '--no-owner', '--no-acl'])
    stage = 'sessions'
    const sessions = openSync(fileURLToPath(new URL('../server/src/auth/end-all-sessions.sql', import.meta.url)), 'r')
    try {
      docker([...exec, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1'], sessions)
    } finally { closeSync(sessions) }
    stage = 'integrity'
    docker([...exec, 'pg_amcheck', '-U', 'fukulow', '-d', 'fukulow', '--install-missing', '--heapallindexed'])
    console.log(`Restore drill passed in ${((performance.now() - started) / 1000).toFixed(2)} seconds (startup, restore, session end, heap/index checks; cleanup follows).`)
  } catch (error) {
    throw safeFailure(stage, error)
  } finally {
    try { if (created) docker(['rm', '-f', '-v', name]) } catch (error) { throw safeFailure('cleanup', error) }
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
