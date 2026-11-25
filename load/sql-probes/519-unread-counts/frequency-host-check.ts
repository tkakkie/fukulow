import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { pinned } from '../../harness-core/cpusets.ts';
import { sets796 } from '../../harness-core/frequency-layout.ts';
import { tcpReadinessArgs, waitReady } from '../../harness-core/postgres.ts';
import { containerCpuReadback, frequencyClientArgs, frequencyContainerReadbacks, frequencyServerArgs, type ContainerCpusets } from './frequency-containers.ts';
import { hostAffinityProblems, readHostAffinity, type HostAffinity } from './frequency-host-affinity.ts';
import { withSpotCheck, type SpotCheck } from './frequency-spot-check.ts';

const docker = (argv: string[]) => execFileSync('docker', argv, { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' }).trim();
const host = { docker, readHostAffinity, containerCpuReadback, withSpotCheck };

type HostCheckRecord = {
  label: 'not evidence'; at: string; ok: boolean; affinity: HostAffinity | null; containerCpusets: ContainerCpusets | null;
  abstractSocket: string | null; turbostat: SpotCheck | null; problems: string[];
};

export async function checkFrequencyHost(keep: (record: HostCheckRecord) => void, io = host) {
  const session = `fk519-host-check-${randomUUID()}`;
  const server = `${session}-server`, client = `${session}-client`;
  const label = `io.fukulow.host-check=${session}`;
  const ownedContainers = () => io.docker(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const record: HostCheckRecord = {
    label: 'not evidence', at: new Date().toISOString(), ok: false,
    affinity: null, containerCpusets: null, abstractSocket: null, turbostat: null, problems: [],
  };
  let startingContainers = false;
  try {
    record.affinity = io.readHostAffinity(session);
    record.problems.push(...hostAffinityProblems(record.affinity, session, record.affinity.bootId ?? undefined));
    if (record.problems.length) return false;
    if (io.docker(['ps', '-q'])) throw new Error('host check needs an idle host without running containers');
    const launch = (name: string, args: string[]) => io.docker(['run', '-d', '--rm', '--pull=never', '--name', name, '--label', label, ...args]);
    startingContainers = true;
    launch(server, ['--network', 'none', '-e', 'POSTGRES_PASSWORD=probe', ...frequencyServerArgs()]);
    await waitReady(() => {
      try {
        io.docker(tcpReadinessArgs(['exec', server]));
        return true;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 1 || status === 2) return false; // pg_isready: rejecting or no response.
        throw error;
      }
    }, { tries: 61, delayMs: 1000, stable: 1 });
    launch(client, frequencyClientArgs(server));
    record.containerCpusets = frequencyContainerReadbacks(session, server, client, io.docker, io.containerCpuReadback);
    record.abstractSocket = io.docker(['exec', '--user', 'postgres', client, ...pinned(sets796.client,
      ['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
        '-c', 'SELECT inet_client_addr() IS NULL AND inet_server_addr() IS NULL'])]);
    if (record.abstractSocket !== 't') throw new Error('expected a psql round trip over the abstract Unix socket');
    await io.withSpotCheck(() => wait(250), AbortSignal.timeout(15_000), raw => { record.turbostat = raw; });
  } catch (error) {
    record.problems.push(String(error));
  } finally {
    if (startingContainers) {
      try {
        const owned = ownedContainers();
        for (const name of [client, server]) {
          if (!owned.includes(name)) continue;
          try { io.docker(['rm', '-f', name]); }
          catch (error) { record.problems.push(`Docker cleanup of ${name}: ${String(error)}`); }
        }
        if (ownedContainers().length) throw new Error('host check containers remain');
      } catch (error) {
        record.problems.push(`Docker cleanup: ${String(error)}`);
      }
    }
    record.ok = record.problems.length === 0;
    keep(record);
  }
  return record.ok;
}

if (import.meta.main) {
  if (platform() !== 'linux' || process.getuid?.() === 0) {
    console.log(JSON.stringify({ label: 'not evidence', ok: false, problems: ['run on the prepared Ubuntu host as the measurement user'] }));
    process.exitCode = 1;
  } else if (!await checkFrequencyHost(record => console.log(JSON.stringify(record, null, 2)))) {
    process.exitCode = 1;
  }
}
