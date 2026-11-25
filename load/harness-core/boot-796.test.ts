import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { runInNewContext } from 'node:vm';
import { frequency, hostFiles, housekeepingMask, layoutProblems, scopeRule, sourceDir } from './boot-796-files.ts';
import { installBootSetup, reloadPending, uninstallBootSetup } from './boot-796.ts';
import { measuredCpus, sets796 } from './frequency-layout.ts';

const readSource = (name: string) => readFileSync(join(sourceDir, name), 'utf8');
const temporary: string[] = [];
after(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); temporary.push(dir); return dir; };
// A copy of the versioned files with one replacement, for negative tests.
function tamperedSource(file: string, from: string, to: string) {
  const source = tempDir('boot-796-source-');
  cpSync(sourceDir, source, { recursive: true });
  assert.ok(readSource(file).includes(from), `${file} contains ${from}`);
  writeFileSync(join(source, file), readSource(file).replace(from, to));
  return source;
}

// A host as found before install: graphical default target, irqbalance enabled, the hand-made governor unit.
function fakeHost({ irqbalanceMasked = false, defaultTarget = true } = {}) {
  const root = tempDir('boot-796-');
  for (const dir of ['usr/lib/systemd/system', 'etc/systemd/system/multi-user.target.wants', 'etc/default/grub.d', 'usr/local/libexec',
    'usr/share/polkit-1/rules.d']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const target of ['multi-user.target', 'graphical.target']) writeFileSync(join(root, 'usr/lib/systemd/system', target), '[Unit]\n');
  writeFileSync(join(root, 'etc/systemd/system/fukulow-cpu-performance.service'), '[Service]\nType=oneshot\n');
  if (defaultTarget) symlinkSync('/lib/systemd/system/graphical.target', join(root, 'etc/systemd/system/default.target'));
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
    const expected = file.source === scopeRule ? readSource(file.source).replace('"MEASUREMENT_USER"', JSON.stringify(userInfo().username)) : readSource(file.source);
    assert.equal(readFileSync(join(root, file.target), 'utf8'), expected, file.target);
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

test('the installed polkit rule only authorizes starting a #668 scope as the configured user', () => {
  const root = fakeHost();
  const measurementUser = 'measurement-test';
  const target = 'usr/share/polkit-1/rules.d/49-fukulow668-scopes.rules';
  installBootSetup(root, { measurementUser, run: () => {} });
  const source = readFileSync(join(root, target), 'utf8');
  assert.match(source, /scope runs the caller's own process/);
  type Action = { id: string; lookup: (name: string) => string | undefined };
  let rule: ((action: Action, subject: { user: string }) => unknown) | undefined;
  const yes = Symbol('YES');
  runInNewContext(source, { polkit: { Result: { YES: yes }, addRule: (fn: typeof rule) => { rule = fn; } } });
  assert.ok(rule);

  const id = 'org.freedesktop.systemd1.manage-units';
  const details = { unit: 'fukulow668-client-42.scope', verb: 'start' };
  const action = (id: string, details: Record<string, string | undefined>) => ({ id, lookup: (name: string) => details[name] });
  assert.equal(rule(action(id, details), { user: measurementUser }), yes);
  assert.equal(rule(action(id, details), { user: 'other-user' }), undefined);
  assert.equal(rule(action(id, details), { user: 'MEASUREMENT_USER' }), undefined);
  assert.equal(rule(action('org.freedesktop.systemd1.reload-daemon', details), { user: measurementUser }), undefined);
  for (const patch of [{ verb: 'stop' }, { verb: 'restart' }, { verb: undefined }, { unit: undefined },
    { unit: 'other-fukulow668-client-42.scope' }, { unit: 'fukulow668-client-42.service' }, { unit: 'fukulow668-client-42.scope.service' }]) {
    assert.equal(rule(action(id, { ...details, ...patch }), { user: measurementUser }), undefined, JSON.stringify(patch));
  }
});

test('boot check detects a missing, modified or differently configured #668 polkit rule', () => {
  const root = fakeHost(), target = 'usr/share/polkit-1/rules.d/49-fukulow668-scopes.rules';
  const run = () => {};
  installBootSetup(root, { run, measurementUser: 'first-user' });
  assert.deepEqual(installBootSetup(root, { run, dryRun: true, measurementUser: 'first-user' }), []);
  assert.deepEqual(installBootSetup(root, { run, dryRun: true, measurementUser: 'second-user' }), [`/${target}`]);
  writeFileSync(join(root, target), 'changed');
  assert.deepEqual(installBootSetup(root, { run, dryRun: true, measurementUser: 'first-user' }), [`/${target}`]);
  unlinkSync(join(root, target));
  assert.deepEqual(installBootSetup(root, { run, dryRun: true, measurementUser: 'first-user' }), [`/${target}`]);
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
    const source = tamperedSource(file, from, to);
    assert.throws(() => installBootSetup(root, { source, run }), problem);
    assert.deepEqual(calls, []);
    assert.deepEqual(snapshot(root), before);
  }
});

test('install refuses an unexpected irqbalance unit, default target file or missing multi-user target', () => {
  const cases: [string, (root: string) => void, RegExp][] = [
    ['irqbalance override', root => writeFileSync(join(root, 'etc/systemd/system/irqbalance.service'), '[Service]\n'), /irqbalance\.service is not a mask/],
    ['default target file', root => {
      unlinkSync(join(root, 'etc/systemd/system/default.target'));
      writeFileSync(join(root, 'etc/systemd/system/default.target'), '[Unit]\n');
    }, /default\.target is a file, not a symlink/],
    ['no multi-user target', root => unlinkSync(join(root, 'usr/lib/systemd/system/multi-user.target')), /multi-user\.target is missing/],
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
  unlinkSync(join(root, 'etc/fukulow-796/install-state.json'));
  assert.throws(() => uninstallBootSetup(root, { run: () => assert.fail('ran') }), /previous boot state is unknown/);
});

test('every other wrong value in a versioned file is rejected', () => {
  const tamper = [
    ['frequency.sh', 'profile=performance', 'profile=balanced', /frequency\.sh: profile/],
    ['frequency.sh', 'governor=performance', 'governor=powersave', /frequency\.sh: governor/],
    ['frequency.sh', 'boost=0', 'boost=1', /frequency\.sh: boost/],
    ['frequency.sh', 'max_khz=2000000', 'max_khz=1700000', /frequency\.sh: max_khz/],
    ['frequency.sh', 'powerprofilesctl set "$profile"', 'true', /frequency\.sh: must store the profile/],
    ['affinity.sh', 'housekeeping=0,7,8,15', 'housekeeping=0,8', /affinity\.sh: housekeeping/],
    ['housekeeping-scope.conf', '[Scope]', '[Slice]', /housekeeping-scope\.conf: needs a \[Scope\]/],
    ['fukulow796-host.service', 'ExecStart=/usr/local/libexec/fukulow796/affinity.sh', 'ExecStart=/usr/local/bin/affinity.sh', /ExecStart must run/],
    ['fukulow796-host.service', 'Wants=fukulow796.slice power-profiles-daemon.service', 'Wants=fukulow796.slice', /Wants must be/],
    ['fukulow796-host.service', 'After=multi-user.target fukulow796.slice power-profiles-daemon.service', 'After=multi-user.target fukulow796.slice', /After must include power-profiles-daemon/],
    ['fukulow796-host.service', 'After=multi-user.target fukulow796.slice', 'After=fukulow796.slice', /After must include multi-user\.target/],
    ['fukulow796-host.service', 'WantedBy=multi-user.target', 'WantedBy=graphical.target', /WantedBy must be/],
  ] as const;
  for (const [file, from, to, problem] of tamper) {
    const source = tamperedSource(file, from, to);
    assert.ok(layoutProblems(name => readFileSync(join(source, name), 'utf8')).some(p => problem.test(p)), `${file}: ${to}`);
  }
});

test('install and uninstall round-trip a host that had no default.target link', () => {
  const root = fakeHost({ defaultTarget: false }), before = snapshot(root);
  installBootSetup(root, { run: () => {} });
  assert.equal(JSON.parse(readFileSync(join(root, 'etc/fukulow-796/install-state.json'), 'utf8')).defaultTarget, null);
  assert.equal(readlinkSync(join(root, 'etc/systemd/system/default.target')), '/usr/lib/systemd/system/multi-user.target');
  uninstallBootSetup(root, { run: () => {} });
  assert.deepEqual(snapshot(root), before);
});

test('install refuses a symlinked target, a file at the wants link or an irqbalance link elsewhere, before any change', () => {
  const cases: [string, (root: string) => void, RegExp][] = [
    ['grub drop-in symlink', root => symlinkSync('/etc/hostname', join(root, 'etc/default/grub.d/fukulow-796.cfg')), /fukulow-796\.cfg is a link/],
    ['wants file', root => writeFileSync(join(root, 'etc/systemd/system/multi-user.target.wants/fukulow796-host.service'), ''), /fukulow796-host\.service is a file/],
    ['irqbalance link', root => symlinkSync('/etc/irqbalance.service', join(root, 'etc/systemd/system/irqbalance.service')), /irqbalance\.service is not a mask/],
  ];
  for (const [name, prepare, problem] of cases) {
    const root = fakeHost();
    prepare(root);
    const before = snapshot(root);
    assert.throws(() => installBootSetup(root, { run: () => assert.fail(name) }), problem, name);
    assert.deepEqual(snapshot(root), before, name);
  }
});

test('uninstall refuses a default.target replaced by a file before removing anything', () => {
  const root = fakeHost();
  installBootSetup(root, { run: () => {} });
  unlinkSync(join(root, 'etc/systemd/system/default.target'));
  writeFileSync(join(root, 'etc/systemd/system/default.target'), '[Unit]\n');
  const before = snapshot(root);
  assert.throws(() => uninstallBootSetup(root, { run: () => assert.fail('ran') }), /default\.target is a file/);
  assert.deepEqual(snapshot(root), before);
});

test('a corrupted or unknown-version state file is refused', () => {
  for (const content of ['{', '{"version":2,"defaultTarget":null,"irqbalanceMasked":false}', '{"version":1,"defaultTarget":3,"irqbalanceMasked":false}', 'null']) {
    const root = fakeHost();
    installBootSetup(root, { run: () => {} });
    writeFileSync(join(root, 'etc/fukulow-796/install-state.json'), content);
    assert.throws(() => installBootSetup(root, { run: () => {} }), /unreadable \/etc\/fukulow-796\/install-state\.json/, content);
    assert.throws(() => uninstallBootSetup(root, { run: () => {} }), /unreadable \/etc\/fukulow-796\/install-state\.json/, content);
  }
});

test('a failed reload stays visible: check fails and the next install reruns it', () => {
  const root = fakeHost();
  assert.throws(() => installBootSetup(root, { run: program => { if (program === 'update-grub') throw new Error('grub failed'); } }), /grub failed/);
  assert.deepEqual(installBootSetup(root, { run: () => {}, dryRun: true }), [`/${reloadPending}`]);
  const { calls, run } = recorder();
  assert.deepEqual(installBootSetup(root, { run }), [`/${reloadPending}`]);
  assert.deepEqual(calls, ['systemctl daemon-reload', 'update-grub']);
  assert.deepEqual(installBootSetup(root, { run, dryRun: true }), []);
});

test('a failed uninstall reload keeps the state file, so the rerun reloads again', () => {
  const root = fakeHost(), before = snapshot(root);
  installBootSetup(root, { run: () => {} });
  assert.throws(() => uninstallBootSetup(root, { run: program => { if (program === 'update-grub') throw new Error('grub failed'); } }), /grub failed/);
  const { calls, run } = recorder();
  assert.deepEqual(uninstallBootSetup(root, { run }), ['/etc/fukulow-796/install-state.json']);
  assert.deepEqual(calls, ['systemctl daemon-reload', 'update-grub']);
  assert.deepEqual(snapshot(root), before);
});

test('the CLI with a staging --root installs there without touching the live host', () => {
  const root = fakeHost();
  const cli = (command: string, measurementUser: string) => spawnSync(process.execPath,
    [join(import.meta.dirname, 'boot-796.ts'), command, '--root', root, '--measurement-user', measurementUser],
    { encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 10_000 });
  const result = cli('install', 'measurement-cli');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed.length, hostFiles.length + 4);
  const check = cli('check', 'measurement-cli');
  assert.equal(check.status, 0, check.stderr);
  assert.equal(cli('check', 'other-user').status, 1);
});
