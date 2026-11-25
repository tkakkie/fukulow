import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { frequency, hostFiles, housekeepingMask, layoutProblems, sourceDir } from './boot-796-files.ts';
import { installBootSetup, uninstallBootSetup } from './boot-796.ts';
import { measuredCpus, sets796 } from './frequency-layout.ts';

const readSource = (name: string) => readFileSync(join(sourceDir, name), 'utf8');

// A host as found before install: graphical default target, irqbalance enabled, the hand-made governor unit.
function fakeHost({ irqbalanceMasked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'boot-796-'));
  for (const dir of ['usr/lib/systemd/system', 'etc/systemd/system/multi-user.target.wants', 'etc/default/grub.d', 'usr/local/libexec']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const target of ['multi-user.target', 'graphical.target']) writeFileSync(join(root, 'usr/lib/systemd/system', target), '[Unit]\n');
  writeFileSync(join(root, 'etc/systemd/system/fukulow-cpu-performance.service'), '[Service]\nType=oneshot\n');
  symlinkSync('/lib/systemd/system/graphical.target', join(root, 'etc/systemd/system/default.target'));
  symlinkSync('/usr/lib/systemd/system/irqbalance.service', join(root, 'etc/systemd/system/multi-user.target.wants/irqbalance.service'));
  if (irqbalanceMasked) symlinkSync('/dev/null', join(root, 'etc/systemd/system/irqbalance.service'));
  return root;
}

// Every path under root with its type, mode and content or link target.
function snapshot(root: string, dir = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, dir)).sort()) {
    const path = join(dir, name), stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) out[path] = `link ${readlinkSync(join(root, path))}`;
    else if (stat.isDirectory()) { out[path] = 'dir'; Object.assign(out, snapshot(root, path)); }
    else out[path] = `${(stat.mode & 0o777).toString(8)} ${stat.mtimeMs} ${readFileSync(join(root, path), 'utf8')}`;
  }
  return out;
}

const recorder = () => { const calls: string[] = []; return { calls, run: (program: string, args: string[]) => { calls.push([program, ...args].join(' ')); } }; };

test('the versioned boot files agree with the #796 layout the host check expects', () => {
  assert.deepEqual(layoutProblems(readSource), []);
  assert.match(readSource('fukulow796.slice'), /^AllowedCPUs=1-6,9-14$/m);
  assert.deepEqual(measuredCpus, [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]);
  assert.equal(housekeepingMask, '8181');
  assert.deepEqual(sets796.housekeeping, [0, 7, 8, 15]);
  assert.match(readSource('grub.cfg'), /^GRUB_CMDLINE_LINUX_DEFAULT="\$GRUB_CMDLINE_LINUX_DEFAULT irqaffinity=0,7,8,15"\n$/);
  assert.deepEqual(frequency, { profile: 'performance', governor: 'performance', boost: '0', max_khz: '2000000' });
  for (const script of ['affinity.sh', 'frequency.sh']) {
    assert.match(readSource(script), /^#!\/usr\/bin\/env bash\n(?:#.*\n)*set -euo pipefail\n/);
    execFileSync('bash', ['-n', join(sourceDir, script)]);
  }
});

test('install writes every file, mask, link and the previous state, then reloads systemd and grub once', () => {
  const root = fakeHost(), { calls, run } = recorder();
  const changed = installBootSetup(root, { run });
  assert.equal(changed.length, hostFiles.length + 4);
  assert.deepEqual(calls, ['systemctl daemon-reload', 'update-grub']);
  for (const file of hostFiles) {
    assert.equal(readFileSync(join(root, file.target), 'utf8'), readSource(file.source), file.target);
    assert.equal(lstatSync(join(root, file.target)).mode & 0o777, file.mode, file.target);
  }
  assert.equal(readFileSync(join(root, 'etc/systemd/system/docker.service.d/fukulow-796.conf'), 'utf8'), readSource('housekeeping-service.conf'));
  assert.equal(readFileSync(join(root, 'etc/systemd/system/init.scope.d/fukulow-796.conf'), 'utf8'), readSource('housekeeping-scope.conf'));
  assert.equal(readlinkSync(join(root, 'etc/systemd/system/multi-user.target.wants/fukulow796-host.service')), '/etc/systemd/system/fukulow796-host.service');
  assert.equal(readlinkSync(join(root, 'etc/systemd/system/irqbalance.service')), '/dev/null');
  assert.equal(readlinkSync(join(root, 'etc/systemd/system/default.target')), '/usr/lib/systemd/system/multi-user.target');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'etc/fukulow-796/install-state.json'), 'utf8')),
    { version: 1, defaultTarget: '/lib/systemd/system/graphical.target', irqbalanceMasked: false });
});

test('a second install changes nothing and runs nothing', () => {
  const root = fakeHost();
  installBootSetup(root, { run: () => {} });
  const before = snapshot(root), { calls, run } = recorder();
  assert.deepEqual(installBootSetup(root, { run }), []);
  assert.deepEqual(installBootSetup(root, { run, dryRun: true }), []);
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshot(root), before);
});

test('check (dry run) lists the pending changes without writing', () => {
  const root = fakeHost(), before = snapshot(root), { calls, run } = recorder();
  assert.equal(installBootSetup(root, { run, dryRun: true }).length, hostFiles.length + 4);
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshot(root), before);
  installBootSetup(root, { run });
  writeFileSync(join(root, 'etc/systemd/system/fukulow796.slice'), '[Slice]\nAllowedCPUs=0-15\n');
  assert.deepEqual(installBootSetup(root, { run, dryRun: true }), ['/etc/systemd/system/fukulow796.slice']);
});

test('uninstall restores the previous boot behaviour, and a second uninstall does nothing', () => {
  for (const irqbalanceMasked of [false, true]) {
    const root = fakeHost({ irqbalanceMasked }), before = snapshot(root);
    installBootSetup(root, { run: () => {} });
    const { calls, run } = recorder();
    assert.ok(uninstallBootSetup(root, { run }).includes('/etc/fukulow-796/install-state.json'));
    assert.deepEqual(calls, ['systemctl daemon-reload', 'update-grub']);
    assert.deepEqual(snapshot(root), before, `irqbalance masked before install: ${irqbalanceMasked}`);
    assert.deepEqual(uninstallBootSetup(root, { run }), []);
    assert.equal(calls.length, 2);
  }
});

test('a wrong CPU set in a versioned file is rejected before anything changes', () => {
  const tamper = [
    ['fukulow796.slice', 'AllowedCPUs=1-6,9-14', 'AllowedCPUs=1-7,9-14', /fukulow796\.slice: AllowedCPUs/],
    ['housekeeping-slice.conf', 'AllowedCPUs=0,7,8,15', 'AllowedCPUs=0,8', /housekeeping-slice\.conf: AllowedCPUs/],
    ['affinity.sh', 'mask=8181', 'mask=8180', /affinity\.sh: mask/],
    ['grub.cfg', 'irqaffinity=0,7,8,15', 'irqaffinity=0-15', /grub\.cfg: irqaffinity/],
  ] as const;
  for (const [file, from, to, problem] of tamper) {
    const root = fakeHost(), before = snapshot(root), { calls, run } = recorder();
    const source = mkdtempSync(join(tmpdir(), 'boot-796-source-'));
    cpSync(sourceDir, source, { recursive: true });
    writeFileSync(join(source, file), readSource(file).replace(from, to));
    assert.throws(() => installBootSetup(root, { source, run }), problem);
    assert.deepEqual(calls, []);
    assert.deepEqual(snapshot(root), before);
  }
});

test('install refuses an unexpected irqbalance unit, default target file or missing multi-user target', () => {
  const cases: [string, (root: string) => void, RegExp][] = [
    ['irqbalance override', root => writeFileSync(join(root, 'etc/systemd/system/irqbalance.service'), '[Service]\n'), /irqbalance\.service is not a mask/],
    ['default target file', root => {
      execFileSync('rm', [join(root, 'etc/systemd/system/default.target')]);
      writeFileSync(join(root, 'etc/systemd/system/default.target'), '[Unit]\n');
    }, /default\.target is not a symlink/],
    ['no multi-user target', root => execFileSync('rm', [join(root, 'usr/lib/systemd/system/multi-user.target')]), /multi-user\.target is missing/],
  ];
  for (const [name, prepare, problem] of cases) {
    const root = fakeHost();
    prepare(root);
    const before = snapshot(root);
    assert.throws(() => installBootSetup(root, { run: () => assert.fail(name) }), problem, name);
    assert.deepEqual(snapshot(root), before, name);
  }
});

test('uninstall refuses installed files without the recorded previous state', () => {
  const root = fakeHost();
  installBootSetup(root, { run: () => {} });
  execFileSync('rm', [join(root, 'etc/fukulow-796/install-state.json')]);
  assert.throws(() => uninstallBootSetup(root, { run: () => assert.fail('ran') }), /previous boot state is unknown/);
});
