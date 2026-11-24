import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';

export type Policy = {
  cpu: number; policy: string; related: string; affected: string; driver: string;
  governor: string; epp: string; boost: string; min: string; max: string;
};
export type PolicySnapshot = { bootId: string; kernel: string; online: string; boost: string; profile: string; paranoid: string; policies: Policy[] };

const sys = '/sys/devices/system/cpu';
const read = (path: string) => readFileSync(path, 'utf8').trim();
const bootId = () => read('/proc/sys/kernel/random/boot_id');

export function readCpuPolicy(cpus: number[]): PolicySnapshot {
  return {
    bootId: bootId(), kernel: read('/proc/sys/kernel/osrelease'), online: read(`${sys}/online`),
    boost: read(`${sys}/cpufreq/boost`), profile: read('/sys/firmware/acpi/platform_profile'),
    paranoid: read('/proc/sys/kernel/perf_event_paranoid'),
    policies: cpus.map(cpu => {
      const path = realpathSync(`${sys}/cpu${cpu}/cpufreq`);
      const get = (key: string) => read(`${path}/${key}`);
      return { cpu, policy: basename(path), related: get('related_cpus'), affected: get('affected_cpus'),
        driver: get('scaling_driver'), governor: get('scaling_governor'), epp: get('energy_performance_preference'),
        boost: get('boost'), min: get('scaling_min_freq'), max: get('scaling_max_freq') };
    }),
  };
}

