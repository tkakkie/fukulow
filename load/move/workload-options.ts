import type { Options } from 'k6/options';
import type { LaneName } from './judge.ts';
import { outcomes } from './metrics.ts';
import { moveInterval, type Plan, type Step } from './plan.ts';

export const counts = ['attempted', ...outcomes] as const;

// Pure k6 scenario and threshold construction, shared by workload-k6.ts and its tests.
// DIAGNOSTIC attribution runs may keep one Part D read lane; 'all' is the formal load.
export function workloadOptions(p: Plan, step: Step, readLanes = 'all') {
  const drain = `${p.drain}s`;
  const seconds = step.part === 'E' ? p.replaySeconds : p.seconds;
  const scenario = (rate: number, timeUnit: string, runSeconds: number, vus: number, maxVUs: number, exec: string) =>
    ({ executor: 'constant-arrival-rate' as const, rate, timeUnit, duration: `${runSeconds}s`, preAllocatedVUs: vus, maxVUs, gracefulStop: drain, exec });
  const lanes = new Set<LaneName>(['reader']);
  const scenarios: NonNullable<Options['scenarios']> = {
    reader: scenario(p.readerRate, '1s', seconds + p.drain, 2, 20, 'reader'),
  };
  const topicScenarios: string[] = [];
  if (step.part === 'E') {
    lanes.add('replay');
    scenarios.replay = { executor: 'per-vu-iterations', vus: p.topicReaders, iterations: p.replayPerReader,
      maxDuration: `${seconds}s`, gracefulStop: drain, exec: 'replay' };
  } else {
    lanes.add('send');
    scenarios.send = scenario(p.sendRate, '1s', seconds, p.smoke ? 2 : 250, p.smoke ? 8 : 2000, 'send');
    if (step.arm === 'move') {
      lanes.add('move');
      // One writer carries the chain version and destination from one committed Move to the next.
      scenarios.move = scenario(1, `${moveInterval(step.size)}s`, seconds, 1, 1, 'move');
    }
    if (step.part === 'D' && readLanes !== 'topics') {
      lanes.add('channels');
      scenarios.channels = scenario(p.channelRate, '1s', seconds, p.smoke ? 2 : 500, p.smoke ? 8 : 2000, 'channels');
    }
    if (step.part === 'D' && readLanes !== 'channels') {
      lanes.add('topics');
      for (let i = 0; i < p.topicReaders; i++) {
        const name = `topic${i}`;
        topicScenarios.push(name);
        scenarios[name] = { executor: 'constant-vus', vus: 1, duration: `${seconds}s`, gracefulStop: drain, exec: 'topics' };
      }
    }
  }
  const options: Options = {
    scenarios,
    discardResponseBodies: true,
    summaryTrendStats: ['p(95)', 'p(99)'],
    systemTags: ['scenario', 'status', 'name'],
    thresholds: Object.fromEntries([
      ...Object.keys(scenarios).map(name => [`dropped_iterations{scenario:${name}}`, ['count>=0']]),
      ...[...lanes].flatMap(lane => [
        ...counts.map(name => [`move_${name}{scenario:${lane}}`, ['count>=0']]),
        [`move_success_ms{scenario:${lane}}`, ['max>=0']],
      ]),
      ...topicScenarios.map(name => [`move_topic_reads{scenario:${name}}`, ['count>=0']]),
    ]),
  };
  return { lanes, topicScenarios, options };
}
