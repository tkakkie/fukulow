import { pinned } from '../../harness-core/cpusets.ts';

export function parseCandidate(candidate: string | undefined, sendsOnly: boolean, stage: string | undefined) {
  if (candidate === undefined) return undefined;
  if (candidate !== 'f1') throw new Error(`unknown --candidate ${candidate}; expected f1`);
  if (!sendsOnly) throw new Error('--candidate f1 requires --sends-only with --diagnostic or --smoke');
  if (stage !== undefined && stage !== 'formal') throw new Error('--candidate f1 uses --frequency-v3 formal');
  return candidate;
}

export function validateAttribution(
  diagnostic: boolean, smoke: boolean, sendsOnly: boolean, stage: string | undefined, linux: boolean,
) {
  if (diagnostic === smoke || !sendsOnly) throw new Error('--attribution requires --sends-only with --diagnostic or --smoke');
  // A smoke run only checks that the attribution SQL works on a real server; it measures nothing.
  if (smoke) {
    if (stage !== undefined) throw new Error('--smoke --attribution takes no --frequency-v3');
    return;
  }
  if ((stage !== undefined || linux) && stage !== 'formal') throw new Error('--attribution uses --frequency-v3 formal for #796 placement on Linux');
}

export const walKeepGiB = 8;
export const attributionSettings = [
  'shared_preload_libraries=pg_stat_statements', 'pg_stat_statements.track=all', 'pg_stat_statements.track_planning=off',
  'track_functions=all', `wal_keep_size=${walKeepGiB}GB`,
];

export const postgresSettingsArgs = (attribution: boolean) => [
  '-c', 'shared_buffers=512MB', '-c', 'jit=off',
  // A forced CHECKPOINT opens each block. An automatic checkpoint crossing the block fails the run.
  '-c', 'max_wal_size=64GB', '-c', 'checkpoint_timeout=1h', '-c', 'log_checkpoints=on',
  ...(attribution ? attributionSettings.flatMap(setting => ['-c', setting]) : []),
];

export function sendPgbenchArgs(container: string, clientCpus: number[] | undefined, separateClient: boolean,
  seconds: number, db: string, logPrefix?: string) {
  return ['exec', ...(separateClient ? ['--user', 'postgres'] : []), container, ...pinned(clientCpus,
    ['pgbench', '-U', 'fukulow_app', '-n', '-c', '8', '-j', '4', '-T', String(seconds), '-f', '/work/sql/bench.pgb']),
  ...(logPrefix === undefined ? [] : ['-l', `--log-prefix=${logPrefix}`]), db];
}

// psql -c with several statements prints only the last result, so each boundary query gets its own -c.
export const boundaryCommandArgs = (queries: string[]) => queries.flatMap(query => ['-c', query]);
