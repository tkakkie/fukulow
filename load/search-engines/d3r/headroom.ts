// Rehearsal disk headroom (PR #781): the formal run keeps every round's artifacts and logs, so the
// rehearsal projects its own measured round onto the formal run's remaining rounds. No fixed size is assumed.
import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { rehearsalLabel } from './labels.ts';

export type Disk = {free: number; used: number};
export type DiskSample = {at: string; docker?: Disk; output?: Disk; error?: string};
const filesystems = ['docker', 'output'] as const;

// Parses `df -Pk` output (POSIX columns: filesystem, 1024-blocks, used, available) into bytes.
export function dfBytes(df: string): Disk {
  const fields = df.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? [];
  const [used, free] = [Number(fields[2]), Number(fields[3])];
  assert.ok([used, free].every(kib => Number.isSafeInteger(kib) && kib >= 0), 'Unreadable df output');
  return {free: free * 1024, used: used * 1024};
}

// Docker Desktop keeps volumes in its VM, so the host's statfs says nothing about them. As in
// load/harness-core/host.ts, a throwaway container's root filesystem sits on the same VM disk.
export const dockerDiskArgs = (image: string, label: string) => ['run', '--rm', '--pull', 'never', '--network', 'none',
  '--read-only', '--label', label, '--entrypoint', 'df', image, '-Pk', '/'];

export function outputDisk(path: string): Disk {
  const s = statfsSync(path, {bigint: true});
  return {free: Number(s.bavail * s.bsize), used: Number((s.blocks - s.bfree) * s.bsize)};
}

const valid = (disk: Disk | undefined) => disk !== undefined &&
  [disk.free, disk.used].every(bytes => Number.isSafeInteger(bytes) && bytes >= 0);

// Samples both filesystems only in a rehearsal; any other mode never probes. A failed probe is recorded
// and handed to onFailure, which stops the rehearsal at once instead of after the round.
export function headroomSampler(rehearsal: boolean, probe: {docker: () => Disk; output: () => Disk},
  onFailure: (samples: readonly DiskSample[]) => void) {
  const samples: DiskSample[] = [];
  const sample = (at: string) => {
    if (!rehearsal) return;
    const record: DiskSample = {at};
    try {
      record.docker = probe.docker();
      record.output = probe.output();
    } catch (error) {
      record.error = String(error);
    }
    samples.push(record);
    if (record.error !== undefined) onFailure(samples);
  };
  return {samples, sample};
}

// Per filesystem: roundGrowth = used(end) - used(start), at least 0; required = (formal - rehearsal rounds)
// x roundGrowth; the formal run is projected to fit when the lowest free value minus required is not negative.
export function projectHeadroom(samples: readonly DiskSample[], formalRounds: number, rehearsalRounds: number) {
  const problems: string[] = [];
  if (!(Number.isSafeInteger(formalRounds) && Number.isSafeInteger(rehearsalRounds) && rehearsalRounds >= 1 &&
    formalRounds >= rehearsalRounds)) problems.push('invalid round counts');
  if (samples.length < 2) problems.push('fewer than a start and an end sample');
  for (const s of samples) {
    if (s.error !== undefined) problems.push(`${s.at}: ${s.error}`);
    for (const fs of filesystems) if (!valid(s[fs])) problems.push(`${s.at}: ${fs} measurement missing`);
  }
  const projection = problems.length ? undefined : Object.fromEntries(filesystems.map(fs => {
    const disks = samples.map(s => s[fs] as Disk);
    const start = disks[0], end = disks[disks.length - 1];
    const minFree = Math.min(...disks.map(d => d.free));
    const roundGrowth = Math.max(0, end.used - start.used);
    const required = (formalRounds - rehearsalRounds) * roundGrowth;
    return [fs, {start, end, minFree, roundGrowth, required, margin: minFree - required, ok: minFree - required >= 0}];
  }));
  const ok = projection !== undefined && filesystems.every(fs => projection[fs].ok);
  return {label: rehearsalLabel, formalRounds, rehearsalRounds, samples, problems, projection, ok};
}

// Writes rehearsal-headroom.json and fails the rehearsal unless both filesystems are projected to fit.
export function assertHeadroom(out: string, samples: readonly DiskSample[], formalRounds: number, rehearsalRounds: number,
  save: (path: string, value: unknown) => void) {
  const report = projectHeadroom(samples, formalRounds, rehearsalRounds);
  save(`${out}/rehearsal-headroom.json`, report);
  assert.ok(report.ok, `${rehearsalLabel} INVALID: disk headroom for the formal rounds is not established (${
    report.problems.length ? report.problems.join('; ') : filesystems.filter(fs => !report.projection?.[fs].ok)
      .map(fs => `${fs} margin ${report.projection?.[fs].margin} bytes`).join('; ')})`);
  return report;
}
