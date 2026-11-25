import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the README stops irqbalance, continues after a refused IRQ write and attempts to pin kernel threads', t => {
  const readme = readFileSync(new URL('../../harness-core/README.md', import.meta.url), 'utf8');
  const setup = readme.split('## #796 frequency validity v3')[1]?.split('```bash\n')[1]?.split('\n```')[0];
  assert.ok(setup);
  const root = mkdtempSync(join(tmpdir(), 'fukulow-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refused = join(root, 'proc/irq/10/smp_affinity_list');
  const writable = join(root, 'proc/irq/11/smp_affinity_list');
  const managed = join(root, 'proc/irq/12/smp_affinity_list');
  const unreadable = join(root, 'proc/irq/13/smp_affinity_list');
  mkdirSync(refused, { recursive: true });
  for (const file of [writable, managed, unreadable]) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '5\n');
  }
  const children = join(root, 'proc/2/task/2/children');
  mkdirSync(join(children, '..'), { recursive: true });
  mkdirSync(join(root, 'proc/30'));
  writeFileSync(children, '30 40\n');
  const stubs = String.raw`
systemctl() { printf 'systemctl %s\n' "$*"; }
sudo() {
  case "$1" in
    tee) cat >/dev/null ;;
    systemctl|bash) "$@" ;;
    *) return 1 ;;
  esac
}
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
}
export -f stat taskset
`;
  const result = spawnSync('bash', ['-c', stubs + setup.replaceAll('/proc/', '"$FUKULOW_SETUP_TEST"/proc/')], {
    env: { ...process.env, FUKULOW_SETUP_TEST: root }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /systemctl stop irqbalance\.service\nsystemctl mask --runtime irqbalance\.service/);
  assert.match(result.stderr, /IRQ affinity write failed: .*\/irq\/10\/smp_affinity_list/);
  assert.match(result.stderr, /IRQ affinity mode read failed: .*\/irq\/13\/smp_affinity_list/);
  assert.equal(readFileSync(writable, 'utf8'), '0,7,8,15\n');
  assert.equal(readFileSync(managed, 'utf8'), '5\n');
  assert.equal(readFileSync(unreadable, 'utf8'), '5\n');
  assert.equal(readFileSync(join(root, 'pins'), 'utf8'), '-pc 0,7,8,15 2\n-pc 0,7,8,15 30\n-pc 0,7,8,15 40\n');
});
