import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { containerCpuArgs } from '../../harness-core/frequency-container-args.ts';
import { frequencyContainerReadbacks } from '../../sql-probes/519-unread-counts/frequency-containers.ts';
import { checkPlacement } from '../../revocation-holds-placement.ts';
import { boundedCommand, command, CommandTimeoutError, docker, sql } from '../bench.ts';
import { argumentsForPostgres } from '../d3r/manifest.ts';
import { readSource } from '../d3r/path.ts';
import { forceSearchRls } from '../d3r/rls.ts';
import { resolveImage } from '../manifest.ts';
import { ownershipLabel, ownershipPrefix, timeouts } from '../runtime.ts';
import { literal } from '../seed.ts';
import { baseFixtureSql } from './arms.ts';
import { base, settings } from './manifest.ts';

const socket = '/var/run/postgresql';
const dataDir = '/var/lib/postgresql';
const template = 'leak_template';

export function names() {
  const server = ownershipPrefix + randomUUID();
  return {server, data: `${server}-data`, client: `${server}-client`, socket: `${server}-socket`};
}
export type Names = ReturnType<typeof names>;

export function cleanupCluster(resources: Names) {
  const call = (...args: string[]) => boundedCommand('docker', args, timeouts.cleanup);
  const containers = [resources.client, resources.server];
  const volumes = [resources.socket, resources.data];
  const containerNames = () => call('container', 'ls', '-a', '--format', '{{.Names}}').split('\n');
  const volumeNames = () => call('volume', 'ls', '--format', '{{.Name}}').split('\n');
  const failures: string[] = [];
  const remove = (kind: string, present: string[], expected: string[]) => {
    for (const name of expected.filter(value => present.includes(value))) {
      try { call(kind, 'rm', '-f', name); }
      catch (error) { failures.push(`${kind} cleanup failed: ${String(error)}`); }
    }
  };
  remove('container', containerNames(), containers);
  remove('volume', volumeNames(), volumes);
  assert.ok(![...containerNames(), ...volumeNames()].some(name => [...containers, ...volumes].includes(name)),
    'Owned Docker resources remain');
  assert.equal(failures.length, 0, failures.join('\n'));
}

export const database = (client: string, db: string) => ({
  owner: (text: string) => sql(client, db, text),
  app: (text: string) => sql(client, db, text, 'fukulow_app'),
});

export function serverIdentity(resources: Names) {
  const image = resolveImage(docker, base.image, true).id;
  for (const container of [resources.client, resources.server]) {
    assert.equal(docker('inspect', '--format', '{{.Image}}', container), image, 'Container image differs from the pin');
  }
  const {owner} = database(resources.client, 'postgres');
  const effective = JSON.parse(owner(`SELECT json_object_agg(name,setting) FROM pg_settings
    WHERE name IN (${Object.keys(settings).map(literal).join(', ')});`));
  assert.deepEqual(effective, settings, 'Effective PostgreSQL settings differ');
  assert.equal(owner('SHOW server_version_num;'), '180006');
  assert.equal(owner('SHOW shared_preload_libraries;'), '');
  assert.equal(owner("SELECT count(*) FROM pg_available_extensions WHERE name='pgroonga';"), '0');
  return {image: {reference: base.image, id: image}, settings: effective};
}

export function placement({server, client}: Names, session: string) {
  return frequencyContainerReadbacks(session, server, client, args => docker(...args), (inspect, set) => {
    const pid = Number(inspect.trim().split(' ')[1]);
    const proc = checkPlacement(set === 'server' ? 'postgres' : 'client', pid);
    return {cgroup: proc.cgroup, effective: proc.cpuset};
  });
}

export async function start(resources: Names, session?: string) {
  const {server, data, client, socket: socketVolume} = resources;
  const image = resolveImage(docker, base.image, true).id;
  for (const volume of [data, socketVolume]) docker('volume', 'create', '--label', ownershipLabel, volume);
  const socketMount = `type=volume,source=${socketVolume},target=${socket}`;
  const params = (name: string, role: 'server' | 'client') =>
    ['run', '-d', '--label', ownershipLabel, '--name', name, '--network=none', ...(session ? containerCpuArgs(role) : [])];
  command('docker', [...params(server, 'server'), `--shm-size=${base.shmBytes}`,
    '--mount', `type=volume,source=${data},target=${dataDir}`, '--mount', socketMount,
    '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=postgres', '-e', 'POSTGRES_PASSWORD',
    image, ...argumentsForPostgres, '-c', 'autovacuum=off'], undefined, {...process.env, POSTGRES_PASSWORD: randomUUID()});
  docker(...params(client, 'client'), '--tmpfs', dataDir, '--mount', `${socketMount},readonly,volume-nocopy`,
    '-e', `PGHOST=${socket}`, '-e', 'LC_ALL=C', '--entrypoint', 'sleep', image, 'infinity');
  const {owner} = database(client, 'postgres');
  for (let i = 0; i < base.timing.startupAttempts; i++) {
    let ready = false;
    try {
      docker('exec', client, 'pg_isready', '-U', 'fukulow', '-d', 'postgres');
      ready = owner('SELECT NOT pg_is_in_recovery() AND inet_server_addr() IS NULL;') === 't';
    } catch (error) {
      if (error instanceof CommandTimeoutError) throw error;
    }
    if (ready) return {server: serverIdentity(resources), placement: session ? placement(resources, session) : null};
    await new Promise(resolve => setTimeout(resolve, base.timing.startupPollMs));
  }
  throw new Error('PostgreSQL startup timed out');
}

export function migrate(client: string) {
  const {owner} = database(client, 'postgres');
  owner(`BEGIN;
${readSource('deploy/db-role-settings.sql')}
SET LOCAL fukulow.app_password = '${randomUUID()}';
${readSource('deploy/db-roles.sql')}
COMMIT;
CREATE DATABASE ${template} TEMPLATE template0;`);
  const setup = database(client, template).owner;
  setup(base.migrations.map(file => `BEGIN;\n${readSource(file)}\nCOMMIT;`).join('\n'));
  setup(`${forceSearchRls}\n${readSource('deploy/db-grants.sql')}\n${baseFixtureSql()}`);
}

export function clone(client: string, name: string) {
  assert.match(name, /^leak_[a-z0-9_]+$/);
  database(client, 'postgres').owner(`CREATE DATABASE ${name} TEMPLATE ${template};`);
  return database(client, name);
}
