import { execFile } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { allowedCpus, pinned } from '../../harness-core/cpusets.ts';
import { same, sets796 } from './frequency-evidence.ts';

const exec = promisify(execFile);
// Select the actual measured client by its unique log prefix and a connected backend for its database.
const inspect = `
for f in /proc/[0-9]*/comm; do
  IFS= read -r name < "$f" || continue
  proc=\${f%/comm}
  case "$name" in
    pgbench)
      tr '\\000' '\\n' < "$proc/cmdline" | grep -Fxq -- "$1" || continue
      printf 'client %s\\n' "\${proc##*/}"
      awk '/^Cpus_allowed_list:/{print}' "$proc/status"
      for task in "$proc"/task/[0-9]*; do
        printf 'thread %s\\n' "\${task##*/}"
        awk '/^Cpus_allowed_list:/{print}' "$task/status"
      done
      ;;
    postgres)
      case "$(tr '\\000' ' ' < "$proc/cmdline")" in
        "postgres: fukulow_app $2 "*)
          printf 'backend %s\\n' "\${proc##*/}"
          awk '/^Cpus_allowed_list:/{print}' "$proc/status"
          ;;
      esac
      ;;
  esac
done
`;

export type Affinity = { kind: string; pid: number; cpus: number[] }[];
export async function readAffinity(container: string, prefix: string, db: string, signal: AbortSignal): Promise<Affinity> {
  await wait(2000, undefined, { signal });
  const { stdout } = await exec('docker', ['exec', container,
    ...pinned(sets796.client, ['sh', '-c', inspect, 'inspect', `--log-prefix=${prefix}`, db])], { signal, timeout: 5000 });
  const lines = stdout.trim().split('\n');
  return lines.flatMap((line, i) => {
    const m = /^(client|thread|backend) (\d+)$/.exec(line);
    return m ? [{ kind: m[1], pid: Number(m[2]), cpus: allowedCpus(lines[i + 1] ?? '') }] : [];
  });
}

export function affinityProblems(rows: Affinity | undefined) {
  const clients = rows?.filter(r => r.kind === 'client') ?? [];
  const threads = rows?.filter(r => r.kind === 'thread') ?? [];
  const backends = rows?.filter(r => r.kind === 'backend') ?? [];
  return clients.length === 1 && threads.length >= 4 && new Set(threads.map(r => r.pid)).size === threads.length &&
    threads.some(r => r.pid === clients[0].pid) && backends.length >= 1 &&
    [...clients, ...threads].every(r => same(r.cpus, sets796.client)) &&
    backends.every(r => same(r.cpus, sets796.server)) ? [] : ['measured pgbench process/thread or PostgreSQL backend CPU masks missing or incorrect'];
}
