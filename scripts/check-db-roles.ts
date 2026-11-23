// Disposable regression for migration preflight, password handling and external PostgreSQL.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
const externalPassword = "external-app-test-only-'\\"
const passwords = ["role-bound-test-only-'\\; DROP TABLE users; --", 'role-rotated-test-only', env.LOAD_APP_PASSWORD,
  'role-rejected-test-only', 'role-unprivileged-test-only', externalPassword]

function command(args: string[], password = passwords[0], user = 'fukulow') {
  return spawnSync('docker', ['run', '--rm', '--network', name, '-e', 'DATABASE_URL', '-e', 'POSTGRES_APP_PASSWORD',
    '--entrypoint', 'fukulow-server', image, ...args], { cwd, encoding: 'utf8', timeout: 60_000,
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

function checkExternal() {
  const database = 'external_chat'
  const migrationOwner = 'migration_owner'
  const ownerPassword = 'external-owner-test-only'
  const org = '00000000-0000-0000-0000-000000000001'
  const otherOrg = '00000000-0000-0000-0000-000000000002'
  sql(`CREATE ROLE ${migrationOwner} LOGIN PASSWORD '${ownerPassword}'`)
  sql(`CREATE DATABASE ${database} OWNER ${migrationOwner}`)
  const directory = mkdtempSync(join(cwd, '.external-db-check-'))
  const override = join(directory, 'network.yml')
  const serviceFile = join(directory, 'pg_service.conf')
  writeFileSync(serviceFile, `[admin]
host=${name}
user=fukulow
dbname=${database}
sslmode=disable
[owner]
host=${name}
user=${migrationOwner}
dbname=${database}
sslmode=disable
`, { mode: 0o600 })
  const passFile = join(directory, 'pgpass')
  writeFileSync(passFile, `${name}:5432:${database}:fukulow:${env.LOAD_DB_PASSWORD}
${name}:5432:${database}:${migrationOwner}:${ownerPassword}
`, { mode: 0o600 })
  writeFileSync(override, `services:
  app:
    image: ${image}
    networks: !override [backend]
  migrate:
    image: ${image}
networks:
  backend:
    name: ${name}
    external: true
`)
  const compose = ['compose', '--env-file', '/dev/null', '-p', name, '-f', 'compose.yml',
    '-f', 'compose.external-db.yml', '-f', override]
  const appUrl = `postgres://fukulow_app:${encodeURIComponent(externalPassword)}@${name}:5432/${database}`
  const ownerUrl = `postgres://${migrationOwner}:${ownerPassword}@${name}:5432/${database}`
  // The disposable database is reachable only on the unpublished Docker network.
  const composeEnv = { PATH: env.PATH, FUKULOW_SETUP_TOKEN: env.LOAD_SETUP_TOKEN, FUKULOW_VERSION: '0.0.0-dev',
    FUKULOW_APP_DATABASE_URL: `${appUrl}?sslmode=disable`,
    FUKULOW_MIGRATE_DATABASE_URL: `${ownerUrl}?sslmode=disable` }
  const dc = (...args: string[]) => spawnSync('docker', [...compose, ...args],
    { cwd, env: composeEnv, encoding: 'utf8', timeout: 60_000 })
  const psql = (user: string, password: string, query: string) => spawnSync('docker',
    ['exec', '-e', `PGPASSWORD=${password}`, name, 'psql', '-X', '-h', '127.0.0.1',
      '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-qAtc', query], { cwd, env, encoding: 'utf8', timeout: 10_000 })
  const ownerSql = (query: string) => {
    const result = psql(migrationOwner, ownerPassword, query)
    succeeds(result)
    return result.stdout.trim()
  }
  const appSql = (query: string) => psql('fukulow_app', externalPassword, query)
  const bootstrap = (service: string) => spawnSync('docker', ['run', '--rm', '--network', name,
    '-v', `${join(cwd, 'deploy')}:/sql:ro`, '-v', `${serviceFile}:/pg_service.conf:ro`, '-v', `${passFile}:/pgpass:ro`,
    '-e', 'PGSERVICEFILE=/pg_service.conf', '-e', 'PGPASSFILE=/pgpass', '-e', `PGSERVICE=${service}`,
    '-e', `FUKULOW_DB_OWNER=${migrationOwner}`, '-e', 'POSTGRES_APP_PASSWORD',
    load.services.db.image, '/sql/init-db-roles.sh', '--external'],
  { cwd, env: { ...env, POSTGRES_APP_PASSWORD: externalPassword }, encoding: 'utf8', timeout: 30_000 })
  try {
    const noTls = dc('run', '--rm', '-e', `DATABASE_URL=${ownerUrl}`, 'migrate')
    assert.equal(noTls.status, 1)
    assert.match(noTls.stderr, /Database connection failed/)
    const missingRole = dc('run', '--rm', 'migrate')
    assert.equal(missingRole.status, 1)
    assert.match(missingRole.stderr, /fukulow_app is missing/)
    assert.equal(ownerSql("SELECT to_regclass('public._sqlx_migrations') IS NULL"), 't')

    const missingService = bootstrap('missing-service')
    assert.notEqual(missingService.status, 0)
    assert.match(missingService.stderr, /definition of service "missing-service" not found/)
    assert.ok(!missingService.stderr.includes(externalPassword))
    const restricted = bootstrap('owner')
    assert.equal(restricted.status, 1)
    assert.match(restricted.stderr, /Database roles initialization failed \(diagnostics suppressed\)/)
    assert.equal(ownerSql("SELECT count(*) FROM pg_roles WHERE rolname = 'fukulow_app'"), '0')
    succeeds(bootstrap('admin'))
    succeeds(bootstrap('admin'))
    assert.equal(ownerSql("SELECT count(*) FROM pg_default_acl WHERE defaclrole = current_user::regrole"), '2')
    const appNoTls = dc('run', '--rm', '--no-deps', '-e', `DATABASE_URL=${appUrl}`, 'app')
    assert.equal(appNoTls.status, 1)
    assert.match(appNoTls.stderr, /Database connection failed/)
    const missingHistory = dc('run', '--rm', '--no-deps', 'app')
    assert.equal(missingHistory.status, 1)
    assert.match(missingHistory.stderr, /Cannot read migration history/)
    assert.equal(ownerSql("SELECT to_regclass('public._sqlx_migrations') IS NULL"), 't')

    succeeds(dc('up', '--no-build', '--wait', '--wait-timeout', '35', 'app'))
    succeeds(dc('exec', '-T', 'app', 'fukulow-server', 'probe'))
    assert.equal(ownerSql("SELECT relowner = current_user::regrole FROM pg_class WHERE oid = 'public.organizations'::regclass"), 't')
    const ownerAsApp = dc('run', '--rm', '--no-deps', '-e', `DATABASE_URL=${composeEnv.FUKULOW_MIGRATE_DATABASE_URL}`, 'app')
    assert.equal(ownerAsApp.status, 1)
    assert.match(ownerAsApp.stderr, /App database role must be a non-superuser without BYPASSRLS, ownership of relations in public, or role memberships in either direction/)
    assert.ok(!ownerAsApp.stderr.includes(ownerPassword))
    assert.equal(ownerSql("SELECT rolcanlogin AND NOT (rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) " +
      "FROM pg_roles WHERE rolname = 'fukulow_app'"), 't')
    const history = appSql('SELECT count(*) > 0 FROM _sqlx_migrations')
    succeeds(history)
    assert.equal(history.stdout.trim(), 't')

    ownerSql(`INSERT INTO organizations (organization_id, name) VALUES ('${org}', 'Own'), ('${otherOrg}', 'Other')`)
    const withoutContext = appSql('SELECT count(*) FROM organizations')
    succeeds(withoutContext)
    assert.equal(withoutContext.stdout.trim(), '0')
    const context = `SET fukulow.organization_id = '${org}'; `
    const scoped = appSql(context + 'SELECT name FROM organizations')
    succeeds(scoped)
    assert.equal(scoped.stdout.trim(), 'Own')
    for (const statement of ['', context].map(prefix => prefix +
      "INSERT INTO organizations (organization_id, name) VALUES ('00000000-0000-0000-0000-000000000003', 'Denied')")) {
      const denied = appSql(statement)
      assert.notEqual(denied.status, 0)
      assert.match(denied.stderr, /violates row-level security policy/)
    }
    for (const statement of ['CREATE TABLE public.denied (id int)', 'CREATE TEMP TABLE denied (id int)',
      `SET ROLE ${migrationOwner}`, 'ALTER TABLE users DISABLE TRIGGER protect_member_identity',
      'TRUNCATE organizations CASCADE', 'UPDATE _sqlx_migrations SET success = false WHERE false',
      'DELETE FROM channel_log WHERE false', 'UPDATE organizations SET history_generation = NULL WHERE false']) {
      const denied = appSql(statement)
      assert.notEqual(denied.status, 0, statement)
      assert.match(denied.stderr, /permission denied|must be owner/, statement)
    }

    succeeds(dc('stop', 'app'))
    ownerSql("UPDATE _sqlx_migrations SET checksum = decode('00', 'hex') WHERE version = (SELECT max(version) FROM _sqlx_migrations)")
    const mismatch = dc('run', '--rm', '--no-deps', 'app')
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /migration version\/checksum\/state mismatch/)
    assert.equal(ownerSql("SELECT count(*) FROM _sqlx_migrations WHERE checksum = decode('00', 'hex')"), '1')
  } finally {
    dc('down', '-v', '--remove-orphans')
    rmSync(directory, { recursive: true, force: true })
  }
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
  run('rm', '-f', '-v', name)
  await start(false)
  checkExternal()
  noSecrets()
  console.log('PASS external PostgreSQL: app and migrate TLS defaults, bootstrap preflight and admin role setup, owner migrations, app readiness, owner URL rejection, RLS and privilege denials, migration history checks, app password absent from logs and SQL snapshots')
} finally {
  spawnSync('docker', ['rm', '-f', '-v', name], { env, stdio: 'ignore' })
  spawnSync('docker', ['network', 'rm', name], { env, stdio: 'ignore' })
}
