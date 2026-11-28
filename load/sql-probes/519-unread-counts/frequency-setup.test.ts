import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

// The boot-time affinity script (#996) replaces the README's manual block; it runs here against a fake /proc and /sys.
const script = readFileSync(new URL('../../harness-core/boot-796/affinity.sh', import.meta.url), 'utf8');

function fakeHost(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fukulow-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const irq = (id: number) => join(root, `proc/irq/${id}/smp_affinity_list`);
  mkdirSync(irq(10), { recursive: true });
  for (const id of [11, 12, 13]) {
    mkdirSync(join(irq(id), '..'), { recursive: true });
    writeFileSync(irq(id), '5\n');
  }
  mkdirSync(join(root, 'sys/devices/virtual/workqueue'), { recursive: true });
  const children = join(root, 'proc/2/task/2/children');
  mkdirSync(join(children, '..'), { recursive: true });
  mkdirSync(join(root, 'proc/30'));
  mkdirSync(join(root, 'proc/40'));
  writeFileSync(children, '30 40\n');
  return { root, irq };
}

// taskset refuses pid 30 with EINVAL (a per-CPU kthread) and pid $FUKULOW_REFUSE with another error.
const stubs = String.raw`
stat() { case "$3" in */12/*) printf '444\n' ;; */13/*) return 1 ;; *) printf '644\n' ;; esac; }
taskset() {
  printf '%s\n' "$*" >> "$FUKULOW_SETUP_TEST/pins"
  if [ "$3" = 30 ]; then
    # util-linux prints to buffered stdout first, which flushes at exit after the stderr error.
    local current
    printf -v current "pid %s's current affinity list: 5\n" "$3"
    printf "taskset: failed to set pid %s's affinity: Invalid argument\n" "$3" >&2
    printf '%s' "$current"
    return 1
  fi
  if [ "$3" = "$FUKULOW_REFUSE" ]; then
    printf "taskset: failed to set pid %s's affinity: Operation not permitted\n" "$3" >&2
    return 1
  fi
}
export -f stat taskset
`;
const run = (root: string, refuse = '') => spawnSync('bash', ['-c',
  stubs + script.replaceAll('/proc/', '"$FUKULOW_SETUP_TEST"/proc/').replaceAll('/sys/', '"$FUKULOW_SETUP_TEST"/sys/')], {
  env: { ...process.env, FUKULOW_SETUP_TEST: root, FUKULOW_REFUSE: refuse }, encoding: 'utf8', timeout: 5000,
});

test('the boot affinity script sets the housekeeping masks, continues after a refused IRQ write and attempts to pin kernel threads', t => {
  const { root, irq } = fakeHost(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'sys/devices/virtual/workqueue/cpumask'), 'utf8'), '8181\n');
  assert.equal(readFileSync(join(root, 'proc/irq/default_smp_affinity'), 'utf8'), '8181\n');
  assert.match(result.stderr, /IRQ affinity write failed: .*\/irq\/10\/smp_affinity_list/);
  assert.match(result.stderr, /IRQ affinity mode read failed: .*\/irq\/13\/smp_affinity_list/);
  assert.equal(readFileSync(irq(11), 'utf8'), '0,7,8,15\n');
  assert.equal(readFileSync(irq(12), 'utf8'), '5\n');
  assert.equal(readFileSync(irq(13), 'utf8'), '5\n');
  assert.equal(readFileSync(join(root, 'pins'), 'utf8'), '-pc 0,7,8,15 2\n-pc 0,7,8,15 30\n-pc 0,7,8,15 40\n');
});

test('the boot affinity script fails when a live kernel thread refuses its pin for a reason other than EINVAL', t => {
  const { root } = fakeHost(t);
  const result = run(root, '40');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to set pid 40's affinity: Operation not permitted/);
});
