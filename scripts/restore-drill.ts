import { randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { docker } from './backup.ts'

export function restoreDrill(archive: string): void {
  const started = performance.now()
  const name = `fukulow-restore-drill-${randomUUID()}`
  let created = false
  try {
    // No Compose, host ports, bind mounts, shared volumes or production connection string.
    docker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=fukulow',
      '-e', 'POSTGRES_DB=fukulow', 'postgres:18'])
    created = true
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
    readArchive(['pg_restore', '--list'])
    readArchive(['pg_restore', '-U', 'fukulow', '-d', 'fukulow', '--exit-on-error',
      '--single-transaction', '--no-owner', '--no-acl'])
    const sessions = openSync(fileURLToPath(new URL('../server/src/auth/end-all-sessions.sql', import.meta.url)), 'r')
    try {
      docker([...exec, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1'], sessions)
    } finally { closeSync(sessions) }
    docker([...exec, 'pg_amcheck', '-U', 'fukulow', '-d', 'fukulow', '--install-missing', '--heapallindexed'])
    console.log(`Restore drill passed in ${((performance.now() - started) / 1000).toFixed(2)} seconds (startup, restore, session end, heap/index checks; cleanup follows).`)
  } finally {
    if (created) docker(['rm', '-f', '-v', name])
  }
}

function awaitStartupPause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/restore-drill.ts archive.dump')
    restoreDrill(process.argv[2])
  } catch {
    console.error('Restore drill failed (diagnostics suppressed). No production database was used; check archive, Docker and available memory. Inspect only containers named fukulow-restore-drill-* if cleanup was interrupted.')
    process.exitCode = 1
  }
}
