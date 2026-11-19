import { settings } from '../pool-before-after-summary.ts';

export type Part = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type Arm = 'baseline' | 'move';
export type Cell = { part: Part; size: number };
export type Step = Cell & { round: number; arm: Arm };
export const moveLimits = { 1: 20, 10: 30, 100: 80, 1000: 500 } as const;
export const thresholds = { accepted: 0.99, latencyPercent: 110, pageP95: 100, walRatio: 2 } as const;
export const formalSizes = [1, 10, 100, 1000] as const;
export const parts = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export function plan(smoke: boolean) {
  return {
    smoke,
    members: smoke ? 12 : settings.members,
    channels: smoke ? 4 : settings.channels,
    sizes: smoke ? [2] : formalSizes,
    rounds: smoke ? 1 : 3,
    moves: smoke ? 2 : 30,
    seconds: smoke ? 3 : settings.seconds,
    replaySeconds: smoke ? 3 : 60,
    drain: smoke ? 1 : 11,
    sendRate: smoke ? 4 : 250,
    channelRate: smoke ? 2 : settings.readRate,
    readerRate: settings.otherOrganizationRate,
    topicReaders: smoke ? 1 : 4,
    topicLimit: smoke ? 2 : 50,
    backgroundTopics: smoke ? 2 : 100,
    replayPage: smoke ? 5 : 50,
    replayPerReader: smoke ? 2 : 25,
    burst: settings.sendBurst,
    refill: settings.sendRefillPerSecond,
  };
}
export type Plan = ReturnType<typeof plan>;
export const moveInterval = (size: number) => size === 1000 ? 5 : 1;
export const tombstones = (size: number) => Math.floor(size / 100);

export function cells(p: Plan): Cell[] {
  return parts.flatMap(part => p.sizes.filter(size => p.smoke || part === 'A' || part === 'F' || size >= 100)
    .map(size => ({ part, size })));
}

export function steps(p: Plan): Step[] {
  return cells(p).flatMap(cell => Array.from({ length: p.rounds }, (_, i) => {
    const order: Arm[] = cell.part === 'A' ? ['move'] : i % 2 === 0 ? ['baseline', 'move'] : ['move', 'baseline'];
    return order.map(arm => ({ ...cell, round: i + 1, arm }));
  }).flat());
}

export const stepId = ({ part, size, round, arm }: Step) => `${part}-${size}-r${round}-${arm}`;
