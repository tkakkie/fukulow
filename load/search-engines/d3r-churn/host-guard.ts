import assert from 'node:assert/strict';
import { docker } from '../bench.ts';
import { checkIdle } from '../d3r-leak/host.ts';

// On Linux the processes inside the run's own containers (W1 `k6 run`) appear in host `ps` and match the
// launcher's worker pattern, so the idle guard excludes their host PIDs.
export function topPids(raw: string) {
  const [header, ...rows] = raw.trim().split('\n');
  assert.equal(header?.trim(), 'PID', 'Unexpected docker top output');
  return rows.map(row => {
    const pid = Number(row.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Unexpected docker top PID');
    return pid;
  });
}

type Docker = (...args: string[]) => string;
const running = (run: Docker) => new Set(run('ps', '--format', '{{.Names}}').split('\n').filter(Boolean));

export function ownedPids(owned: string[], run: Docker = docker) {
  const live = running(run);
  return owned.filter(name => live.has(name)).flatMap(name => {
    try { return topPids(run('top', name, '-eo', 'pid')); }
    catch (error) {
      // A container that stopped after the listing has no processes left.
      if (running(run).has(name)) throw error;
      return [];
    }
  });
}

export function guardIdle(owned: string[], self: number[], idle = checkIdle, pids = ownedPids) {
  try { idle(owned, [...self, ...pids(owned)]); }
  // An owned container can start between the two listings; one fresh listing settles it.
  catch { idle(owned, [...self, ...pids(owned)]); }
}
