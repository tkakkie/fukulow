import { cpuList, type CpuSets } from './cpusets.ts';

export const cpus796 = Array.from({ length: 16 }, (_, cpu) => cpu);
export const sets796 = {
  server: [2, 4, 6, 10, 12, 14],
  client: [1, 3, 5, 9, 11, 13],
  housekeeping: [0, 7, 8, 15],
};
export const measurementSlice = 'fukulow796.slice';
export const measuredCpus = [...sets796.server, ...sets796.client].sort((a, b) => a - b);
export const measuredSetsArg = `server=${cpuList(sets796.server)};client=${cpuList(sets796.client)}`;
export const halfSet = (cpus: number[]) => Math.ceil(cpus.length / 2);

export const matches796 = (sets: CpuSets | undefined | null) => Boolean(sets &&
  (['server', 'client', 'housekeeping'] as const).every(set =>
    JSON.stringify(sets[set]) === JSON.stringify(sets796[set])));
