import { execFile, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { outsideCheckout } from '../../proxy-target.ts';
import { allowedCpus, cpuList, parseCpuSets, pinned } from '../../harness-core/cpusets.ts';
import { containerCpuArgs } from '../../harness-core/frequency-container-args.ts';
import { hostRecord, linuxViolations } from '../../harness-core/host-record.ts';
import { bindLiterals, channels, checksumSql, countsCheckOutcome, eventsSince, extractListCounts, finishBlock, measuredPgbench, member, migrationOutcome, organization, pgbench, pgbenchEvidence, planSummary,
  quantile, sendBlocks, stopRule, timings, waitForCheckpointWindow } from './probe.ts';
import { frequencyRequest, frequencyRun } from './frequency-run.ts';
import { affinityProblems, readAffinity, type Affinity } from './frequency-affinity.ts';
import { frequencyClientArgs, frequencyContainerReadbacks, frequencyServerArgs, probeImage as image,
  serverImageArgs } from './frequency-containers.ts';
import { hostAffinityProblems, readHostAffinity } from './frequency-host-affinity.ts';
import type { CounterBlock, ReferenceWindow } from './frequency-evidence.ts';
import { frequencyWorkSeconds, pgbenchTimeoutGraceSeconds } from './frequency-timing.ts';
import { makeTraversable, stageSql } from './stage-sql.ts';

// #519 §10 step 1: focused SQL probe of the final A3 design (merged triggers and list SQL)
// against the commit before it. DIAGNOSTIC: it chooses nothing formal; only the stop rule applies.
const usage = 'node load/sql-probes/519-unread-counts/final.ts (--smoke | --diagnostic) [--sends-only] [--cpu-sets "server=LIST;client=LIST[;housekeeping=LIST]"] [--frequency-v3 control|rehearsal2|formal --perf-helper BINARY] --out NEW_DIRECTORY_OUTSIDE_CHECKOUT';
const { values } = parseArgs({ options: { out: { type: 'string' }, smoke: { type: 'boolean' }, diagnostic: { type: 'boolean' },
  'sends-only': { type: 'boolean' }, 'frequency-v3': { type: 'string' }, 'perf-helper': { type: 'string' }, 'control-review': { type: 'string' }, 'permission-check': { type: 'string' }, 'cpu-sets': { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) { console.log(usage); process.exit(0); }
if (!values.out || values.smoke === values.diagnostic) throw new Error(usage);
const smoke = values.smoke === true;
// Send re-measure (#519, approved 2026-11-23): sends only, one fresh database per block.
const sendsOnly = values['sends-only'] === true;
// Fixed before the run: the last unbounded check took about 33 min on three blocks' rows.
const checkTimeout = '45min';
// §10 step 1 runs under the shared host-busy marker; the diagnostic mode records it.
const markerPath = process.env.FUKULOW_HOST_BUSY;
const marker = markerPath ? readFileSync(markerPath, 'utf8').trim() : null;
// The launcher session that started this run (#796): recorded so a judge binds the output to it.
const launchSession = process.env.FUKULOW_LAUNCH_SESSION ?? null;
if (!smoke && !marker) throw new Error('--diagnostic needs FUKULOW_HOST_BUSY=<path of the held host-busy marker>');
// Linux host (#796 item 3, maintainer decision 2026-11-24): PostgreSQL and pgbench run on fixed,
// disjoint CPU sets, required for --diagnostic there. macOS runs are unchanged.
const cpuSets = values['cpu-sets'] === undefined ? undefined : parseCpuSets(values['cpu-sets'], cpus().length);
if (!smoke && platform() === 'linux' && cpuSets === undefined) throw new Error('--diagnostic on Linux needs --cpu-sets');
const frequencyStage = values['frequency-v3'];
if (frequencyStage === undefined && process.env.FUKULOW_LAUNCH_FREQUENCY) throw new Error('STOP: #796 needs --frequency-v3');
if (frequencyStage !== undefined && (smoke || !sendsOnly)) throw new Error('#796 v3 requires --diagnostic --sends-only');
const request = frequencyStage === undefined ? null : frequencyRequest(frequencyStage, values['perf-helper'], values['control-review'], values['permission-check'], launchSession, cpuSets, marker);
const control = request?.stage === 'control';
type FinalArm = 'current' | 'final';
const pins: Record<FinalArm, string> = { current: '5ef561e5', final: 'fd6a5949' };
const a3Migration = '202611221100_unread_counts.sql';
// Re-measure after #814 (#820, approved 2026-11-23): the final arm also applies the UPDATE-first
// follow-up, taken from its own pin. Unrelated migrations merged in between are not applied.
const updatePin = 'c672b0a4';
const a3Update = '202611231100_unread_counts_update_first.sql';
const cuts = smoke ? [75] : [75, 150, 575, 2150];
const samples = smoke ? 5 : 30;
const warmSeconds = smoke ? 5 : 60;
const measuredSeconds = smoke ? 5 : frequencyWorkSeconds;
const benchOrder: FinalArm[][] = smoke ? [['current', 'final']] : [['current', 'final'], ['final', 'current'], ['current', 'final']];

const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
process.chdir(root);
const out = outsideCheckout(values.out);
mkdirSync(out, { mode: 0o700 });
mkdirSync(join(out, 'plans'));
mkdirSync(join(out, 'latency'));
const save = (path: string, value: unknown) => writeFileSync(join(out, path), JSON.stringify(value, null, 2) + '\n');
let frequency: ReturnType<typeof frequencyRun> | null = null;
const exec = promisify(execFile);
const maxBuffer = 512 * 1024 * 1024;
const run = (cmd: string, args: string[], input?: string) => {
  const child = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer });
  if (child.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${child.stderr.slice(-2000)}`);
  return child.stdout;
};
const git = (...args: string[]) => run('git', args).trim();
const commits = { current: git('rev-parse', pins.current + '^{commit}'), final: git('rev-parse', pins.final + '^{commit}') };
if (git('rev-parse', commits.final + '^') !== commits.current) throw new Error('final pin must be the direct child of current');
const work = mkdtempSync(join(realpathSync(tmpdir()), 'fk519f-'));
// mkdtemp gives 0700; the v3 sends run as the container's postgres user, which must read the bind-mounted
// files (repository SQL only, nothing secret).
makeTraversable(work);
const container = 'fk519f-' + randomUUID();
const clientContainer = request ? `${container}-client` : container;
// The launcher's workloadLabel for this probe: it finds and removes both containers after a STOP.
const workloadLabel = 'io.fukulow.probe=519-final';

// Schema and roles from the current pin; the final arm adds only the A3 migration from its pin,
// applied after the seed as a deploy would (backfill under its own lock and check).
run('sh', ['-c', `git archive ${commits.current} server/migrations deploy/db-roles.sql deploy/db-grants.sql | tar -x -C "$1"`, 'sh', work]);
const changed = git('diff', '--name-only', commits.current, commits.final, '--', 'server/migrations');
if (changed !== `server/migrations/${a3Migration}`) throw new Error(`unexpected migration diff: ${changed}`);
writeFileSync(join(work, a3Migration), git('show', `${commits.final}:server/migrations/${a3Migration}`) + '\n');
const update = git('rev-parse', updatePin + '^{commit}');
if (spawnSync('git', ['merge-base', '--is-ancestor', commits.final, update]).status !== 0) throw new Error('update pin must descend from the final pin');
if (git('diff', '--name-status', commits.final, update, '--', `server/migrations/${a3Migration}`, `server/migrations/${a3Update}`) !== `A\tserver/migrations/${a3Update}`)
  throw new Error('update pin must add only the UPDATE-first migration and keep the A3 migration unchanged');
writeFileSync(join(work, a3Update), git('show', `${update}:server/migrations/${a3Update}`) + '\n');
// Only the SQL this probe opens, readable by the container postgres user whatever the umask; a
// symlinked input throws (stage-sql.ts).
stageSql(join(root, 'load/sql-probes/519-unread-counts/sql'), work);
for (const arm of ['current', 'final'] as FinalArm[]) {
  writeFileSync(join(work, `sql/list-${arm}.sql`), extractListCounts(git('show', `${commits[arm]}:server/src/messages/unread.rs`)) + '\n');
}
const migrations = readdirSync(join(work, 'server/migrations')).filter(f => f.endsWith('.sql')).sort();

// psql (setup, WAL counters, checks) runs on the client set too, so only the server works on the server set.
const psqlArgs = (db: string, user = 'postgres', stdin = true) => ['exec', ...(stdin ? ['-i'] : []), clientContainer, ...pinned(cpuSets?.client, ['psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db])];
const psql = (db: string, script: string, user = 'postgres') => run('docker', psqlArgs(db, user), script);
const file = (db: string, path: string) => psql(db, `\\i /work/${path}\n`);
const checks: Record<string, unknown>[] = [];
// Every message_counts_check, explicit or inside the A3 migration's backfill guard, runs under
// checkTimeout (a session SET, so it also covers the migration's transaction). Drift, a timeout or
// any error fails the run at once (fail fast); the check is never skipped or retried.
function bounded(db: string, label: string, script: string, outcome: (child: SpawnSyncReturns<string>) => ReturnType<typeof countsCheckOutcome>) {
  const startedAt = Date.now();
  const child = spawnSync('docker', psqlArgs(db), { input: `SET statement_timeout = '${checkTimeout}';\n${script}`, encoding: 'utf8', maxBuffer });
  const result = outcome(child);
  checks.push({ label, db, timeout: checkTimeout, seconds: (Date.now() - startedAt) / 1000, ...result });
  if (result.status !== 'ok') throw new Error(`${label}: ${result.status} (${result.rows ?? result.detail})`);
}
const countsCheck = (db: string, label: string) => bounded(db, `message_counts_check ${label}`,
  `SELECT count(*) FROM message_counts_check('${organization}');\n`, c => countsCheckOutcome(c.status, c.stdout ?? '', c.stderr ?? ''));
const migrateA3 = (db: string) => bounded(db, `A3 migration on ${db} (backfill guard runs message_counts_check)`,
  `BEGIN;\n\\i /work/${a3Migration}\nCOMMIT;\nBEGIN;\n\\i /work/${a3Update}\nCOMMIT;\n`, c => migrationOutcome(c.status, c.stderr ?? ''));
// Host state around each block. A diagnostic block refuses to start next to any other running
// container; after the block, any container still running or started during it fails the block.
// sinceSeconds is taken before the pre-block `docker ps` (eventsSince), so the windows overlap.
function hostState(sinceSeconds?: number) {
  const foreign = (name: string) => name !== '' && name !== container && name !== clientContainer;
  const otherContainers = run('docker', ['ps', '--format', '{{.Names}}']).split('\n').filter(foreign);
  const startedDuringBlock = sinceSeconds === undefined ? undefined : run('docker', ['events', '--since', String(sinceSeconds),
    '--until', String(Math.ceil(Date.now() / 1000)), '--filter', 'type=container', '--filter', 'event=start', '--format', '{{.Actor.Attributes.name}}'])
    .split('\n').filter(foreign);
  const busy = [...otherContainers, ...(startedDuringBlock ?? [])];
  return { at: new Date().toISOString(), loadavg: loadavg(), otherContainers, startedDuringBlock, busy: !smoke && busy.length > 0 };
}
function idleHost() {
  const host = hostState();
  if (host.busy) throw new Error(`host not idle: other containers ${host.otherContainers.join(', ')}`);
  return host;
}

function measure(db: string, arm: FinalArm, cut: number, array: string) {
  const sql = readFileSync(join(work, `sql/list-${arm}.sql`), 'utf8');
  const args = `'${organization}', ${member}, 0, '${array}'`;
  const scope = `SELECT set_config('fukulow.organization_id','${organization}',false) \\g /dev/null\n`;
  const role = JSON.parse(psql(db, `SELECT json_build_object('user', current_user, 'superuser', rolsuper, 'bypassRls', rolbypassrls,
    'rls', row_security_active('messages'), 'planCacheMode', current_setting('plan_cache_mode')) FROM pg_roles WHERE rolname = current_user;`, 'fukulow_app'));
  if (role.user !== 'fukulow_app' || role.superuser || role.bypassRls || !role.rls) throw new Error('Unexpected role or RLS state');
  const explain = psql(db, `${scope}PREPARE q(uuid,uuid,bigint,uuid[]) AS ${sql};
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE q(${args}) \\g /dev/null
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) EXECUTE q(${args});
COMMIT;\n`, 'fukulow_app');
  writeFileSync(join(out, `plans/${arm}-cut${cut}.json`), explain);
  const timed = psql(db, `${scope}PREPARE q(uuid,uuid,bigint,uuid[]) AS ${sql};
EXECUTE q(${args}) \\g /dev/null
\\timing on
${Array.from({ length: samples }, () => `EXECUTE q(${args}) \\g /dev/null`).join('\n')}
\\timing off
SELECT json_build_object('generic', generic_plans, 'custom', custom_plans) FROM pg_prepared_statements WHERE name = 'q';\n`, 'fukulow_app');
  const ms = timings(timed);
  if (ms.length !== samples) throw new Error(`expected ${samples} timings, got ${ms.length}`);
  const bound = bindLiterals(sql, array);
  const checksum = psql(db, `${scope}${checksumSql(bound)}\n`, 'fukulow_app').trim();
  if (!/^[0-9a-f]{32} /.test(checksum)) throw new Error(`${arm} cut ${cut}: empty checksum`);
  // A3 clamps a negative raw count to 0; the drift flag must stay false at every cut.
  if (arm === 'final' && psql(db, `${scope}SELECT bool_or(count_drift) FROM (${bound}) x;\n`, 'fukulow_app').trim() !== 'f') {
    throw new Error(`final cut ${cut}: count_drift`);
  }
  return { arm, cut, ...planSummary(JSON.parse(explain)), samplesMs: ms, p50Ms: quantile(ms, 0.5), p95Ms: quantile(ms, 0.95),
    prepared: JSON.parse(timed.trim().split('\n').at(-1) ?? '{}'), checksum, role };
}

const walQuery = `SELECT json_build_object('lsn', pg_current_wal_insert_lsn(),
  'lsnBytes', pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '0/0'), 'atMs', extract(epoch FROM clock_timestamp()) * 1000, 'records', w.wal_records,
  'fpi', w.wal_fpi, 'bytes', w.wal_bytes, 'checkpoints', c.num_timed + c.num_requested, 'redo', (pg_control_checkpoint()).redo_lsn)
  FROM pg_stat_wal w, pg_stat_checkpointer c;`;
const walStats = (db: string) => JSON.parse(psql(db, walQuery));
const serverLog = () => {
  const child = spawnSync('docker', ['logs', container], { encoding: 'utf8', maxBuffer });
  if (child.status !== 0) throw new Error(`server log read failed: ${(child.stderr ?? '').slice(-500) || `exit ${child.status}`}`);
  return `${child.stdout}\n${child.stderr}`;
};
// Forces a checkpoint and returns its request time on the server clock (the clock of the log's %m).
function forcedCheckpoint(db: string) {
  const requestMs = Number(psql(db, 'SELECT extract(epoch FROM clock_timestamp()) * 1000;\nCHECKPOINT;\n').trim());
  if (!Number.isFinite(requestMs)) throw new Error('CHECKPOINT request time is undeterminable');
  return requestMs;
}
// Sends run as the application role under RLS, like the app, so A3's policy checks are paid.
const pgbenchArgs = (seconds: number) => ['exec', ...(request ? ['--user', 'postgres'] : []), clientContainer, ...pinned(cpuSets?.client,
  ['pgbench', '-U', 'fukulow_app', '-n', '-c', '8', '-j', '4', '-T', String(seconds), '-f', '/work/sql/bench.pgb'])];
function sendRole(db: string) {
  psql('postgres', `ALTER ROLE fukulow_app IN DATABASE ${db} SET fukulow.organization_id = '${organization}';`);
  const role = JSON.parse(psql(db, `SELECT json_build_object('user', current_user, 'superuser', rolsuper, 'bypassRls', rolbypassrls,
    'rls', row_security_active('messages') AND row_security_active('channel_log'), 'org', current_setting('fukulow.organization_id', true))
    FROM pg_roles WHERE rolname = current_user;`, 'fukulow_app'));
  if (role.user !== 'fukulow_app' || role.superuser || role.bypassRls || !role.rls || role.org !== organization) throw new Error(`${db}: unexpected send role or RLS state`);
  return role;
}

// One block: an opening forced CHECKPOINT, 60 s warm, 120 s measured. measure() builds the row as
// soon as pgbench completes; closeCheckpoint() then forces the closing CHECKPOINT and judges the
// block from server-log timestamps (see checkpointWindow). The counters and the control file's redo
// LSN up to the end of the measured block are kept as a second, completed-checkpoint signal.
function sendBlock(db: string, label: string, order: number, reference?: ReferenceWindow) {
  let openRequestMs = NaN;
  let blockEndMs = NaN;
  return {
    async measure() {
      openRequestMs = forcedCheckpoint(db);
      const start = walStats(db);
      const warmArgv = [...pgbenchArgs(warmSeconds), db];
      const prefix = `/tmp/pgb-${label}`;
      // #796: measuredWindow is the wrapper around the measured pgbench run (wall and monotonic, to
      // expose a clock step); pgbenchWindow is pgbench's own interval from its log, the one the
      // thermal judge reads the launcher's samples inside.
      const argv = [...pgbenchArgs(measuredSeconds), '-l', `--log-prefix=${prefix}`, db];
      const steps = {
        run: () => run('docker', argv),
        after: () => walStats(db),
        log: () => run('docker', ['exec', clientContainer, 'sh', '-c', `cat ${prefix}.* && rm -f ${prefix}.*`]),
      };
      let counters: CounterBlock | undefined;
      let affinity: Affinity | undefined;
      let before: ReturnType<typeof walStats>;
      let m: ReturnType<typeof measuredPgbench<ReturnType<typeof walStats>>>;
      if (frequency) {
        const signal = frequency.signal;
        const affinityAbort = new AbortController();
        const affinitySignal = AbortSignal.any([signal, affinityAbort.signal]);
        let observed: Promise<Affinity | Error> | undefined;
        try {
          const prepare = async () => {
            pgbench((await exec('docker', warmArgv, { signal, timeout: (warmSeconds + 10) * 1000, maxBuffer })).stdout);
            const { stdout } = await exec('docker', [...psqlArgs(db, 'postgres', false), '-c', walQuery], { signal, timeout: 5000, maxBuffer });
            return JSON.parse(stdout);
          };
          const captured = await frequency.measure(order, reference, prepare, () => {
            const workload = exec('docker', argv, {
              signal, timeout: (measuredSeconds + pgbenchTimeoutGraceSeconds) * 1000, killSignal: 'SIGKILL', maxBuffer,
            });
            if (request?.stage === 'rehearsal2') {
              observed = readAffinity(container, clientContainer, prefix, db, affinitySignal).catch(error => new Error(String(error)));
            }
            return workload.then(result => result.stdout);
          });
          before = captured.preparation;
          counters = captured.counters;
          m = pgbenchEvidence(captured.output, captured.measuredWindow, steps);
          if (observed) {
            const pin = await observed;
            if (pin instanceof Error) m.errors.push(pin.message);
            else affinity = pin;
            m.errors.push(...affinityProblems(affinity));
          }
        } finally { affinityAbort.abort(); }
      } else {
        pgbench(run('docker', warmArgv));
        before = walStats(db);
        m = measuredPgbench(steps);
      }
      const { output, measuredWindow, pgbenchWindow, after, latencies, errors } = m;
      blockEndMs = after.atMs;
      const ended = new Date().toISOString();
      const result = pgbench(output);
      if (errors.length === 0) {
        try { writeFileSync(join(out, `latency/${label}.txt`), latencies.join('\n') + '\n'); } catch (e) { errors.push(`latency log: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (latencies.length !== result.transactions) errors.push(`${latencies.length} log lines for ${result.transactions} transactions`);
      const walBytes = Number(after.lsnBytes) - Number(before.lsnBytes);
      const records = after.records - before.records;
      const fpi = after.fpi - before.fpi;
      const checkpoints = { warm: before.checkpoints - start.checkpoints, measured: after.checkpoints - before.checkpoints, redoMoved: after.redo !== start.redo };
      const crossed = checkpoints.warm !== 0 || checkpoints.measured !== 0 || checkpoints.redoMoved;
      const latency = (q: number) => latencies.length > 0 ? quantile(latencies, q) : NaN;
      return { crossed, errors, ended, measuredWindow, pgbenchWindow, counters, affinity, ...result, p95Ms: latency(0.95), p99Ms: latency(0.99), walBytes,
        walBytesPerSend: walBytes / result.transactions, statWalBytes: Number(after.bytes) - Number(before.bytes),
        walRecords: records, fpiRecords: fpi, imagesPerWalRecord: records > 0 ? fpi / records : 0, checkpoints };
    },
    closeCheckpoint() {
      const closeRequestMs = forcedCheckpoint(db);
      return waitForCheckpointWindow(serverLog, openRequestMs, closeRequestMs, blockEndMs, 120, () => spawnSync('sleep', ['0.5']));
    },
  };
}

type HostState = ReturnType<typeof hostState>;
type SendRow = Awaited<ReturnType<ReturnType<typeof sendBlock>['measure']>> & { checkpointLog: unknown; hostAfter: HostState | null; order: number; pair: number; arm: string; db: string };
const sends: SendRow[] = [];
// Each block is saved before any of its failures is raised, so a failed run keeps every finished block.
const keepBlock = (extra: Record<string, unknown> = {}) => (row: SendRow) => {
  sends.push(row);
  save('sends.json', { ...extra, sends });
};
// Send re-measure: each block gets a fresh clone of its arm's template, which was vacuumed and
// analyzed before any block, and is dropped after the block (and its check, for the final arm).
async function freshSends() {
  for (const arm of (control ? ['current'] : ['current', 'final']) as FinalArm[]) {
    psql('postgres', `CREATE DATABASE t_${arm} TEMPLATE p519;`);
    if (arm === 'final') migrateA3('t_final');
    file(`t_${arm}`, 'sql/send-current.sql');
    psql(`t_${arm}`, 'VACUUM (ANALYZE);');
  }
  if (!control) countsCheck('t_final', 'final template, before the sends');
  const plan = control ? [1, 2, 3].map(order => ({ order, pair: 1, arm: 'current', db: `s${order}_current` })) : sendBlocks(benchOrder);
  for (const b of plan) {
    const template = `t_${b.arm}`;
    const clone = () => {
      psql('postgres', `CREATE DATABASE ${b.db} TEMPLATE ${template};`);
      const role = sendRole(b.db);
      const since = eventsSince(Date.now());
      return { role, since, host: idleHost() };
    };
    const block = async ({ role, since, host }: ReturnType<typeof clone>, reference?: ReferenceWindow) => {
      const steps = sendBlock(b.db, `block${b.order}-${b.arm}`, b.order, reference);
      return finishBlock({ ...b, role, host, ...await steps.measure() }, { label: `block ${b.order}`, closeCheckpoint: steps.closeCheckpoint,
        hostAfter: () => hostState(since), keep: keepBlock() });
    };
    if (frequency) await frequency.runBlock(b.order, () => psql(template, 'CHECKPOINT;'), clone, block);
    else await block(clone());
    if (b.arm === 'final') countsCheck(b.db, `after block ${b.order}`);
    psql('postgres', `DROP DATABASE ${b.db} WITH (FORCE);`);
  }
}

const started = new Date().toISOString();
let failed = false;
function checkHostAffinity(stage: 'preflight' | 'finish') {
  if (!request) return;
  const readback = readHostAffinity(request.session);
  save(stage === 'finish' ? 'frequency-host-affinity-after.json' : 'frequency-host-affinity.json', readback);
  const problems = hostAffinityProblems(readback, request.session, request.launchPolicy.bootId);
  if (problems.length) throw new Error(`STOP: #796 housekeeping ${stage}: ${problems.join('; ')}`);
}
try {
  checkHostAffinity('preflight');
  const preflight = idleHost();
  const recordBefore = hostRecord(out);
  save('host-record-before.json', recordBefore);
  const violations = linuxViolations(recordBefore);
  if (!smoke && violations.length > 0) throw new Error(`measurement conditions not met: ${violations.join('; ')}`);
  if (request) {
    // Fail before the frequency calibration if the send user cannot read the bench file (#796 control run 1).
    if (spawnSync('docker', ['run', '--rm', '--label', workloadLabel, '--network', 'none', '--user', 'postgres', '-v', `${work}:/work:ro`,
      ...containerCpuArgs('client'), '--entrypoint', 'test', image, '-r', '/work/sql/bench.pgb']).status !== 0) throw new Error('the container postgres user cannot read /work/sql/bench.pgb');
    frequency = frequencyRun(request, out);
    await frequency.start();
  }
  // With CPU sets, taskset wraps the image's entrypoint, so the postmaster and every backend inherit the server set.
  run('docker', ['run', '-d', '--rm', '--name', container, '--label', workloadLabel, '--network', 'none', '-e', 'POSTGRES_PASSWORD=probe',
    '-v', `${work}:/work:ro`, ...(request ? frequencyServerArgs() : serverImageArgs(cpuSets?.server)),
    '-c', 'shared_buffers=512MB', '-c', 'jit=off',
    // No automatic checkpoint inside a send block: each block starts at its forced CHECKPOINT and
    // full-page images settle during warm-up, as the plan requires. A crossing block fails the run.
    '-c', 'max_wal_size=64GB', '-c', 'checkpoint_timeout=1h', '-c', 'log_checkpoints=on']);
  for (let i = 0; spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1']).status !== 0; i++) {
    if (i > 60) throw new Error('PostgreSQL did not become ready');
    spawnSync('sleep', ['1']);
  }
  if (request) {
    run('docker', ['run', '-d', '--rm', '--name', clientContainer, '--label', workloadLabel,
      ...frequencyClientArgs(container, ['-v', `${work}:/work:ro`])]);
    save('frequency-container-cpusets.json',
      frequencyContainerReadbacks(request.session, container, clientContainer, args => run('docker', args)));
    frequency?.observeHousekeeping();
  }
  // Max frequencies per set make a swapped or mixed split visible in the record (Zen 5 vs Zen 5c).
  const maxKHz = (set: number[]) => [...new Set(set.map(c => Object.entries(recordBefore.maxFrequencyKHz ?? {}).find(([, cs]) => cs.includes(c))?.[0] ?? 'unknown'))];
  const cpuPins = cpuSets === undefined ? null : {
    ...cpuSets, serverMaxKHz: maxKHz(cpuSets.server), clientMaxKHz: maxKHz(cpuSets.client),
    postmasterAllowed: allowedCpus(run('docker', ['exec', container, 'cat', '/proc/1/status'])),
    clientAllowed: allowedCpus(run('docker', ['exec', clientContainer, ...pinned(cpuSets.client, ['cat', '/proc/self/status'])])),
  };
  if (cpuPins && (cpuList(cpuPins.postmasterAllowed) !== cpuList(cpuPins.server) || cpuList(cpuPins.clientAllowed) !== cpuList(cpuPins.client))) {
    throw new Error(`CPU sets did not take effect: postmaster ${cpuList(cpuPins.postmasterAllowed)}, client ${cpuList(cpuPins.clientAllowed)}`);
  }
  psql('postgres', 'CREATE DATABASE p519;');
  psql('p519', migrations.map(m => `BEGIN;\n\\i /work/server/migrations/${m}\nCOMMIT;`).join('\n') + '\n');
  psql('p519', "BEGIN;\nSELECT set_config('fukulow.app_password', 'probe', true) \\g /dev/null\n\\i /work/deploy/db-roles.sql\nCOMMIT;\n");
  file('p519', 'deploy/db-grants.sql');
  file('p519', 'sql/seed.sql');
  const metadata = {
    status: 'DIAGNOSTIC / NOT EVALUATED (stop rule only)', mode: smoke ? 'smoke' : 'diagnostic', sendsOnly, started, commits: { ...commits, update }, a3Migration, a3Update,
    harnessCommit: git('rev-parse', 'HEAD'), harnessDirty: git('status', '--porcelain', '--', 'load/sql-probes/519-unread-counts') !== '',
    image, imageId: run('docker', ['image', 'inspect', '--format', '{{.Id}}', image]).trim(),
    settings: JSON.parse(psql('p519', `SELECT json_object_agg(name, setting) FROM pg_settings WHERE name IN
      ('server_version','shared_buffers','work_mem','jit','plan_cache_mode','synchronous_commit','fsync','autovacuum','default_transaction_isolation','max_wal_size','checkpoint_timeout','log_checkpoints',
      'log_line_prefix','log_timezone');`)),
    host: { platform: platform(), release: release(), cpus: cpus().length, memoryBytes: totalmem() }, preflight, cpuSets: cpuPins,
    hostBusyMarker: marker, launchSession, frequencyStage: request?.stage, frequencyApproval: request?.approval?.sha256, frequencyGo: request?.go, cache: 'warm: one discarded EXPLAIN and one discarded EXECUTE per measured cell', samplesPerCell: samples, cuts: sendsOnly ? [] : cuts,
    walNotes: 'WAL bytes = cluster insert-LSN delta (and pg_stat_wal.wal_bytes); cluster-wide, so idle databases can add background WAL; ' +
      (sendsOnly ? 'one fresh send database per block, cloned from a vacuumed per-arm template and dropped after the block' : 'send DBs are reused across pairs'),
    sends: { clients: 8, threads: 4, warmSeconds, measuredSeconds, benchOrder: control ? [['current'], ['current'], ['current']] : benchOrder, freshDatabasePerBlock: sendsOnly },
    countsCheck: { timeout: checkTimeout, when: sendsOnly ? 'final template, then after every final block' : 'after the read cuts and after the sends' },
    stopRule: stopRule([{ pair: 1, walBytesPerSend: 1, tps: 1 }], [{ pair: 1, walBytesPerSend: 1, tps: 1 }]).limits,
  };
  save('metadata.json', metadata);
  // Checkpoint crossings are judged by the log's %m timestamps (parsed as UTC).
  if (!metadata.settings.log_line_prefix.startsWith('%m ') || !['UTC', 'Etc/UTC'].includes(metadata.settings.log_timezone)) {
    throw new Error(`server log timestamps are undeterminable: log_line_prefix=${metadata.settings.log_line_prefix} log_timezone=${metadata.settings.log_timezone}`);
  }
  const reads: ReturnType<typeof measure>[] = [];
  if (sendsOnly) {
    await freshSends();
  } else {
    const array = psql('p519', `SELECT ${channels};`).trim();
    for (const arm of ['current', 'final'] as FinalArm[]) {
      psql('postgres', `CREATE DATABASE r_${arm} TEMPLATE p519;`);
      if (arm === 'final') migrateA3('r_final');
      file(`r_${arm}`, 'sql/current-fresh.sql');
    }
    for (const [i, cut] of cuts.entries()) {
      const order: FinalArm[] = i % 2 === 0 ? ['current', 'final'] : ['final', 'current'];
      for (const arm of order) {
        psql(`r_${arm}`, `\\set cut ${cut}\n\\i /work/sql/setcut.sql\n`);
        reads.push(measure(`r_${arm}`, arm, cut, array));
      }
      const sums = new Set(reads.filter(r => r.cut === cut).map(r => r.checksum));
      if (sums.size !== 1) { failed = true; console.error(`checksum mismatch at cut ${cut}`); }
    }
    countsCheck('r_final', 'after the read cuts');
    save('reads.json', reads);
    for (const arm of ['current', 'final'] as FinalArm[]) {
      psql('postgres', `CREATE DATABASE s_${arm} TEMPLATE p519;`);
      if (arm === 'final') migrateA3('s_final');
      file(`s_${arm}`, 'sql/send-current.sql');
    }
    const sendRoles = { current: sendRole('s_current'), final: sendRole('s_final') };
    for (const b of sendBlocks(benchOrder)) {
      const steps = sendBlock(`s_${b.arm}`, `pair${b.pair}-${b.arm}`, b.order);
      finishBlock<SendRow, HostState>({ ...b, db: `s_${b.arm}`, ...await steps.measure(), checkpointLog: null, hostAfter: null }, { label: `block ${b.order}`,
        closeCheckpoint: steps.closeCheckpoint, keep: keepBlock({ sendRoles }) });
    }
    countsCheck('s_final', 'after the sends');
  }
  if (!control) {
    const verdict = stopRule(sends.filter(s => s.arm === 'current'), sends.filter(s => s.arm === 'final'));
    save('stop-rule.json', verdict);
    const lines = [
      ...(reads.length === 0 ? [] : ['| cut | arm | p50 ms | p95 ms | EXPLAIN ms | blocks | checksum |', '|---:|---|---:|---:|---:|---:|---|',
        ...reads.map(r => `| ${r.cut} | ${r.arm} | ${r.p50Ms} | ${r.p95Ms} | ${r.executionMs} | ${r.sharedBlocks} | ${r.checksum} |`), '']),
      '| order | pair | arm | tps | p95 ms | p99 ms | WAL bytes/send | images per WAL record | images per send |', '|---:|---:|---|---:|---:|---:|---:|---:|---:|',
      ...sends.map(s => `| ${s.order} | ${s.pair} | ${s.arm} | ${s.tps.toFixed(0)} | ${s.p95Ms.toFixed(3)} | ${s.p99Ms.toFixed(3)} | ${s.walBytesPerSend.toFixed(0)} | ${s.imagesPerWalRecord.toFixed(6)} | ${(s.fpiRecords / s.transactions).toFixed(6)} |`),
      '', '| pair | WAL/send ratio | tps ratio | breach |', '|---:|---:|---:|---|',
      ...verdict.ratios.map(r => `| ${r.pair} | ${r.walPerSend.toFixed(3)} | ${r.tps.toFixed(3)} | ${[r.walPerSend > 1.2 ? 'WAL' : '', r.tps < 0.9 ? 'tps' : ''].filter(Boolean).join(', ') || '-'} |`),
      '', '| message_counts_check | rows | seconds |', '|---|---:|---:|', ...checks.map(c => `| ${c.label} | ${c.rows ?? '-'} | ${Number(c.seconds).toFixed(0)} |`),
      '', `HOST-BUSY marker: ${marker ?? '(none)'}`,
      '', `Stop rule (${verdict.limits}): median WAL/send ratio ${verdict.medianWalPerSend.toFixed(3)}, median tps ratio ${verdict.medianTps.toFixed(3)} -> ${verdict.stop ? 'STOP' : 'no stop'}`];
    const title = sendsOnly ? '#519 §10 step 1 send re-measure' : '#519 §10 step 1 final-design probe';
    writeFileSync(join(out, 'summary.md'), `# ${title} (${metadata.status})\n\n${lines.join('\n')}\n`);
    console.log(lines.join('\n'));
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  if (request) spawnSync('docker', ['rm', '-f', clientContainer]);
  spawnSync('docker', ['rm', '-f', container]);
  try { rmSync(work, { recursive: true, force: true }); } catch (e) { failed = true; console.error('work directory cleanup:', e); }
  try { frequency?.finish(); } catch (e) { failed = true; console.error('frequency completion:', e); }
  // Each write is attempted on its own, so a failed record or checks write cannot skip status.json.
  try { checkHostAffinity('finish'); } catch (e) { failed = true; console.error(e); }
  try { save('host-record-after.json', hostRecord(out)); } catch (e) { if (request) failed = true; console.error('host record after the run:', e); }
  try { save('checks.json', checks); } catch (e) { failed = true; console.error('checks.json:', e); }
  save('status.json', { complete: !failed, launchSession, finished: new Date().toISOString() });
}
process.exit(failed ? 1 : 0);
