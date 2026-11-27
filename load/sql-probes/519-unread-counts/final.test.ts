import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir as systemTmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cpus796, measuredSetsArg, sets796 } from '../../harness-core/frequency-layout.ts';
import { hostAffinity, policy, session } from './frequency-fixture.ts';
import { organization } from './probe.ts';

export { hostAffinityProblems } from './frequency-host-affinity.ts';
export { loadavg, platform, release, totalmem } from 'node:os';
export const cpus = () => cpus796;
export const tmpdir = () => scratch;
export const hostRecord = () => ({});
export const linuxViolations = () => [];
export const frequencyRequest = () => ({ stage: 'control', session, launchPolicy: policy });
export const frequencyRun = () => ({ start: async () => {}, finish: () => {} });

let scratch: string;
const launched: string[] = [], removed: string[] = [];
const stopped = 'fixture stop after container launch';
const result = (stdout = '') => ({ status: 0, stdout, stderr: '' });
let sendRun: { pgbench: string[][]; sql: [string, string][]; checkpoints: string[]; lsnBytes: number } | undefined;

export function readHostAffinity(launchSession: string) {
  const record = hostAffinity(launchSession);
  if (removed.length === 2) {
    record.rootTasks = { '42': { name: 'late-kthread', cpus: [0, 8], movable: true } };
  }
  return record;
}

export function execFile() {
  assert.fail('unexpected asynchronous command');
}

export function spawnSync(command: string, args: string[], options?: { input?: string }) {
  const [operation, option] = args;
  if (command === 'sh' && operation === '-c') {
    mkdirSync(join(args[3], 'server/migrations'), { recursive: true });
    return result();
  }
  if (command === 'git') {
    if (operation === 'rev-parse') return result(option === 'fd6a5949^' ? '5ef561e5' : option.split('^')[0]);
    if (operation === 'merge-base') return result();
    if (operation === 'diff' && option === '--name-only') return result('server/migrations/202611221100_unread_counts.sql');
    if (operation === 'diff' && option === '--name-status') return result('A\tserver/migrations/202611231100_unread_counts_update_first.sql');
    if (operation === 'show') return result('pub(super) const LIST_COUNTS_SQL: &str = r#"SELECT 1"#;');
    if (operation === 'status') return result();
  }
  if (command === 'docker') {
    if (sendRun) {
      if (operation === 'image') return result('sha256:fixture');
      if (operation === 'logs') return result(sendRun.checkpoints.join('\n'));
      if (operation === 'exec' && args.includes('pgbench')) {
        sendRun.pgbench.push(args.slice(args.indexOf('pgbench')));
        sendRun.lsnBytes += 100;
        return result('number of transactions actually processed: 1\nlatency average = 1 ms\ntps = 100 (without initial connection time)\n');
      }
      if (operation === 'exec' && args.includes('sh')) {
        if (args.at(-1)?.startsWith('df ')) return result('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fixture 90000000 1000000 89000000 1% /\n');
        return result('0 1 1000 0 1760000000 0\n');
      }
      const sql = options?.input;
      if (operation === 'exec' && sql !== undefined) {
        sendRun.sql.push([args.at(-1)!, sql]);
        if (sql.includes('pg_settings')) return result('{"log_line_prefix":"%m ","log_timezone":"UTC"}');
        if (sql.includes('row_security_active')) return result(JSON.stringify({ user: 'fukulow_app', rls: true, org: organization }));
        if (sql.includes('clock_timestamp()) * 1000;')) {
          const at = new Date(Date.UTC(2026, 0, 1, 0, 0, sendRun.checkpoints.length));
          sendRun.checkpoints.push(at.toISOString().replace('T', ' ').replace('Z', ' UTC checkpoint starting: force'));
          return result(String(+at));
        }
        if (sql.includes('pg_current_wal_insert_lsn')) {
          const wal = { atMs: 0, lsn: `0/${sendRun.lsnBytes.toString(16)}`, lsnBytes: sendRun.lsnBytes,
            bytes: sendRun.lsnBytes, records: 1, fpi: 0, checkpoints: 1, redo: '0/0' };
          return result(sql.includes('pg_stat_statements') ? `${JSON.stringify(wal)}\n{"statements":[],"functions":[],"statsReset":null,"deallocations":0}\n` : JSON.stringify(wal));
        }
        if (sql.includes('SELECT count(*) FROM message_counts_check')) return result('0');
        if (sql.includes('pg_get_wal_stats')) return result('[]');
        return result();
      }
    }
    if (operation === 'ps' || operation === 'exec' || operation === 'events') return result();
    if (operation === 'inspect') return { status: 1, stdout: '', stderr: stopped };
    if (operation === 'run') {
      if (args.includes('--name')) launched.push(args[args.indexOf('--name') + 1]);
      return result();
    }
    if (operation === 'rm') {
      removed.push(args.at(-1)!);
      return result();
    }
  }
  assert.fail(`unexpected command: ${command} ${operation}`);
}

test('a final frequency run writes a fresh finish affinity file after cleaning up both containers', async t => {
  scratch = mkdtempSync(join(realpathSync(systemTmpdir()), 'fukulow-final-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const marker = join(scratch, 'HOST-BUSY');
  const out = join(scratch, 'out');
  writeFileSync(marker, `session ${session}\n`);
  const entry = new URL('./final.ts', import.meta.url);
  t.mock.property(process, 'argv', [process.execPath, entry.pathname, '--diagnostic', '--sends-only',
    '--frequency-v3', 'control', '--out', out, '--cpu-sets', `${measuredSetsArg};housekeeping=${sets796.housekeeping}`]);
  t.mock.property(process, 'env', { ...process.env, FUKULOW_HOST_BUSY: marker, FUKULOW_LAUNCH_SESSION: session });
  t.mock.method(process, 'chdir', () => {});
  t.mock.method(process, 'exit', (status: number) => { throw new Error(`exit ${status}`); });
  const error = t.mock.method(console, 'error', () => {});
  const mocked = new Set(['node:child_process', 'node:os', '../../harness-core/host-record.ts', './frequency-run.ts', './frequency-host-affinity.ts']);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return context.parentURL === entry.href && mocked.has(specifier)
        ? { url: import.meta.url, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());

  await assert.rejects(import('./final.ts'), { message: 'exit 1' });
  assert.match(String(error.mock.calls[0]?.arguments[0]), /fixture stop after container launch/);
  assert.equal(launched.length, 2);
  assert.deepEqual(removed, [...launched].reverse());
  const read = (name: string) => JSON.parse(readFileSync(join(out, name), 'utf8'));
  assert.deepEqual(read('frequency-host-affinity.json'), hostAffinity());
  assert.deepEqual(read('frequency-host-affinity-after.json'), readHostAffinity(session));
  assert.equal(read('status.json').complete, false);
});

test('F1 smoke preserves baseline commands, scores plain sends and labels instrumented sends', async t => {
  scratch = mkdtempSync(join(realpathSync(systemTmpdir()), 'fukulow-f1-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const entry = new URL('./final.ts', import.meta.url);
  t.mock.property(process, 'argv', []);
  t.mock.property(process, 'env', { ...process.env, FUKULOW_HOST_BUSY: undefined, FUKULOW_LAUNCH_SESSION: undefined });
  t.mock.method(process, 'chdir', () => {});
  t.mock.method(process, 'exit', (status: number) => { throw new Error(`exit ${status}`); });
  const error = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const mocked = new Set(['node:child_process', 'node:os', '../../harness-core/host-record.ts']);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return context.parentURL?.startsWith(entry.href + '?') && mocked.has(specifier)
        ? { url: import.meta.url, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  t.after(() => { hooks.deregister(); sendRun = undefined; });

  const runSmoke = async (name: string, ...flags: string[]) => {
    const out = join(scratch, name);
    sendRun = { pgbench: [], sql: [], checkpoints: [], lsnBytes: 0 };
    process.argv = [process.execPath, entry.pathname, '--smoke', '--sends-only', '--out', out, ...flags];
    await assert.rejects(import(entry.href + '?' + name), (e: Error) => {
      assert.equal(e.message, 'exit 0', error.mock.calls.map(c => String(c.arguments[0])).join('\n'));
      return true;
    });
    assert.deepEqual(error.mock.calls, []);
    const read = (name: string) => readFileSync(join(out, name), 'utf8');
    const json = (name: string) => JSON.parse(read(name));
    return { ...sendRun, read, json };
  };
  const baseline = await runSmoke('baseline');
  const f1 = await runSmoke('f1', '--candidate', 'f1');
  const baselineMigration = "SET statement_timeout = '45min';\nBEGIN;\n\\i /work/202611221100_unread_counts.sql\nCOMMIT;\nBEGIN;\n\\i /work/202611231100_unread_counts_update_first.sql\nCOMMIT;\n";
  assert.ok(baseline.sql.some(([db, sql]) => db === 't_final' && sql === baselineMigration));
  assert.deepEqual(f1.sql, baseline.sql.map(([db, sql]) => [db,
    sql === baselineMigration ? sql + 'BEGIN;\n\\i /work/sql/f1-row-trigger.sql\nCOMMIT;\n' : sql]));
  assert.deepEqual(f1.pgbench, baseline.pgbench);
  assert.deepEqual(baseline.pgbench.map(args => args.at(-1)), ['s1_current', 's1_current', 's2_final', 's2_final']);
  assert.deepEqual(baseline.json('metadata.json').commits, { current: '5ef561e5', final: 'fd6a5949', update: 'c672b0a4' });
  assert.equal(baseline.json('metadata.json').candidate, undefined);
  assert.equal(baseline.json('metadata.json').candidateSqlSha256, undefined);
  const hash = createHash('sha256').update(readFileSync(new URL('./sql/f1-row-trigger.sql', import.meta.url))).digest('hex');
  assert.equal(f1.json('metadata.json').candidate, 'f1');
  assert.equal(f1.json('metadata.json').candidateSqlSha256, hash);
  assert.deepEqual(baseline.json('metadata.json').sends.benchOrder, [['current', 'final']]);
  assert.deepEqual(f1.json('metadata.json').sends.benchOrder, [['current', 'final+f1']]);
  assert.deepEqual(f1.json('sends.json').sends.map((row: { arm: string }) => row.arm), ['current', 'final+f1']);
  assert.equal(f1.read('stop-rule.json'), baseline.read('stop-rule.json'));
  assert.match(baseline.read('summary.md'), /\| 2 \| 1 \| final \|/);
  assert.match(f1.read('summary.md'), /\| 2 \| 1 \| final\+f1 \|/);
  assert.equal(f1.read('latency/block2-final+f1.txt'), baseline.read('latency/block2-final.txt'));

  const attributed = await runSmoke('f1-attribution', '--candidate', 'f1', '--attribution');
  assert.throws(() => attributed.read('stop-rule.json'), { code: 'ENOENT' });
  assert.equal(attributed.json('block2-final+f1/attribution.json').arm, 'final+f1');
  assert.equal(attributed.json('attribution-summary.json').finalArm, 'final+f1');
  assert.ok(attributed.json('attribution-summary.json').comparison);
});
