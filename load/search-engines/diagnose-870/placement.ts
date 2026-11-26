import { containerCpuArgs } from '../../harness-core/frequency-container-args.ts';
import { checkPlacement } from '../../revocation-holds-placement.ts';
import { containerCpuReadback, frequencyContainerReadbacks } from '../../sql-probes/519-unread-counts/frequency-containers.ts';
import { CommandTimeoutError } from '../bench.ts';
import { ownershipLabel, ownershipPrefix, timeouts } from '../runtime.ts';
import { argumentsForPostgres } from '../d3r/manifest.ts';
import { snapshotLaunch } from '../d3r/snapshot.ts';
import { Refused, type Io } from './io.ts';

export const expectedSnapshotSha256 = '087a24f896f7f2e05a9e67b820edd47205c1ca63cad6a741f01a746700edbdac';
export const diagnosticSettings = ['-c', 'log_autovacuum_min_duration=0', '-c', 'log_checkpoints=on'];

export function resourceNames(id: string) {
  const server = `${ownershipPrefix}${id}`;
  return {server, client: `${server}-client`, data: `${server}-data`, socket: `${server}-socket`};
}
export type Resources = ReturnType<typeof resourceNames>;

const socketDir = '/var/run/postgresql';
export const postgresDataDir = '/var/lib/postgresql';
type ContainerIo = Pick<Io, 'docker' | 'command' | 'boundedCommand' | 'sql'>;
type Cluster = {snapshotDirectory: string; image: string; shmBytes: number; startupAttempts: number; startupPollMs: number};

export function diagnosticCluster(io: ContainerIo, names: Resources, cluster: Cluster, launchSession: string,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), readFile?: (path: string) => string) {
  const {server, client, data, socket} = names;
  const {docker} = io;
  const owner = (db: string, sql: string) => io.sql(client, db, sql);

  const check = async () => {
    // Both containers keep their mounts across docker restart. Test the actual client connection.
    for (let i = 0; i < cluster.startupAttempts; i++) {
      let ready = false;
      try {
        docker('exec', client, 'pg_isready', '-U', 'fukulow', '-d', 'postgres');
        ready = owner('postgres', 'SELECT NOT pg_is_in_recovery() AND inet_server_addr() IS NULL AND inet_client_addr() IS NULL;') === 't';
      } catch (error) {
        if (error instanceof CommandTimeoutError || error instanceof Refused) throw error;
      }
      if (ready) {
        const processes: Partial<Record<'server' | 'client', ReturnType<typeof checkPlacement>>> = {};
        const cpusets = frequencyContainerReadbacks(launchSession, server, client, args => docker(...args), (inspect, set) => {
          const cpuset = containerCpuReadback(inspect, set, readFile);
          const pid = Number(inspect.trim().split(' ')[1]);
          const process = checkPlacement(set === 'server' ? 'postgres' : 'client', pid, readFile);
          if (process.cgroup !== cpuset.cgroup) throw new Error(`${set} cgroup changed during placement readback`);
          processes[set] = process;
          return cpuset;
        });
        if (cpusets.server.cgroup === cpusets.client.cgroup) throw new Error('server and client share a Docker scope');
        return {cpusets, processes, transport: 'unix-socket'};
      }
      await sleep(cluster.startupPollMs);
    }
    throw new Error('PostgreSQL startup timed out waiting for the client Unix socket');
  };

  const runArgs = (name: string, role: 'server' | 'client') =>
    ['run', '-d', '--label', ownershipLabel, '--name', name, '--network=none', ...containerCpuArgs(role)];
  const mountSocket = `type=volume,source=${socket},target=${socketDir}`;
  return {
    owner,
    async start(password: string) {
      const launch = snapshotLaunch(cluster.snapshotDirectory);
      for (const volume of [data, socket]) docker('volume', 'create', '--label', ownershipLabel, volume);
      io.command('docker', [...runArgs(server, 'server'), `--shm-size=${cluster.shmBytes}`,
        '--mount', `type=volume,source=${data},target=${postgresDataDir}`, '--mount', mountSocket,
        ...launch.options, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=postgres',
        cluster.image, ...launch.args, ...argumentsForPostgres, ...diagnosticSettings], undefined, {...process.env, POSTGRES_PASSWORD: password});
      // Cover the image's data VOLUME so the client never creates an anonymous volume.
      docker(...runArgs(client, 'client'), '--tmpfs', postgresDataDir, '--mount', `${mountSocket},readonly,volume-nocopy`, '-e', `PGHOST=${socketDir}`,
        '--entrypoint', 'sleep', cluster.image, 'infinity');
      io.boundedCommand('docker', ['exec', server, 'sh', '-ec', 'until test -e /tmp/backfill-extracted; do sleep 1; done'], timeouts.psql);
      return check();
    },
    restart() {
      docker('restart', server);
      return check();
    },
  };
}
