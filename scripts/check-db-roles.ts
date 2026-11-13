// Disposable regression for migration preflight and both password entry points.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const name = `fukulow-role-check-${randomUUID().slice(0, 8)}`
const image = process.env.CHECK_COMPOSE_IMAGE || 'fukulow-app'
const env = { PATH: process.env.PATH, COMPOSE_DISABLE_ENV_FILE: '1',
  LOAD_PROJECT: name, LOAD_PORT: '18194', LOAD_DB_PASSWORD: 'role-owner-test-only',
  LOAD_APP_PASSWORD: 'role-init-test-only', LOAD_SETUP_TOKEN: 'role-setup-test-only' }
const run = (...args: string[]) => execFileSync('docker', args,
  { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }).trim()
const load = JSON.parse(run('compose', '--env-file', '/dev/null', '-f', 'load/compose.yml', 'config', '--format', 'json'))
const sql = (query: string) => run('exec', name, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-Atc', query)
const passwords = ["role-bound-test-only-'\\; DROP TABLE users; --", 'role-rotated-test-only', env.LOAD_APP_PASSWORD,
  'role-rejected-test-only', 'role-unprivileged-test-only']

function command(args: string[], password = passwords[0], user = 'fukulow') {
  return spawnSync('docker', ['run', '--rm', '--network', name, '-e', 'DATABASE_URL', '-e', 'POSTGRES_APP_PASSWORD',
    image, 'fukulow-server', ...args], { cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...env, DATABASE_URL: `postgres://${user}:${env.LOAD_DB_PASSWORD}@db:5432/fukulow`, POSTGRES_APP_PASSWORD: password } })
}

function succeeds(result: ReturnType<typeof command>) {
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}`)
}

async function start(init: boolean) {
  run('run', '-d', '--rm', '--name', name, '--network', name, '--network-alias', 'db',
    '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=fukulow', '-e', `POSTGRES_PASSWORD=${env.LOAD_DB_PASSWORD}`,
    '-e', `POSTGRES_APP_PASSWORD=${env.LOAD_APP_PASSWORD}`,
    ...(init ? load.services.db.volumes.flatMap((v: { source: string; target: string }) => ['-v', `${v.source}:${v.target}:ro`]) : []),
    load.services.db.image, ...load.services.db.command.slice(1),
    '-c', 'log_statement=all', '-c', 'log_min_duration_statement=0',
    '-c', 'log_transaction_sample_rate=1', '-c', 'log_error_verbosity=verbose',
    '-c', 'log_parameter_max_length=-1', '-c', 'log_parameter_max_length_on_error=-1')
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'fukulow', '-d', 'fukulow'], { env })
    if (ready.status === 0) {
      sql('CREATE EXTENSION pg_stat_statements')
      return
    }
    await delay(1000)
  }
  throw new Error('Disposable roles database did not become ready')
}

function noSecrets() {
  // Same query text exported in load/record.ts snapshots/results.json, plus all
  // databases and nested statements so its filters cannot hide a leaked secret.
  const statements = sql('SELECT coalesce(json_agg(query), \'[]\') FROM pg_stat_statements')
  const result = spawnSync('docker', ['logs', name], { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0)
  const logs = result.stdout + result.stderr
  for (const password of passwords) {
    for (const representation of [password, password.split("'")[0]]) {
      assert.ok(!statements.includes(representation), 'password leaked into pg_stat_statements/load snapshots')
      assert.ok(!logs.includes(representation), 'password leaked into PostgreSQL logs')
    }
  }
  assert.equal(sql('SHOW pg_stat_statements.track'), 'all')
  assert.equal(sql('SHOW log_statement'), 'all')
}

try {
  run('network', 'create', name)
  await start(false)
  const missing = command(['migrate'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /fukulow_app is missing; run `migrate roles` first/)
  assert.equal(sql("SELECT to_regclass('public._sqlx_migrations') IS NULL"), 't')
  succeeds(command(['migrate', 'roles']))
  succeeds(command(['migrate']))
  succeeds(command(['migrate', 'roles'], passwords[1]))
  const appRead = () => run('exec', '-e', `PGPASSWORD=${passwords[1]}`, name, 'psql', '-X', '-h', '127.0.0.1',
    '-U', 'fukulow_app', '-d', 'fukulow', '-Atc', 'SELECT count(*) > 0 FROM _sqlx_migrations')
  assert.equal(appRead(), 't')
  // #314: the SECURITY DEFINER bootstrap check is executable by fukulow_app only, not PUBLIC.
  assert.equal(sql("SELECT has_function_privilege('fukulow_app', 'fukulow_setup_required()', 'EXECUTE'), " +
    "NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a " +
    "WHERE p.proname = 'fukulow_setup_required' AND a.grantee = 0)"), 't|t')
  // The existing role survives both rotation and a rejected ownership update.
  sql('CREATE TABLE role_owned_test (organization_id uuid NOT NULL); ALTER TABLE role_owned_test OWNER TO fukulow_app')
  const rejected = command(['migrate', 'roles'], passwords[3])
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /Database roles update failed \(diagnostics suppressed\)/)
  sql('ALTER TABLE role_owned_test OWNER TO CURRENT_USER; DROP TABLE role_owned_test')
  assert.equal(appRead(), 't')
  // A restricted owner fails before sending its password to SQL.
  sql(`CREATE ROLE restricted_owner LOGIN CREATEROLE PASSWORD '${env.LOAD_DB_PASSWORD}'`)
  const restricted = command(['migrate', 'roles'], passwords[4], 'restricted_owner')
  assert.equal(restricted.status, 1)
  assert.match(restricted.stderr, /Database roles update failed \(diagnostics suppressed\)/)
  noSecrets()
  run('rm', '-f', '-v', name)
  await start(true)
  succeeds(command(['migrate']))
  noSecrets()
  console.log('PASS missing-role preflight, initdb/rotation/rejection secrets absent from track=all snapshots and sampled statement logs')
} finally {
  spawnSync('docker', ['rm', '-f', '-v', name], { env, stdio: 'ignore' })
  spawnSync('docker', ['network', 'rm', name], { env, stdio: 'ignore' })
}
