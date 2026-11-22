import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbCommand } from '../../slice5/stack.ts';
import { fixture, type Arm } from '../../slice5/config.ts';
import { appliedSettingsSQL, autovacuumSQL, channelLogSQL, checksumSQL, prefillSQL, settleSQL } from '../../slice5/fixture.ts';
import { setupOptions, sqlState, sqlStateMeaning, tcpReadinessArgs, waitReady } from '../../harness-core/postgres.ts';

const locale = { LC_ALL: 'C' };
export function cmd(file: string, args: string[], input?: string, env = { ...process.env, ...locale }) {
  const child = spawnSync(file, args, {
    input, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.status !== 0) {
    const state = sqlState(child.stderr ?? '');
    const benchError = /^(pgbench: error: (?:client |invalid command|unexpected|undefined variable|invalid input).*)$/m.exec(child.stderr ?? '')?.[1];
    if (benchError) throw new Error(benchError.replace(/["'][^"']*["']/g, '<quoted>'));
    throw new Error(`${file} failed (${state ? state + (sqlStateMeaning[state] ? ': ' + sqlStateMeaning[state] : '') : (child.error as NodeJS.ErrnoException | undefined)?.code ?? child.signal ?? child.status})`);
  }
  return child.stdout.trim();
}

export const runtime = 'fukulow_app';
export const owner = 'fukulow';
export const pgOptions = '-c statement_timeout=10s -c jit=off';

export function stack(source: string, work: string, arm: Arm, commit: string, project: string, appImage?: string) {
  const image = appImage ?? `fukulow-slice5:${arm.toLowerCase()}-${commit.slice(0, 12)}`;
  const revision = cmd('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]);
  if (revision !== commit) throw new Error('Slice 5 migration image revision mismatch');
  const composeFile = source + '/load/compose.yml';
  const pg = /image: (postgres:[^\s]+)/.exec(readFileSync(composeFile, 'utf8'))?.[1];
  if (!pg?.includes('@sha256:')) throw new Error('Missing pinned PostgreSQL image');
  const env = { ...locale, PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, LOAD_PROJECT: project, LOAD_PORT: '0', LOAD_APP_IMAGE: image,
    LOAD_DB_PASSWORD: randomUUID(), LOAD_APP_PASSWORD: randomUUID(), LOAD_SETUP_TOKEN: randomUUID() };
  const override = work + '/' + arm + '-compose.json';
  writeFileSync(override, JSON.stringify({ services: { db: { command: dbCommand() },
    ...(appImage && { app: { logging: { options: { 'max-size': '64m' } } } }) } }), { mode: 0o600 });
  const compose = ['compose', '--env-file', '/dev/null', '-p', project, '-f', composeFile, '-f', override];
  const dc = (args: string[], input?: string) => cmd('docker', [...compose, ...args], input, env);
  if (cmd('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project])) {
    throw new Error('Disposable Compose project already exists');
  }
  const start = async () => {
    dc(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'db']);
    await waitReady(() => { try { dc(tcpReadinessArgs(['exec', '-T', 'db'])); return true; } catch { return false; } });
    dc(['run', '--rm', '--no-deps', '--pull', 'never', '--name', project + '-migrate', 'migrate']);
    const dir = join(source, 'server/migrations');
    const expected = readdirSync(dir).filter(name => /^\d+_.*\.sql$/.test(name)).sort().map(name =>
      name.split('_')[0] + '|' + createHash('sha384').update(readFileSync(join(dir, name))).digest('hex')).join('\n');
    const applied = psql("SELECT version, encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version;");
    if (!expected || expected !== applied) throw new Error('Applied migrations differ from the archived revision');
    const id = dc(['ps', '-q', 'db']);
    return {
      verifiedMigrations: expected.split('\n').length,
      sourceHashes: Object.fromEntries(['load/compose.yml', 'deploy/init-db-roles.sh', 'deploy/db-roles.sql',
        'deploy/db-role-settings.sql', 'deploy/db-grants.sql'].map(name =>
        [name, createHash('sha256').update(readFileSync(join(source, name))).digest('hex')])),
      postgres: pg, postgresImageId: cmd('docker', ['inspect', '--format', '{{.Image}}', id]),
      migrationImageId: cmd('docker', ['image', 'inspect', '--format', '{{.Id}}', image]),
    };
  };
  const client = (role: string, args: string[], input?: string, planMode = 'auto', setup = false) => dc([
    'exec', '-T', '-e', `PGOPTIONS=${setup ? setupOptions(pgOptions) : pgOptions} -c plan_cache_mode=${planMode}`, '-e', 'LC_ALL=C', 'db',
    'sh', '-c', role === runtime ? 'export PGPASSWORD="$POSTGRES_APP_PASSWORD"; exec "$@"' :
      'export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"',
    'sql-probe', args[0], '-h', '127.0.0.1', '-U', role, '-d', 'fukulow', ...args.slice(1),
  ], input);
  const psql = (sql: string, role = owner, mode = 'auto') =>
    client(role, ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-f', '-'], sql, mode);
  // Seed, settle and VACUUM at full fixture size run without the measurement statement_timeout.
  const setup = (sql: string) =>
    client(owner, ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-f', '-'], sql, 'auto', true);
  const logPrefix = '/tmp/fk515d-pgbench';
  const pgbench = (script: string, variables: Record<string, string | number>, count: number) => {
    const report = client(runtime, ['pgbench', '-n', '-c', '1', '-j', '1', '-M', 'simple', '-t', String(count),
      '-l', '--log-prefix=' + logPrefix, '-f', '/dev/stdin',
      ...Object.entries(variables).flatMap(([key, value]) => ['-D', key + '=' + value])], script);
    const log = dc(['exec', '-T', 'db', 'sh', '-ec', `cat ${logPrefix}.* && rm ${logPrefix}.*`]);
    return { report, log };
  };
  const stop = () => dc(['down', '--volumes']);
  // The caller has already run and verified the one-shot migration container.
  const startApp = () => {
    dc(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90', 'app']);
    const base = 'http://' + dc(['port', 'app', '8080']);
    const id = dc(['ps', '-q', 'app']);
    return { base, logs: () => cmd('docker', ['logs', id]) };
  };
  return { start, stop, psql, setup, pgbench, pgImage: pg, startApp };
}

export type Stack = ReturnType<typeof stack>;

export const organization = '10000000-0000-4000-8000-000000000001';
const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const channel = (n: number) => id('2', n);
export const member = id('3', 0);
// These are synthetic bytea keys with no matching bearer token or cookie.
export const token = '\\x' + '0'.repeat(64);

export function seed(db: Stack, arm: Arm, sizes: readonly number[], readerHash?: string) {
  if (readerHash !== undefined && !/^[0-9a-f]{64}$/.test(readerHash)) throw new Error('Invalid fixture Session hash');
  const sessionHash = "decode(lpad(to_hex(n),64,'0'),'hex')";
  const hash = readerHash === undefined ? sessionHash : `CASE WHEN n = 0 THEN decode('${readerHash}','hex') ELSE ${sessionHash} END`;
  const channels = Array.from({ length: fixture.channels }, (_, i) => channel(i));
  db.setup(`BEGIN;
    INSERT INTO organizations (organization_id,name) VALUES ('${organization}','Organization A');
    INSERT INTO accounts (id,email,password_hash)
      SELECT md5('fk515d/account/' || n)::uuid,'member-' || n || '@example.invalid','sql-probe-no-login'
      FROM generate_series(0,${fixture.members - 1}) n;
    INSERT INTO users (organization_id,id,account_id,name,role)
      SELECT '${organization}', ('30000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
        md5('fk515d/account/' || n)::uuid, 'Load Member', 'member'
      FROM generate_series(0,${fixture.members - 1}) n;
    INSERT INTO account_sessions (token_hash,account_id)
      SELECT ${hash},md5('fk515d/account/' || n)::uuid
      FROM generate_series(0,${fixture.members - 1}) n;
    INSERT INTO channels (organization_id,id,name,visibility)
      VALUES ${channels.map((channelId, i) => `('${organization}','${channelId}','load-${i}','public')`).join(',')};
    COMMIT;`);
  db.setup('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
  db.setup(autovacuumSQL);
  db.setup(prefillSQL(organization, channels, channels.map((_, i) => sizes[i] ?? 0)));
  db.setup(channelLogSQL(arm, organization, channels.slice(0, sizes.length)));
  const settings: unknown = JSON.parse(db.psql(appliedSettingsSQL));
  const checksum = db.psql(checksumSQL);
  if (!/^[0-9a-f]{32}$/.test(checksum)) throw new Error('Missing fixture checksum');
  db.setup(settleSQL);
  const generation = arm === 'A' ? db.psql(`SELECT history_generation FROM organizations WHERE organization_id='${organization}';`) : null;
  if (generation !== null && !/^[0-9a-f-]{36}$/.test(generation)) throw new Error('Missing history generation');
  return { settings, checksum, generation };
}
