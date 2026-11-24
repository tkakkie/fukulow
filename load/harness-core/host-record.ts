import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { freeBytes } from './host.ts';

// Host record for a measurement host (#796 item 2). Every reading is best effort: a missing source
// is null, never an error, so the record itself cannot stop a run. Conditions are judged separately.

// Update jobs that must not run during a run (#796 item 3, maintainer decision 2026-11-24).
export const updateUnits = ['apt-daily.timer', 'apt-daily-upgrade.timer', 'fwupd-refresh.timer', 'motd-news.timer', 'unattended-upgrades.service'];
export const sleepUnits = ['sleep.target', 'suspend.target', 'hibernate.target', 'hybrid-sleep.target'];

export type UnitState = { unit: string; enabled: string; active: string };
export type HostRecord = {
  at: string; platform: string; kernel: string; cpuModel: string | null; logicalCpus: number;
  governors: Record<string, number[]> | null; energyPreference: Record<string, number[]> | null;
  maxFrequencyKHz: Record<string, number[]> | null; boost: string | null; powerProfile: string | null;
  memoryBytes: number; meminfoKiB: Record<string, number> | null; swappiness: string | null; loadAverage: number[];
  ac: { supply: string; online: boolean }[] | null; temperaturesC: Record<string, number> | null;
  disk: { path: string; freeBytes: number } | null; docker: { server: string; cpus: string } | null;
  updateUnits: UnitState[] | null; sleepUnits: UnitState[] | null; snapHold: string | null;
};

const read = (path: string) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
const cmd = (file: string, args: string[]) => {
  const child = spawnSync(file, args, { encoding: 'utf8', timeout: 30_000 });
  return child.error || child.stdout === null ? null : child.stdout.trim();
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
  if (!existsSync(dir)) return null;
  return readdirSync(dir).filter(s => read(join(dir, s, 'type')) === 'Mains').map(s => ({ supply: s, online: read(join(dir, s, 'online')) === '1' }));
}

function temperatures() {
  const dir = '/sys/class/hwmon';
  if (!existsSync(dir)) return null;
  const out: Record<string, number> = {};
  for (const h of readdirSync(dir)) {
    const name = read(join(dir, h, 'name'));
    if (name === null) continue;
    for (const f of readdirSync(join(dir, h)).filter(f => /^temp\d+_input$/.test(f))) {
      const milli = Number(read(join(dir, h, f)));
      const label = read(join(dir, h, f.replace('_input', '_label'))) ?? f.replace('_input', '');
      if (Number.isFinite(milli)) out[`${name}/${label}`] = milli / 1000;
    }
  }
  return out;
}

function units(names: string[]): UnitState[] | null {
  if (cmd('systemctl', ['--version']) === null) return null;
  return names.map(unit => ({ unit, enabled: cmd('systemctl', ['is-enabled', unit]) || 'unknown', active: cmd('systemctl', ['is-active', unit]) || 'unknown' }));
}

export function hostRecord(diskPath: string): HostRecord {
  const linux = platform() === 'linux';
  const df = cmd('df', ['-Pk', diskPath]);
  let disk: HostRecord['disk'] = null;
  try { if (df !== null) disk = { path: diskPath, freeBytes: freeBytes(df) }; } catch { disk = null; }
  const server = cmd('docker', ['version', '--format', '{{.Server.Version}}']);
  const snap = linux ? cmd('snap', ['refresh', '--time']) : null;
  return {
    at: new Date().toISOString(), platform: platform(), kernel: release(),
    cpuModel: linux ? (/^model name\s*:\s*(.+)$/m.exec(read('/proc/cpuinfo') ?? '')?.[1] ?? null) : cmd('sysctl', ['-n', 'machdep.cpu.brand_string']),
    logicalCpus: cpus().length,
    governors: linux ? groupBy(perCpu('scaling_governor')) : null,
    energyPreference: linux ? groupBy(perCpu('energy_performance_preference')) : null,
    maxFrequencyKHz: linux ? groupBy(perCpu('cpuinfo_max_freq')) : null,
    boost: linux ? read('/sys/devices/system/cpu/cpufreq/boost') : null,
    powerProfile: linux ? cmd('powerprofilesctl', ['get']) : null,
    memoryBytes: totalmem(), meminfoKiB: linux ? parseMeminfo(read('/proc/meminfo') ?? '') : null,
    swappiness: linux ? read('/proc/sys/vm/swappiness') : null, loadAverage: loadavg(),
    ac: linux ? acSupplies() : null, temperaturesC: linux ? temperatures() : null,
    disk,
    docker: server === null ? null : { server, cpus: cmd('docker', ['info', '--format', '{{.NCPU}}']) ?? '' },
    updateUnits: linux ? units(updateUnits) : null, sleepUnits: linux ? units(sleepUnits) : null,
    snapHold: snap === null ? null : parseSnapHold(snap),
  };
}

// Measurement conditions on a Linux host (#796 item 3). Each entry is a reason to STOP. Other
// platforms keep their own checks; this returns nothing for them.
export function linuxViolations(r: HostRecord): string[] {
  if (r.platform !== 'linux') return [];
  const v: string[] = [];
  const governors = Object.keys(r.governors ?? {});
  if (governors.length !== 1 || governors[0] !== 'performance') v.push(`CPU governor is not performance on every CPU: ${governors.join(', ') || 'unreadable'}`);
  if (r.ac === null || r.ac.length === 0 || r.ac.some(s => !s.online)) v.push('not on AC power');
  for (const u of r.updateUnits ?? [{ unit: 'systemd', enabled: 'unreadable', active: 'unreadable' }]) {
    if (!['disabled', 'masked'].includes(u.enabled) || ['active', 'activating', 'reloading'].includes(u.active)) v.push(`update job ${u.unit} is ${u.enabled}/${u.active}`);
  }
  for (const u of r.sleepUnits ?? []) if (u.enabled !== 'masked') v.push(`${u.unit} is not masked`);
  if (r.snapHold !== null && r.snapHold !== 'forever') v.push(`snap refreshes are not held: ${r.snapHold}`);
  return v;
}
