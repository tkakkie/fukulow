import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpuList } from '../../harness-core/cpusets.ts';
import { containerCpuArgs } from '../../harness-core/frequency-container-args.ts';
import { measurementSlice, sets796 } from '../../harness-core/frequency-layout.ts';
import { sqlState, waitReady } from '../../harness-core/postgres.ts';
import { checkPlacement } from '../../revocation-holds-placement.ts';
import { boundedCommand, command, CommandTimeoutError, docker, sql } from '../bench.ts';
import { resolveImage } from '../manifest.ts';
import { snapshotLaunch } from '../d3r/snapshot.ts';
import { cleanupCluster, names as baseNames, placement } from '../d3r-leak/cluster.ts';
import { ownershipLabel, timeouts } from '../runtime.ts';
import { appSettings, base, db, k6Reference, sourceCommit } from './design.ts';
import type { Options } from './options.ts';

const dataDir = '/var/lib/postgresql';
const socket = '/var/run/postgresql';

export function names() {
  const names = baseNames();
  return {...names, network: names.server + '-net', app: names.server + '-app', migrate: names.server + '-migrate',
    k6: names.server + '-k6'};
}
export type Names = ReturnType<typeof names>;
export const containers = ({server, client, app, migrate, k6}: Names) => [server, client, app, migrate, k6];

export function cleanup(resources: Names) {
  const call = (...args: string[]) => boundedCommand('docker', args, timeouts.cleanup);
  const errors: Error[] = [];
  const attempt = (action: () => void) => {
    try { action(); } catch (error) { errors.push(error as Error); }
  };
  const existing = () => call('container', 'ls', '-a', '--format', '{{.Names}}').split('\n');
  for (const name of [resources.k6, resources.app, resources.migrate]) {
    attempt(() => { if (existing().includes(name)) call('rm', '-fv', name); });
  }
  attempt(() => cleanupCluster(resources));
  const networks = () => call('network', 'ls', '--format', '{{.Name}}').split('\n');
  attempt(() => { if (networks().includes(resources.network)) call('network', 'rm', resources.network); });
  attempt(() => assert.ok(!existing().some(name => containers(resources).includes(name)) &&
    !networks().includes(resources.network), 'Owned Phase A resources remain'));
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
}

export const owner = (resources: Names, text: string) => sql(resources.client, db, text);
export const appSql = (resources: Names, text: string) => sql(resources.client, db, text, 'fukulow_app');

export function images(options: Options) {
  const pg = resolveImage(docker, base.image, true).id;
  const app = resolveImage(docker, options.appImage, true).id;
  const revision = docker('image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', app);
  assert.equal(revision, sourceCommit, 'App image revision differs from the pinned production commit');
  const k6 = resolveImage(docker, k6Reference, true).id;
  return {pg, app, k6};
}
export type Images = ReturnType<typeof images>;

export function verifyImage(container: string, expected: string) {
  assert.equal(docker('inspect', '--format', '{{.Image}}', container), expected, `Image identity mismatch: ${container}`);
}

export function isolatedArgs(name: string, cpu: 'server' | 'client', measured: boolean) {
  return ['--name', name, '--label', ownershipLabel, ...(measured ? containerCpuArgs(cpu) : [])];
}

async function ready(service: string, check: () => string) {
  try {
    await waitReady(() => {
      try { check(); return true; }
      catch (error) {
        if (error instanceof CommandTimeoutError) throw error;
        return false;
      }
    }, {tries: base.timing.startupAttempts, delayMs: base.timing.startupPollMs});
  } catch {
    throw new Error(`${service} did not become ready`);
  }
}

export async function start(resources: Names, images: Images, session?: string, from?: string) {
  const {server, data, client, network, socket: socketVolume, migrate} = resources;
  const pgPassword = randomUUID(), appPassword = randomUUID();
  const launch = from ? snapshotLaunch(from) : {args: [], options: []};
  for (const volume of [data, socketVolume]) docker('volume', 'create', '--label', ownershipLabel, volume);
  docker('network', 'create', '--internal', '--label', ownershipLabel, network);
  const mount = `type=volume,source=${socketVolume},target=${socket}`;
  const deploy = ['init-db-roles.sh', 'db-roles.sql', 'db-role-settings.sql', 'db-grants.sql'];
  command('docker', ['run', '-d', ...isolatedArgs(server, 'server', !!session), '--network', network,
    '--network-alias', 'db', '--mount', `type=volume,source=${data},target=${dataDir}`, '--mount', mount,
    ...deploy.flatMap(file => ['-v', `${process.cwd()}/deploy/${file}:${file.endsWith('.sh') ?
      '/docker-entrypoint-initdb.d/10-db-roles.sh' : '/opt/fukulow/' + file}:ro`]),
    '-e', 'POSTGRES_USER=fukulow', '-e', `POSTGRES_DB=${db}`, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_APP_PASSWORD',
    ...launch.options, images.pg, ...launch.args, 'postgres'], undefined,
  {...process.env, POSTGRES_PASSWORD: pgPassword, POSTGRES_APP_PASSWORD: appPassword});
  docker('run', '-d', ...isolatedArgs(client, 'client', !!session), '--network=none', '--tmpfs', dataDir,
    '--mount', `${mount},readonly,volume-nocopy`, '-e', `PGHOST=${socket}`, '-e', 'LC_ALL=C',
    '--entrypoint', 'sleep', images.pg, 'infinity');
  await ready('PostgreSQL', () => docker('exec', server, 'pg_isready', '-h', '127.0.0.1', '-U', 'fukulow', '-d', db));
  assert.equal(owner(resources, 'SELECT NOT pg_is_in_recovery();'), 't', 'Cluster has not finished recovery');
  verifyImage(server, images.pg);
  verifyImage(client, images.pg);
  if (!from) {
    command('docker', ['run', ...isolatedArgs(migrate, 'server', !!session), '--network', network,
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '-e', 'DATABASE_URL',
      images.app, 'migrate'], undefined,
    {...process.env, DATABASE_URL: `postgres://fukulow:${pgPassword}@db:5432/${db}`});
    verifyImage(migrate, images.app);
  }
  return {appPassword, placement: session ? placement(resources, session) : null};
}

export function refreshRestoredRole(resources: Names, password: string) {
  // The archive's role receives a fresh password using the deployed role setup.
  command('docker', ['exec', '-e', 'POSTGRES_APP_PASSWORD', resources.server, '/docker-entrypoint-initdb.d/10-db-roles.sh'],
    undefined, {...process.env, POSTGRES_APP_PASSWORD: password});
}

export function lanePlacement(container: string, lane: 'server' | 'client') {
  const [pid, parent, cpus] = docker('inspect', '--format',
    '{{.State.Pid}}|{{.HostConfig.CgroupParent}}|{{.HostConfig.CpusetCpus}}', container).split('|');
  assert.equal(parent, measurementSlice, `Container cgroup differs from #796: ${container}`);
  assert.equal(cpus, cpuList(sets796[lane]), `Container CPUs differ from #796: ${container}`);
  return checkPlacement(lane, Number(pid));
}

// Default maintenance_work_mem can make the large concurrent rebuild longer
// than the regular psql helper's statement deadline. The supervisor owns cleanup.
export function maintenanceSql(container: string, text: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-XqAt', '-v', 'VERBOSITY=verbose',
      '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', db], {stdio: ['pipe', 'ignore', 'pipe'], signal});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    child.stdin.on('error', () => { /* subprocess exit supplies the diagnostic */ });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`PostgreSQL maintenance did not complete (SQLSTATE ${sqlState(stderr) ?? 'unavailable'})`));
    });
    child.stdin.end(text + '\n');
  });
}

export async function startApp(resources: Names, images: Images, password: string, measured: boolean) {
  const start = ['run', '-d', ...isolatedArgs(resources.app, 'server', measured), '--network', resources.network,
    '--network-alias', 'app', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--ulimit', 'nofile=65536:65536', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
    '-e', 'FUKULOW_SETUP_TOKEN', '-e', 'DATABASE_URL',
    ...Object.entries(appSettings).flatMap(([key, value]) => ['-e', `${key}=${value}`]), images.app];
  command('docker', start, undefined, {...process.env, FUKULOW_SETUP_TOKEN: randomUUID(),
    DATABASE_URL: `postgres://fukulow_app:${password}@db:5432/${db}`});
  await ready('App', () => docker('exec', resources.app, 'fukulow-server', 'probe'));
  verifyApp(resources, images);
  return measured ? lanePlacement(resources.app, 'server') : null;
}

export function verifyApp(resources: Names, images: Images) {
  verifyImage(resources.app, images.app);
  const env: string[] = JSON.parse(docker('inspect', '--format', '{{json .Config.Env}}', resources.app));
  assert.ok(Object.entries(appSettings).every(([key, value]) => env.includes(`${key}=${value}`)) &&
    env.some(line => /^DATABASE_URL=postgres:\/\/fukulow_app:[^@]+@db:5432\/fukulow$/.test(line)),
  'App settings or database identity mismatch');
}

export async function stopApp(resources: Names) {
  // The idle step has PostgreSQL's background workers only.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['stop', '--time=75', resources.app], {stdio: 'ignore', timeout: 90_000, killSignal: 'SIGKILL'});
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('App did not stop cleanly')));
  });
  assert.equal(docker('inspect', '--format', '{{.State.Running}}', resources.app), 'false');
}
