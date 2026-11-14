// SQL/lock probe, separate from the WebSocket throughput harness. All DBs live
// inside this script's disposable, randomly named/ported PostgreSQL container.
// Run: node load/invite-scan.ts
// Optional INVITE_DM_MIGRATIONS=/path/to/codex-151/server/migrations tests #385
// first, then the combined migration set. Requires docker, cargo and sqlx CLI.
// INVITE_SAMPLES=100, INVITE_COUNTS=10000,100000,1000000. Raw logs stay in /tmp.
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir, cpus, totalmem, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = mkdtempSync(join(tmpdir(), 'fukulow-invite-scan-'))
const container = `fukulow-invite-scan-${randomUUID()}`
const image = readFileSync(join(root, 'load/compose.yml'), 'utf8').match(/image: (postgres:18\.\d+@sha256:[a-f0-9]{64})/)?.[1]
if (!image) throw new Error('Missing pinned PostgreSQL image')
const password = 'disposable-invite-scan-only'
function run(command: string, args: string[], extra: { env?: NodeJS.ProcessEnv, input?: string, log?: string } = {}) {
  const fd = extra.log ? openSync(join(artifacts, extra.log), 'a') : undefined
  try {
    const result = spawnSync(command, args, {
      cwd: root, encoding: 'utf8', env: extra.env ?? process.env,
      input: extra.input, stdio: fd === undefined ? 'pipe' : ['pipe', fd, fd],
    })
    if (result.status !== 0) throw new Error(`${command} failed (${result.status}); ${extra.log ?? result.stderr}`)
    return result.stdout?.trim() ?? ''
  } finally { if (fd !== undefined) closeSync(fd) }
}
function cleanup() { spawnSync('docker', ['rm', '-f', '-v', container], { stdio: 'ignore' }) }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { cleanup(); process.exit(1) })
console.log(`Invite measurement artifacts: ${artifacts}`)
try {
  run('docker', ['run', '--detach', '--name', container, '--publish', '127.0.0.1::5432', '--env', `POSTGRES_PASSWORD=${password}`, image])
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (!ready) throw new Error('PostgreSQL startup timed out')
  const port = run('docker', ['port', container, '5432/tcp']).split(':').at(-1)
  if (!port || !/^\d+$/.test(port)) throw new Error('Invalid disposable PostgreSQL port')
  const databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl }
  writeFileSync(join(artifacts, 'metadata.json'), JSON.stringify({
    commit: run('git', ['rev-parse', 'HEAD']), dirty: run('git', ['status', '--porcelain']),
    cpu: cpus()[0]?.model, cpus: cpus().length, memory: totalmem(), os: release(),
    docker: run('docker', ['info', '--format', '{{.ServerVersion}} / {{.NCPU}} CPUs / {{.MemTotal}} bytes']),
    image, imageId: run('docker', ['inspect', '--format', '{{.Image}}', container]),
    rust: run('rustc', ['--version']), node: process.version, sqlxCli: run('sqlx', ['--version']),
    samples: env.INVITE_SAMPLES ?? '100', counts: env.INVITE_COUNTS ?? '10000,100000,1000000',
  }, null, 2))
  const dm = process.env.INVITE_DM_MIGRATIONS
  if (dm) {
    run('docker', ['exec', container, 'createdb', '-U', 'postgres', 'migration_order'])
    const first = join(artifacts, 'dm-first'), combined = join(artifacts, 'combined')
    mkdirSync(first); mkdirSync(combined)
    const current = join(root, 'server/migrations')
    for (const file of readdirSync(current).filter(f => f.endsWith('.sql'))) {
      copyFileSync(join(current, file), join(combined, file))
      if (!file.startsWith('202611140303_') && !file.startsWith('202611140388_')) copyFileSync(join(current, file), join(first, file))
    }
    for (const prefix of ['202611140370_', '202611140386_', '202611140387_']) {
      const file = readdirSync(dm).find(f => f.startsWith(prefix) && f.endsWith('.sql'))
      if (!file) throw new Error(`Missing #385 migration ${prefix}`)
      copyFileSync(join(dm, file), join(first, file)); copyFileSync(join(dm, file), join(combined, file))
    }
    const orderEnv = { ...env, DATABASE_URL: databaseUrl.replace(/\/postgres$/, '/migration_order') }
    run('sqlx', ['migrate', 'run', '--source', first], { env: orderEnv, log: 'migration-order.log' })
    run('sqlx', ['migrate', 'run', '--source', combined], { env: orderEnv, log: 'migration-order.log' })
    run('sqlx', ['migrate', 'run', '--source', combined], { env: orderEnv, log: 'migration-order.log' })
    const history = JSON.parse(run('docker', ['exec', '-i', container, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'migration_order'], {
      input: "SELECT json_agg(json_build_object('version',version,'checksum',encode(checksum,'hex'),'success',success) ORDER BY version) FROM _sqlx_migrations;",
    })) as { version: number, checksum: string, success: boolean }[]
    const expected = readdirSync(combined).filter(f => f.endsWith('.sql')).sort()
    if (history.length !== expected.length) throw new Error('Migration history length mismatch')
    expected.forEach((file, i) => {
      const checksum = createHash('sha384').update(readFileSync(join(combined, file))).digest('hex')
      if (history[i]?.version !== Number(file.split('_')[0]) || history[i]?.checksum !== checksum || !history[i]?.success) throw new Error(`Migration history mismatch: ${file}`)
    })
    writeFileSync(join(artifacts, 'migration-history.json'), JSON.stringify(history, null, 2))
    // Execute the exact CI schema-guard queries against the combined schema.
    // These two guards use ordinary Rust string literals; fail closed if that
    // representation changes rather than silently checking a copied query.
    const guards = readFileSync(join(root, 'server/tests/schema.rs'), 'utf8')
    for (const name of ['check_organization_ids', 'check_row_level_security']) {
      const literal = guards.slice(guards.indexOf(`async fn ${name}(`)).match(/sqlx::query_as\(\s*("(?:[^"\\]|\\.)*")/s)?.[1]
      if (!literal) throw new Error(`Cannot read CI schema guard ${name}`)
      const sql = JSON.parse(literal.replace(/\n/g, '\\n')) as string
      const violations = run('docker', ['exec', '-i', container, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'migration_order'], { input: `${sql};` })
      if (violations) throw new Error(`Combined-schema guard failed: ${name}: ${violations}`)
    }
    console.log('Migration order: #385 first, then 0303/0388, repeat no-op; sorted versions/checksums/success match')
    console.log('Combined-schema CI tenant NOT NULL and exact RLS guards passed')
    // CLI versions can differ from Cargo.lock. Repeat the actual ordering with
    // the application's pinned migrator and its startup history comparison.
    run('cargo', ['test', '--locked', '--release', '-p', 'fukulow-server', '--lib', 'measure_invite_migration_order', '--', '--ignored', '--nocapture'], {
      env: { ...env, INVITE_COMBINED_MIGRATIONS: combined }, log: 'migration-order-rust.log',
    })
    console.log('Pinned application sqlx #385-first migration-order test passed')
  }
  // A fresh sqlx test DB is created/migrated by the normal test macro. The probe
  // seeds through the owner and measures through the repo's restricted app role.
  run('cargo', ['test', '--locked', '--release', '-p', 'fukulow-server', '--lib', 'measure_invite_expiry_scan', '--', '--ignored', '--nocapture'], { env, log: 'measurement.log' })
  run('cargo', ['test', '--locked', '--release', '-p', 'fukulow-server', '--lib', 'measure_invite_live_sort', '--', '--ignored', '--nocapture'], { env, log: 'live.log' })
  console.log(`Completed: ${artifacts}`)
} finally { cleanup() }
