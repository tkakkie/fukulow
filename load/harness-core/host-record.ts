import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { freeBytes } from './host.ts';

// Host record for a measurement host (#796 item 2). Every reading is best effort: a missing or
// failed source is null, never an error, so recording cannot stop a run or its cleanup. Conditions
// are judged separately, and an unreadable condition is a violation, never a pass.

// Update jobs that must not run during a run (#796 item 3, maintainer decision 2026-11-24): these
// must be disabled (or masked) and inactive. The services the timers start must be inactive too,
// since a timer stopped after it fired leaves its service running.
export const updateUnits = ['apt-daily.timer', 'apt-daily-upgrade.timer', 'fwupd-refresh.timer', 'motd-news.timer', 'unattended-upgrades.service'];
export const timerServices = ['apt-daily.service', 'apt-daily-upgrade.service', 'fwupd-refresh.service', 'motd-news.service'];
export const sleepUnits = ['sleep.target', 'suspend.target', 'hibernate.target', 'hybrid-sleep.target'];

export type UnitState = { unit: string; enabled: string; active: string };
export type HostRecord = {
  at: string; platform: string; kernel: string; cpuModel: string | null; logicalCpus: number;
  governors: Record<string, number[]> | null; energyPreference: Record<string, number[]> | null;
  maxFrequencyKHz: Record<string, number[]> | null; boost: string | null; policyBoost: Record<string, number[]> | null;
  powerProfile: string | null; memoryBytes: number; meminfoKiB: Record<string, number> | null; swappiness: string | null;
  loadAverage: number[]; ac: { supply: string; online: boolean }[] | null; temperaturesC: Record<string, number> | null;
  disk: { path: string; freeBytes: number } | null; docker: { server: string; cpus: string | null } | null;
  updateUnits: UnitState[] | null; sleepUnits: UnitState[] | null;
  // 'absent' when snap is not installed; null when it is installed but its state could not be read.
  snapHold: string | null;
};

const read = (path: string) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
const list = (dir: string) => { try { return readdirSync(dir); } catch { return null; } };
// Bounded, and SIGKILL so a command that ignores SIGTERM cannot outlast the timeout.
const exec = (file: string, args: string[]) => spawnSync(file, args, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
// `systemctl is-enabled` and `is-active` exit non-zero for "disabled" and "inactive", so those keep stdout.
const cmd = (file: string, args: string[], allowNonZero = false) => {
  const child = exec(file, args);
  if (child.error || child.signal || child.stdout === null || (!allowNonZero && child.status !== 0)) return null;
  return child.stdout.trim() || null;
};

// Groups CPUs by a per-CPU sysfs value, for example { performance: [0, 1, ...] }.
export function groupBy(values: (string | null)[]): Record<string, number[]> | null {
  const groups: Record<string, number[]> = {};
  values.forEach((v, cpu) => { if (v !== null) (groups[v] ??= []).push(cpu); });
  return Object.keys(groups).length === 0 ? null : groups;
}

export function parseMeminfo(text: string) {
  const keys = ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'];
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+) kB$/.exec(line.trim());
    if (m && keys.includes(m[1])) out[m[1]] = Number(m[2]);
  }
  return out;
}

export function parseSnapHold(text: string) {
  return /^hold:\s*(.+)$/m.exec(text)?.[1].trim() ?? 'none';
}

function perCpu(file: string) {
  return cpus().map((_, i) => read(`/sys/devices/system/cpu/cpu${i}/cpufreq/${file}`));
}

function acSupplies() {
  const dir = '/sys/class/power_supply';
  const supplies = list(dir);
  if (supplies === null) return null;
  return supplies.filter(s => read(join(dir, s, 'type')) === 'Mains').map(s => ({ supply: s, online: read(join(dir, s, 'online')) === '1' }));
}

function temperatures() {
  const dir = '/sys/class/hwmon';
  const monitors = list(dir);
  if (monitors === null) return null;
  const out: Record<string, number> = {};
  for (const h of monitors) {
    const name = read(join(dir, h, 'name'));
    if (name === null) continue;
    for (const f of (list(join(dir, h)) ?? []).filter(f => /^temp\d+_input$/.test(f))) {
      const raw = read(join(dir, h, f));
      if (raw === null || raw === '' || !Number.isFinite(Number(raw))) continue;
      const label = read(join(dir, h, f.replace('_input', '_label'))) ?? f.replace('_input', '');
      out[`${name}/${label}`] = Number(raw) / 1000;
    }
  }
  return out;
}

function units(names: string[]): UnitState[] | null {
  if (cmd('systemctl', ['--version']) === null) return null;
  return names.map(unit => ({ unit, enabled: cmd('systemctl', ['is-enabled', unit], true) ?? 'unknown', active: cmd('systemctl', ['is-active', unit], true) ?? 'unknown' }));
}

// Absent only when snap is not installed at its fixed paths, so a PATH without it cannot hide an installed snapd.
const snapPaths = ['/usr/bin/snap', '/snap/bin', '/var/lib/snapd'];
function snapHold() {
  if (!snapPaths.some(p => existsSync(p))) return 'absent';
  const child = exec(existsSync('/usr/bin/snap') ? '/usr/bin/snap' : 'snap', ['refresh', '--time']);
  if (child.error || child.signal || child.status !== 0 || !child.stdout) return null;
  return parseSnapHold(child.stdout);
}

function diskFree(path: string) {
  const df = cmd('df', ['-Pk', path]);
  try { return df === null ? null : { path, freeBytes: freeBytes(df) }; } catch { return null; }
}

function docker() {
  const server = cmd('docker', ['version', '--format', '{{.Server.Version}}']);
  return server === null ? null : { server, cpus: cmd('docker', ['info', '--format', '{{.NCPU}}']) };
}

export function hostRecord(diskPath: string): HostRecord {
  const linux = platform() === 'linux';
  return {
    at: new Date().toISOString(), platform: platform(), kernel: release(),
    cpuModel: linux ? (/^model name\s*:\s*(.+)$/m.exec(read('/proc/cpuinfo') ?? '')?.[1] ?? null) : cmd('sysctl', ['-n', 'machdep.cpu.brand_string']),
    logicalCpus: cpus().length,
    governors: linux ? groupBy(perCpu('scaling_governor')) : null,
    energyPreference: linux ? groupBy(perCpu('energy_performance_preference')) : null,
    maxFrequencyKHz: linux ? groupBy(perCpu('cpuinfo_max_freq')) : null,
    boost: linux ? read('/sys/devices/system/cpu/cpufreq/boost') : null,
    // amd-pstate per-policy boost can be off while the global flag is on.
    policyBoost: linux ? groupBy(perCpu('boost')) : null,
    powerProfile: linux ? cmd('powerprofilesctl', ['get']) : null,
    memoryBytes: totalmem(), meminfoKiB: linux ? parseMeminfo(read('/proc/meminfo') ?? '') : null,
    swappiness: linux ? read('/proc/sys/vm/swappiness') : null, loadAverage: loadavg(),
    ac: linux ? acSupplies() : null, temperaturesC: linux ? temperatures() : null,
    disk: diskFree(diskPath), docker: docker(),
    updateUnits: linux ? units([...updateUnits, ...timerServices]) : null, sleepUnits: linux ? units(sleepUnits) : null,
    snapHold: linux ? snapHold() : null,
  };
}

const unitViolations = (states: UnitState[] | null, names: string[], ok: (u: UnitState) => boolean, what: string) => {
  if (states === null) return [`${what} unreadable (no systemctl)`];
  return names.flatMap(name => {
    const u = states.find(s => s.unit === name);
    if (!u) return [`${what} ${name} not recorded`];
    return ok(u) ? [] : [`${what} ${name} is ${u.enabled}/${u.active}`];
  });
};
const inactive = (u: UnitState) => ['inactive', 'failed'].includes(u.active);

// Measurement conditions on a Linux host (#796 item 3). Each entry is a reason to STOP. Other
// platforms keep their own checks; this returns nothing for them.
export function linuxViolations(r: HostRecord): string[] {
  if (r.platform !== 'linux') return [];
  const v: string[] = [];
  const performance = r.governors?.performance ?? [];
  if (r.logicalCpus < 1 || performance.length !== r.logicalCpus || performance.some((c, i) => c !== i)) {
    v.push(`CPU governor is not performance on every CPU: ${JSON.stringify(r.governors ?? 'unreadable')}`);
  }
  if (!r.ac?.some(s => s.online)) v.push('not on AC power');
  v.push(...unitViolations(r.updateUnits, updateUnits, u => ['disabled', 'masked', 'not-found'].includes(u.enabled) && inactive(u), 'update job'));
  v.push(...unitViolations(r.updateUnits, timerServices, inactive, 'update service'));
  v.push(...unitViolations(r.sleepUnits, sleepUnits, u => u.enabled === 'masked', 'sleep target'));
  if (r.snapHold === null) v.push('snap refresh state unreadable');
  else if (r.snapHold !== 'absent' && r.snapHold !== 'forever') v.push(`snap refreshes are not held: ${r.snapHold}`);
  return v;
}
