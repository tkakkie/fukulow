// Existing-volume upgrade from origin/main; all credentials/data are disposable.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { restoreDrill } from './restore-drill.ts'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const project = `fukulow-upgrade-${randomUUID().slice(0, 8)}`
const directory = mkdtempSync(join(tmpdir(), project))
const source = join(directory, 'main')
mkdirSync(source)
const oldImage = `${project}-main`
// Override only for rehearsing a post-merge source locally; CI upgrades origin/main.
const oldRevision = process.env.CHECK_UPGRADE_REVISION || 'origin/main'
const configOnly = process.argv.includes('--check-config')
const image = process.env.CHECK_COMPOSE_IMAGE || `${project}-app`
const env = { PATH: process.env.PATH, COMPOSE_PROJECT_NAME: project, COMPOSE_DISABLE_ENV_FILE: '1',
  POSTGRES_PASSWORD: 'upgrade-owner-test-only', POSTGRES_APP_PASSWORD: 'upgrade-app-test-only',
  FUKULOW_SETUP_TOKEN: 'upgrade-setup-test-only', FUKULOW_COOKIE_SECURE: 'false',
  FUKULOW_EDGE_PREFIX: process.env.CHECK_EDGE_PREFIX || `10.${randomInt(64, 128)}.${randomInt(256)}` }
const override = join(directory, 'override.yml')
const mainOverride = join(directory, 'main-override.yml')
writeFileSync(override, `services:
  app:
    image: ${image}
    ports: !override ["127.0.0.1::8080"]
  migrate:
    image: ${image}
volumes:
  postgres_data:
    name: ${project}-data
`)
const run = (args: string[], input?: string | Buffer) => execFileSync('docker', args,
  { cwd, env, input, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }).trim()
const compose = (file: string, extra: string) => ['compose', '--env-file', '/dev/null', '-p', project, '-f', file, '-f', extra]
const current = compose(join(cwd, 'compose.yml'), override)
const previous = compose(join(source, 'compose.yml'), mainOverride)
const dc = (...args: string[]) => run([...current, ...args])
const sql = (query: string) => dc('exec', '-T', 'db', 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-Atc', query)
const owner = { email: 'upgrade-owner@example.test', password: 'upgrade-account-test-only' }

async function health(stack: string[]) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const url = `http://${run([...stack, 'port', 'app', '8080'])}`
      if ((await fetch(url + '/api/v1/health')).ok) return url
    } catch { /* startup/recreation */ }
    await delay(1000)
  }
  throw new Error('Disposable upgrade app did not become healthy')
}

async function request(url: string, path: string, data?: unknown, token?: string, expected = 200) {
  const response = await fetch(url + '/api/v1' + path, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data) })
  assert.equal(response.status, expected, path)
  return response.json()
}

const snapshot = () => JSON.parse(sql(`SELECT json_build_object(
  'organizations', (SELECT json_agg(t ORDER BY organization_id) FROM organizations t),
  'accounts', (SELECT json_agg(t ORDER BY id) FROM accounts t),
  'members', (SELECT json_agg(t ORDER BY organization_id, id) FROM users t),
  'messages', (SELECT json_agg(t ORDER BY organization_id, id) FROM messages t),
  'sessions', (SELECT json_agg(t ORDER BY token_hash) FROM account_sessions t))`))

async function check() {
  try {
    const revision = execFileSync('git', ['rev-parse', oldRevision], { cwd, encoding: 'utf8' }).trim()
    const archive = execFileSync('git', ['archive', revision], { cwd, maxBuffer: 32 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', source], { input: archive })
    const oldConfig = JSON.parse(run(['compose', '--env-file', '/dev/null', '-p', project,
      '-f', join(source, 'compose.yml'), 'config', '--format', 'json']))
    const hasMigrate = Object.hasOwn(oldConfig.services, 'migrate')
    writeFileSync(mainOverride, `services:
  app:
    image: ${oldImage}
    ports: !override ["127.0.0.1::8080"]
${hasMigrate ? `  migrate:\n    image: ${oldImage}\n` : ''}volumes:
  postgres_data:
    name: ${project}-data
`)
    const previousConfig = JSON.parse(run([...previous, 'config', '--format', 'json']))
    assert.equal(previousConfig.services.app.image, oldImage)
    if (hasMigrate) assert.equal(previousConfig.services.migrate.image, oldImage)
    else assert.equal(previousConfig.services.migrate, undefined)
    if (configOnly) {
      console.log(`PASS old stack images: app=${oldImage} migrate=${hasMigrate}`)
      return
    }
    console.log(`Upgrade source=${revision} project=${project}`)
    // CI reuses main's exported layers; buildx needs HOME for the builder and the Actions cache credentials.
    const cacheFrom = process.env.CHECK_UPGRADE_CACHE_FROM
    const buildEnv = cacheFrom ? { ...env, HOME: process.env.HOME, ACTIONS_RESULTS_URL: process.env.ACTIONS_RESULTS_URL,
      ACTIONS_RUNTIME_TOKEN: process.env.ACTIONS_RUNTIME_TOKEN } : env
    const build = cacheFrom ? ['buildx', 'build', '--load', '--cache-from', cacheFrom] : ['build']
    execFileSync('docker', [...build, '-q', '-t', oldImage, source], { cwd, env: buildEnv, stdio: 'inherit' })
    if (!process.env.CHECK_COMPOSE_IMAGE) {
      execFileSync('docker', [...current, 'build', 'app'], { cwd, env, stdio: 'inherit' })
    }
    run([...previous, 'up', '-d', '--no-build', 'app'])
    let url = await health(previous)
    const identity = await request(url, '/setup', { ...owner, organization_name: 'Preserved', name: 'Owner',
      setup_token: env.FUKULOW_SETUP_TOKEN }, undefined, 201)
    const session = await request(url, '/native/session', owner)
    const organization = identity.organization.organization_id
    const channel = await request(url, `/orgs/${organization}/channels`, { name: 'preserved', visibility: 'public' }, session.token, 201)
    const message = await request(url, `/orgs/${organization}/channels/${channel.id}/messages`,
      { body: 'Preserved across role upgrade', client_message_id: randomUUID() }, session.token, 201)
    // Snapshot directly from the running old stack before touching its volume.
    const oldDb = run([...previous, 'ps', '-q', 'db'])
    const counts = run(['exec', oldDb, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-Atc',
      "SELECT (SELECT count(*) FROM organizations), (SELECT count(*) FROM users), (SELECT count(*) FROM messages), (SELECT count(*) FROM account_sessions)"])
    assert.equal(counts, '1|1|1|1')
    const roleQuery = "SELECT oid::text FROM pg_roles WHERE rolname = 'fukulow_app'"
    const previousRole = run(['exec', oldDb, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-Atc', roleQuery])
    if (hasMigrate) assert.match(previousRole, /^\d+$/)
    else assert.equal(previousRole, '')
    run([...previous, 'stop', 'app'])
    // No down -v: the named volume was created by the old deployment.
    dc('up', '-d', '--wait', '--no-build', 'db') // healthcheck: psql may hit "starting up" otherwise
    const before = snapshot()
    assert.equal(sql(roleQuery), previousRole)
    dc('run', '--rm', 'migrate', 'roles')
    dc('run', '--rm', 'migrate', 'roles')
    assert.deepEqual(snapshot(), before)
    if (hasMigrate) assert.equal(sql(roleQuery), previousRole)
    else assert.match(sql(roleQuery), /^\d+$/)
    dc('up', '-d', '--no-build', 'app')
    url = await health(current)
    assert.deepEqual(snapshot(), before)
    await request(url, `/orgs/${organization}/me`, undefined, session.token)
    // An older/newer binary must fail before listening, even with the same row count.
    sql('UPDATE _sqlx_migrations SET version = version + 1 WHERE version = (SELECT max(version) FROM _sqlx_migrations)')
    const mismatch = spawnSync('docker', ['run', '--rm', '--network', `${project}_backend`,
      '-e', `DATABASE_URL=postgres://fukulow_app:${env.POSTGRES_APP_PASSWORD}@db:5432/fukulow`,
      '-e', `FUKULOW_SETUP_TOKEN=${env.FUKULOW_SETUP_TOKEN}`, image], { cwd, env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /migration version\/checksum\/state mismatch/)
    assert.equal(mismatch.stdout, '')
    sql('UPDATE _sqlx_migrations SET version = version - 1 WHERE version = (SELECT max(version) FROM _sqlx_migrations)')
    const history = await request(url, `/orgs/${organization}/channels/${channel.id}/messages`, undefined, session.token)
    assert.deepEqual(history.messages, [message])
    await request(url, '/session', owner)
    dc('restart', 'app')
    url = await health(current)
    await request(url, `/orgs/${organization}/me`, undefined, session.token)
    for (const statement of [
      'ALTER TABLE users DISABLE TRIGGER protect_member_identity',
      'DROP TRIGGER protect_member_identity ON users',
      "CREATE OR REPLACE FUNCTION protect_member_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
      'SET session_replication_role = replica', 'TRUNCATE messages CASCADE',
      'CREATE TABLE public.denied (organization_id uuid NOT NULL)',
    ]) {
      const denied = spawnSync('docker', [...current, 'exec', '-T', '-e', `PGPASSWORD=${env.POSTGRES_APP_PASSWORD}`,
        'db', 'psql', '-X', '-h', '127.0.0.1', '-U', 'fukulow_app', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-c', statement],
      { cwd, env, encoding: 'utf8' })
      assert.notEqual(denied.status, 0, statement)
      assert.match(denied.stderr, /permission denied|must be owner/, statement)
    }
    // Exercise the actual #198 backup entry point with this isolated Compose project.
    const backups = join(directory, 'backups')
    mkdirSync(backups, { mode: 0o700 }); chmodSync(backups, 0o700)
    const backup = execFileSync(process.execPath, ['scripts/backup.ts', backups], { cwd, env, encoding: 'utf8' }).trim()
    restoreDrill(backup)
    // Production restore uses --no-acl, so explicitly reapply role grants after restore.
    sql('CREATE DATABASE fukulow_restore OWNER fukulow')
    const input = openSync(backup, 'r')
    try { execFileSync('docker', [...current, 'exec', '-T', 'db', 'pg_restore', '-U', 'fukulow', '-d', 'fukulow_restore',
      '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'], { cwd, env, stdio: [input, 'ignore', 'inherit'] })
    } finally { closeSync(input) }
    dc('run', '--rm', '-e', `DATABASE_URL=postgres://fukulow:${env.POSTGRES_PASSWORD}@db:5432/fukulow_restore`, 'migrate', 'roles')
    assert.equal(dc('exec', '-T', '-e', `PGPASSWORD=${env.POSTGRES_APP_PASSWORD}`, 'db', 'psql', '-X', '-h', '127.0.0.1',
      '-U', 'fukulow_app', '-d', 'fukulow_restore', '-Atc', 'SELECT count(*) FROM messages'), '1')
    console.log('PASS existing volume: idempotent roles, identical Organizations/Accounts/Members/Messages/Sessions, old Session, sign-in, history, restart, startup mismatch denial/revert, DDL denials, #198 backup/drill/restored grants')
  } finally {
    if (!configOnly) {
      spawnSync('docker', [...current, 'down', '-v', '--remove-orphans'], { cwd, env, stdio: 'inherit' })
      spawnSync('docker', [...previous, 'down', '-v', '--remove-orphans'], { cwd, env, stdio: 'ignore' })
      spawnSync('docker', ['image', 'rm', oldImage], { cwd, env, stdio: 'ignore' })
      if (!process.env.CHECK_COMPOSE_IMAGE) spawnSync('docker', ['image', 'rm', image], { cwd, env, stdio: 'ignore' })
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

await check()
