import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir as systemTmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cpus796, measuredSetsArg, sets796 } from '../../harness-core/frequency-layout.ts';
import { hostAffinity, policy, session } from './frequency-fixture.ts';

export { hostAffinityProblems } from './frequency-host-affinity.ts';
export { loadavg, platform, release, totalmem } from 'node:os';
export const cpus = () => cpus796;
export const tmpdir = () => scratch;
export const hostRecord = () => ({});
export const linuxViolations = () => [];
export const frequencyRequest = () => ({ stage: 'control', helper: '/mock-perf-helper', session, launchPolicy: policy });
export const frequencyRun = () => ({ start: async () => {}, finish: () => {} });
export const assertHelperOrder = (helper: string, order: number) => {
  assert.equal(helper, '/mock-perf-helper');
  assert.equal(order, 3);
  checkedOrder = true;
};

let scratch: string;
let checkedOrder = false;
const launched: string[] = [], removed: string[] = [];
const stopped = 'fixture stop after container launch';
const result = (stdout = '') => ({ status: 0, stdout, stderr: '' });

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

export function spawnSync(command: string, args: string[]) {
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
  }
  if (command === 'docker') {
    assert.ok(checkedOrder, 'helper order must be checked before Docker commands');
    if (operation === 'ps' || operation === 'exec') return result();
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
  const mocked = new Set(['node:child_process', 'node:os', '../../harness-core/host-record.ts', './frequency-run.ts',
    './frequency-collector.ts', './frequency-host-affinity.ts']);
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
