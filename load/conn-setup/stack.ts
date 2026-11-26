import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { allowedCpus, cpuList } from '../harness-core/cpusets.ts';
import { measurementSlice, sets796 } from '../harness-core/frequency-layout.ts';
import { tcpReadinessArgs, waitReady } from '../harness-core/postgres.ts';

export const workloadLabel = 'io.fukulow.conn-setup=1066';
export const postgresLogLabel = 'io.fukulow.conn-setup-db=1066';
export const postgresImage = () => imagePin('compose.yml', /^    image: (postgres:\S+)$/m);
export const k6Image = () => imagePin('Makefile', /^K6_IMAGE := (\S+)$/m);

function imagePin(path: string, pattern: RegExp) {
  const image = pattern.exec(readFileSync(path, 'utf8'))?.[1];
  if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`Missing image pin in ${path}`);
  return image;
}

const exec = promisify(execFile);

export function stack(out: string, trafficEnv: Record<string, string>, linux: boolean, signal: AbortSignal) {
  const project = `fukulow-1066-${randomUUID().slice(0, 12)}`;
  const image = `${project}:local`;
  const traffic = `${project}-traffic`;
  const override = join(out, 'compose.json');
  const env = {
    ...Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR']
      .map(key => [key, process.env[key]])),
    FUKULOW_VERSION: 'local',
    POSTGRES_PASSWORD: randomUUID(),
    POSTGRES_APP_PASSWORD: randomUUID(),
    FUKULOW_SETUP_TOKEN: randomUUID(),
    LOAD_PASSWORD: randomUUID(),
  };
  const placement = (cpus: number[]) => linux ? { cpuset: cpuList(cpus), cgroup_parent: measurementSlice } : {};
  const server = placement(sets796.server);
  const compose = ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'compose.yml', '-f', override];
  const docker = async (args: string[], timeout = 30_000, abort?: AbortSignal) => {
    const { stdout } = await exec('docker', args, { env, timeout, signal: abort });
    return stdout.trim();
  };
  const dc = (args: string[], timeout?: number) => docker([...compose, ...args], timeout, signal);

  function capture(args: string[], output: string, errors: string, timeout: number) {
    const stdout = openSync(join(out, output), 'a');
    const stderr = output === errors ? stdout : openSync(join(out, errors), 'a');
    try {
      const child = spawn('docker', args, {
        env, stdio: ['ignore', stdout, stderr], signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      });
      return new Promise<number | null>(resolve => {
        // With redirected output, close also reports spawn failures.
        child.on('error', error => console.error(`Docker process: ${error.name}`));
        child.on('close', resolve);
      });
    } finally {
      closeSync(stdout);
      if (stderr !== stdout) closeSync(stderr);
    }
  }

  const verifyPin = async (container: string, expected: number[]) => {
    const status = await docker(['exec', container, 'cat', '/proc/1/status'], undefined, signal);
    const actual = allowedCpus(status);
    if (cpuList(actual) !== cpuList(expected)) throw new Error(`Unexpected CPU affinity on ${container}`);
    return actual;
  };

  return {
    async start() {
      if (linux && await docker(['info', '--format', '{{.CgroupDriver}} {{.CgroupVersion}}'], undefined, signal) !== 'systemd 2') {
        throw new Error('Linux placement requires Docker with the systemd cgroup v2 driver');
      }
      writeFileSync(override, JSON.stringify({ services: {
        app: { image, labels: [workloadLabel], ...server },
        migrate: { image, labels: [workloadLabel], ...server },
        db: { labels: [workloadLabel, postgresLogLabel], ...server },
        traffic: {
          image: k6Image(), labels: [workloadLabel], ...placement(sets796.client),
          profiles: ['harness'], networks: ['backend'],
          volumes: [`${process.cwd()}:/work:ro`], working_dir: '/work',
          environment: {
            ...trafficEnv, BASE_URL: 'http://app:8080',
            LOAD_BOOTSTRAP: '1', LOAD_EMAIL: 'load@example.invalid',
            LOAD_PASSWORD: '${LOAD_PASSWORD:?}', LOAD_SETUP_TOKEN: '${FUKULOW_SETUP_TOKEN:?}',
          },
          command: ['run', '--quiet', '--log-format=raw', 'load/scenario.ts'],
        },
      } }), { mode: 0o600 });
      if (await capture(['build', '--target', 'conn-setup', '-t', image, '.'], 'build.log', 'build.log', 45 * 60_000) !== 0) {
        throw new Error('App image build failed. See build.log');
      }
      await dc(['pull', 'traffic'], 180_000);
      await dc(['up', '-d', '--wait', '--wait-timeout', '60', 'db'], 180_000);
      const probe = tcpReadinessArgs([...compose, 'exec', '-T', 'db']);
      await waitReady(() => {
        signal.throwIfAborted();
        return spawnSync('docker', probe, { env, stdio: 'ignore', timeout: 5_000 }).status === 0;
      });
      const scram = await dc(['exec', '-T', 'db', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow', '-c',
        "SELECT EXISTS (SELECT FROM pg_hba_file_rules WHERE type = 'host' AND address = 'all' AND auth_method = 'scram-sha-256' AND error IS NULL) AND EXISTS (SELECT FROM pg_authid WHERE rolname = 'fukulow_app' AND rolpassword LIKE 'SCRAM-SHA-256$%')"]);
      if (scram !== 't') throw new Error('Production SCRAM authentication check failed');
      await dc(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'app'], 150_000);
      if (!linux) return null;
      return {
        app: await verifyPin(await dc(['ps', '-q', 'app']), sets796.server),
        db: await verifyPin(await dc(['ps', '-q', 'db']), sets796.server),
      };
    },
    sample(state: 'idle' | 'loaded', count: number) {
      return capture([...compose, 'exec', '-T', 'app', 'measure_conn_setup', String(count)],
        `${state}.jsonl`, 'sampler.log', 130_000);
    },
    startTraffic() {
      return capture([...compose, 'run', '--rm', '--no-deps', '-T', '--name', traffic, 'traffic'],
        'traffic.log', 'traffic.log', 240_000);
    },
    trafficPin: () => linux ? verifyPin(traffic, sets796.client) : Promise.resolve(null),
    async down() {
      if (existsSync(override)) {
        // Do not use the run's abort signal during cleanup.
        const oneOff = await docker(['ps', '-aq', '--filter', `name=^/${traffic}$`]);
        if (oneOff) await docker(['rm', '-f', oneOff]);
        await docker([...compose, '--profile', 'harness', 'down', '--volumes', '--remove-orphans', '--timeout', '5'], 45_000);
        if (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])) {
          throw new Error('Compose containers remain after cleanup');
        }
        rmSync(override, { force: true });
      }
      await docker(['image', 'inspect', image]).then(
        () => docker(['image', 'rm', image]),
        () => undefined,
      );
    },
  };
}
