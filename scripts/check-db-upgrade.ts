// Existing-volume upgrade from origin/main; all credentials/data are disposable.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { psql, run } from './compose-harness.ts'
import { restoreDrill } from './restore-drill.ts'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const owner = { email: 'upgrade-owner@example.test', password: 'upgrade-account-test-only' }

type UpgradeEnvironment = NodeJS.ProcessEnv & {
  POSTGRES_PASSWORD: string
  POSTGRES_APP_PASSWORD: string
  FUKULOW_SETUP_TOKEN: string
}

export function upgradeCommands(current: string[], env: UpgradeEnvironment, timeout?: number) {
  const options = { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 }
  const timed = { ...options, timeout: timeout ?? 180_000 }
  const quiet = { ...options, captureOutput: false }
  const docker = (args: string[]) => run('docker', args, timed).stdout.trim()
  const dc = (...args: string[]) => docker([...current, ...args])
  const sql = (query: string, exec = [...current, 'exec', '-T', 'db'], database = 'fukulow') =>
    psql(exec, ['-U', 'fukulow', '-d', database, '-Atc', query], timed).stdout.trim()
  const appExec = [...current, 'exec', '-T', '-e', `PGPASSWORD=${env.POSTGRES_APP_PASSWORD}`, 'db']
  const appArgs = (database: string) => ['-h', '127.0.0.1', '-U', 'fukulow_app', '-d', database]

  return {
    docker, dc, sql,
    buildOldImage(source: string, image: string, host: NodeJS.ProcessEnv) {
      const cacheFrom = host.ACTIONS_RESULTS_URL && host.ACTIONS_RUNTIME_TOKEN ? host.CHECK_UPGRADE_CACHE_FROM : undefined
      const buildEnv = cacheFrom ? { ...env, HOME: host.HOME, ACTIONS_RESULTS_URL: host.ACTIONS_RESULTS_URL,
        ACTIONS_RUNTIME_TOKEN: host.ACTIONS_RUNTIME_TOKEN } : env
      const build = cacheFrom ? ['buildx', 'build', '--load', '--cache-from', cacheFrom] : ['build']
      run('docker', [...build, '-q', '-t', image, source], { ...quiet, env: buildEnv })
    },
    buildCurrentImage() {
      run('docker', [...current, 'build', 'app'], quiet)
    },
    checkMigrationMismatch(project: string, image: string) {
      // The readiness regression checks the startup diagnostic in memory.
      const mismatch = run('docker', ['run', '--rm', '--network', `${project}_backend`,
        '-e', `DATABASE_URL=postgres://fukulow_app:${env.POSTGRES_APP_PASSWORD}@db:5432/fukulow`,
        '-e', `FUKULOW_SETUP_TOKEN=${env.FUKULOW_SETUP_TOKEN}`, image],
        { ...options, timeout: timeout ?? 30_000, acceptStatus: status => status === 1 })
      assert.ok(/migration version\/checksum\/state mismatch/.test(mismatch.stderr), 'Expected the migration mismatch diagnostic')
      assert.ok(mismatch.stdout === '', 'Migration mismatch must produce no stdout')
    },
    checkAppRoleDenial(statement: string) {
      // Check the rejection reason without echoing PostgreSQL stderr on assertion failure.
      const denied = psql(appExec, [...appArgs('fukulow'), '-c', statement],
        { ...options, acceptStatus: status => status !== 0 })
      assert.ok(/permission denied|must be owner/.test(denied.stderr), 'Expected a PostgreSQL privilege denial')
    },
    backup(backups: string) {
      const { stdout } = run(process.execPath, ['scripts/backup.ts', backups], options)
      assert.ok(stdout.trim() === 'Backup passed.', 'Expected backup confirmation')
    },
    restoreArchive(input: number) {
      run('docker', [...current, 'exec', '-T', 'db', 'pg_restore', '-U', 'fukulow', '-d', 'fukulow_restore',
        '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'], { ...quiet, stdin: input })
    },
    restoreRoles() {
      dc('run', '--rm', '-e', `DATABASE_URL=postgres://fukulow:${env.POSTGRES_PASSWORD}@db:5432/fukulow_restore`, 'migrate', 'roles')
    },
    restoredApp(query: string) {
      return psql(appExec, [...appArgs('fukulow_restore'), '-Atc', query], timed).stdout.trim()
    },
    cleanup(args: string[]) {
      try { run('docker', args, quiet) } catch { /* best effort for disposable resources */ }
    },
  }
}

async function health(stack: string[], docker: (args: string[]) => string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const url = `http://${docker([...stack, 'port', 'app', '8080'])}`
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

async function check() {
  const project = `fukulow-upgrade-${randomUUID().slice(0, 8)}`
  const directory = mkdtempSync(join(tmpdir(), project))
  const source = join(directory, 'main')
  const oldImage = process.env.CHECK_UPGRADE_OLD_IMAGE || `${project}-main`
  // Override only for rehearsing a post-merge source locally; CI upgrades origin/main.
  const oldRevision = process.env.CHECK_UPGRADE_REVISION || 'origin/main'
  const configOnly = process.argv.includes('--check-config')
  const image = process.env.CHECK_COMPOSE_IMAGE || `${project}-app`
  const env = { PATH: process.env.PATH, COMPOSE_PROJECT_NAME: project, COMPOSE_DISABLE_ENV_FILE: '1',
    POSTGRES_PASSWORD: 'upgrade-owner-test-only', POSTGRES_APP_PASSWORD: 'upgrade-app-test-only',
    FUKULOW_SETUP_TOKEN: 'upgrade-setup-test-only', FUKULOW_COOKIE_SECURE: 'false', FUKULOW_VERSION: '0.0.0-dev',
    FUKULOW_EDGE_PREFIX: process.env.CHECK_EDGE_PREFIX || `10.${randomInt(64, 128)}.${randomInt(256)}` }
  const override = join(directory, 'override.yml')
  const mainOverride = join(directory, 'main-override.yml')
  const compose = ['compose', '--env-file', '/dev/null', '-p', project]
  const current = [...compose, '-f', join(cwd, 'compose.yml'), '-f', join(cwd, 'compose.dev.yml'), '-f', override]
  const previous = [...compose, '-f', join(source, 'compose.yml'), '-f', mainOverride]
  const commands = upgradeCommands(current, env)
  const { docker, dc, sql } = commands
  // Compare original fields here. Check #515 Message state/receipts and epochs
  // and the #141 deletion marker separately below.
  const snapshot = () => JSON.parse(sql(`SELECT json_build_object(
  'organizations', (SELECT json_agg(to_jsonb(t) - 'history_generation' ORDER BY organization_id) FROM organizations t),
  'accounts', (SELECT json_agg(t ORDER BY id) FROM accounts t),
  'members', (SELECT json_agg(t ORDER BY organization_id, id) FROM users t),
  'messages', (SELECT json_agg(to_jsonb(t) - 'version' - 'send_digest' - 'deleted' ORDER BY organization_id, id) FROM messages t),
  'sessions', (SELECT json_agg(t ORDER BY token_hash) FROM account_sessions t))`))

  const archiveEnv = { PATH: env.PATH }
  try {
    mkdirSync(source)
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
    const revision = execFileSync('git', ['rev-parse', oldRevision], { cwd, env: archiveEnv, encoding: 'utf8' }).trim()
    const archive = execFileSync('git', ['archive', revision], { cwd, env: archiveEnv, maxBuffer: 32 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', source], { env: archiveEnv, input: archive })
    const oldConfig = JSON.parse(docker([...compose, '-f', join(source, 'compose.yml'), 'config', '--format', 'json']))
    const hasMigrate = Object.hasOwn(oldConfig.services, 'migrate')
    writeFileSync(mainOverride, `services:
  app:
    image: ${oldImage}
    ports: !override ["127.0.0.1::8080"]
${hasMigrate ? `  migrate:\n    image: ${oldImage}\n` : ''}volumes:
  postgres_data:
    name: ${project}-data
`)
    const previousConfig = JSON.parse(docker([...previous, 'config', '--format', 'json']))
    assert.equal(previousConfig.services.app.image, oldImage)
    if (hasMigrate) assert.equal(previousConfig.services.migrate.image, oldImage)
    else assert.equal(previousConfig.services.migrate, undefined)
    if (configOnly) {
      console.log(`PASS old stack images: app=${oldImage} migrate=${hasMigrate}`)
      return
    }
    console.log(`Upgrade source=${revision} project=${project}`)
    // CI supplies an image built in its credential-scoped action, so this check needs no cache token.
    if (!process.env.CHECK_UPGRADE_OLD_IMAGE) commands.buildOldImage(source, oldImage, process.env)
    if (!process.env.CHECK_COMPOSE_IMAGE) commands.buildCurrentImage()
    docker([...previous, 'up', '-d', '--no-build', 'app'])
    let url = await health(previous, docker)
    const identity = await request(url, '/setup', { ...owner, organization_name: 'Preserved', name: 'Owner',
      setup_token: env.FUKULOW_SETUP_TOKEN }, undefined, 201)
    const session = await request(url, '/native/session', owner)
    const organization = identity.organization.organization_id
    const channel = await request(url, `/orgs/${organization}/channels`, { name: 'preserved', visibility: 'public' }, session.token, 201)
    const message = await request(url, `/orgs/${organization}/channels/${channel.id}/messages`,
      { body: 'Preserved across role upgrade', client_message_id: randomUUID() }, session.token, 201)
    // Snapshot directly from the running old stack before touching its volume.
    const oldDb = docker([...previous, 'ps', '-q', 'db'])
    const oldExec = ['exec', oldDb]
    const counts = sql("SELECT (SELECT count(*) FROM organizations), (SELECT count(*) FROM users), (SELECT count(*) FROM messages), (SELECT count(*) FROM account_sessions)",
      oldExec)
    assert.equal(counts, '1|1|1|1')
    const roleQuery = "SELECT oid::text FROM pg_roles WHERE rolname = 'fukulow_app'"
    const previousRole = sql(roleQuery, oldExec)
    if (hasMigrate) assert.match(previousRole, /^\d+$/)
    else assert.equal(previousRole, '')
    docker([...previous, 'stop', 'app'])
    // No down -v: the named volume was created by the old deployment.
    dc('up', '-d', '--wait', '--no-build', 'db') // healthcheck: psql may hit "starting up" otherwise
    const before = snapshot()
    assert.equal(sql(roleQuery), previousRole)
    dc('run', '--rm', 'migrate', 'roles')
    dc('run', '--rm', 'migrate', 'roles')
    assert.deepEqual(snapshot(), before)
    if (hasMigrate) assert.equal(sql(roleQuery), previousRole)
    else assert.match(sql(roleQuery), /^\d+$/)
    dc('up', '-d', '--no-build', '--wait', 'app')
    url = await health(current, docker)
    for (const service of ['app', 'migrate']) {
      const container = dc('ps', '-aq', service)
      const [actual] = JSON.parse(docker(['inspect', container]))
      assert.equal(actual.HostConfig.ReadonlyRootfs, true)
      assert.deepEqual(actual.HostConfig.CapDrop, ['ALL'])
      assert.deepEqual(actual.HostConfig.SecurityOpt, ['no-new-privileges:true'])
      assert.deepEqual(actual.Mounts, [], 'upgrade requires no writable-path exception')
      assert.equal(docker(['diff', container]), '')
      if (service === 'migrate') assert.equal(actual.State.ExitCode, 0)
      else assert.equal(actual.State.Health.Status, 'healthy')
    }
    dc('exec', '-T', 'app', 'fukulow-server', 'probe')
    assert.deepEqual(snapshot(), before)
    assert.equal(sql("SELECT count(*) FROM messages WHERE version = seq AND octet_length(send_digest) = 32 AND deleted IS FALSE"), '1')
    await request(url, `/orgs/${organization}/me`, undefined, session.token)
    // An older/newer binary must fail before listening, even with the same row count.
    sql('UPDATE _sqlx_migrations SET version = version + 1 WHERE version = (SELECT max(version) FROM _sqlx_migrations)')
    commands.checkMigrationMismatch(project, image)
    sql('UPDATE _sqlx_migrations SET version = version - 1 WHERE version = (SELECT max(version) FROM _sqlx_migrations)')
    const history = await request(url, `/orgs/${organization}/channels/${channel.id}/messages`, undefined, session.token)
    // A Message sent by a pre-#515 image gains the default empty accepted Mention set (#152)
    // and is served in the #515 wire shape: seq becomes created_seq, version starts at it.
    // An older image already serving that shape (main since #532) is returned unchanged.
    // Either way the upgraded server adds the Organization history_generation (#515 slice 4).
    let upgraded = message
    if ('seq' in message) {
      const { seq, ...unchanged } = message
      upgraded = { mentions: [], ...unchanged, created_seq: seq, version: seq, deleted: false }
    } else {
      assert.ok(Number.isInteger(message.created_seq) && message.version === message.created_seq,
        'old image Message has neither the pre-#515 nor the #515 wire shape')
    }
    const createdSeq = upgraded.created_seq
    assert.ok(Number.isSafeInteger(createdSeq) && createdSeq > 0)
    const historyGeneration = sql(`SELECT history_generation FROM organizations WHERE organization_id='${organization}'`)
    assert.match(historyGeneration, /^[0-9a-f-]{36}$/)
    upgraded = { ...upgraded, history_generation: historyGeneration }
    assert.deepEqual(history.messages, [upgraded])
    assert.equal(history.history_generation, historyGeneration)
    assert.equal(history.as_of_seq, createdSeq)
    assert.equal(sql('SELECT count(*) FROM channel_message_sequences WHERE mutation_seq<>0'), '0')
    await request(url, '/session', owner)
    dc('restart', 'app')
    url = await health(current, docker)
    await request(url, `/orgs/${organization}/me`, undefined, session.token)
    dc('exec', '-T', 'app', 'fukulow-server', 'probe')
    const upgradedMessage = await request(url, `/orgs/${organization}/channels/${channel.id}/messages`,
      { body: 'Sent after read-only upgrade and restart', client_message_id: randomUUID() }, session.token, 201)
    const upgradedHistory = await request(url, `/orgs/${organization}/channels/${channel.id}/messages`, undefined, session.token)
    assert.deepEqual(upgradedHistory.messages, [upgraded, upgradedMessage])
    assert.equal(docker(['diff', dc('ps', '-q', 'app')]), '')
    for (const statement of [
      'ALTER TABLE users DISABLE TRIGGER protect_member_identity',
      'DROP TRIGGER protect_member_identity ON users',
      "CREATE OR REPLACE FUNCTION protect_member_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
      'SET session_replication_role = replica', 'TRUNCATE messages CASCADE',
      'CREATE TABLE public.denied (organization_id uuid NOT NULL)',
    ]) {
      commands.checkAppRoleDenial(statement)
    }
    // Exercise the actual #198 backup entry point with this isolated Compose project.
    const backups = join(directory, 'backups')
    mkdirSync(backups, { mode: 0o700 }); chmodSync(backups, 0o700)
    commands.backup(backups)
    const artifacts = readdirSync(backups).filter(name => /^fukulow-.*\.dump$/.test(name))
    assert.equal(artifacts.length, 1)
    const backup = join(backups, artifacts[0])
    restoreDrill(backup)
    // Production restore uses --no-acl, so explicitly reapply role grants after restore.
    sql('CREATE DATABASE fukulow_restore OWNER fukulow')
    const input = openSync(backup, 'r')
    try { commands.restoreArchive(input) } finally { closeSync(input) }
    commands.restoreRoles()
    const { restoredApp } = commands
    // #314 RLS: no context fails closed; the restored Organization is readable only with its context.
    assert.equal(restoredApp('SELECT count(*) FROM messages'), '0')
    assert.equal(restoredApp("WITH context AS MATERIALIZED (SELECT set_config('fukulow.organization_id', " +
      `'${organization}', true) AS id) SELECT count(*) FROM context CROSS JOIN LATERAL ` +
      '(SELECT 1 FROM messages WHERE context.id IS NOT NULL OFFSET 0) m'), '2')
    // --no-acl resets function ACLs; the grants step must leave the definer function to fukulow_app only.
    assert.equal(sql(
      "SELECT string_agg(coalesce(nullif(acl.grantee, 0)::regrole::text, 'PUBLIC'), ',' ORDER BY 1) FROM pg_proc p, " +
      "aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl WHERE p.proname = 'fukulow_setup_required' " +
      "AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> p.proowner", undefined, 'fukulow_restore'), 'fukulow_app')
    console.log('PASS existing volume: read-only app/migrate without mounts, dropped capabilities, no-new-privileges, probe, idempotent roles, identical Organizations/Accounts/Members/Messages/Sessions, old Session, sign-in, history, restart/send, startup mismatch denial/revert, DDL denials, #198 backup/drill/restored grants, restored RLS and definer ACL')
  } finally {
    if (!configOnly) {
      commands.cleanup([...current, 'down', '-v', '--remove-orphans'])
      commands.cleanup([...previous, 'down', '-v', '--remove-orphans'])
      commands.cleanup(['image', 'rm', oldImage])
      if (!process.env.CHECK_COMPOSE_IMAGE) commands.cleanup(['image', 'rm', image])
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) await check()
