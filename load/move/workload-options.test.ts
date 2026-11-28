import assert from 'node:assert/strict';
import test from 'node:test';
import { outcomes } from './metrics.ts';
import { moveInterval, plan, rehearsalPlan, steps, type Plan, type Step } from './plan.ts';
import { workloadOptions } from './workload-options.ts';

// Frozen copy of the k6 options construction at d655a3ad (before #758), the formal Part D load.
function frozen(p: Plan, step: Step) {
  const drain = `${p.drain}s`;
  const seconds = step.part === 'E' ? p.replaySeconds : p.seconds;
  const scenario = (rate: number, timeUnit: string, runSeconds: number, vus: number, maxVUs: number, exec: string) =>
    ({ executor: 'constant-arrival-rate' as const, rate, timeUnit, duration: `${runSeconds}s`, preAllocatedVUs: vus, maxVUs, gracefulStop: drain, exec });
  const lanes = new Set<string>(['reader']);
  const scenarios: Record<string, object> = { reader: scenario(p.readerRate, '1s', seconds + p.drain, 2, 20, 'reader') };
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
      scenarios.move = scenario(1, `${moveInterval(step.size)}s`, seconds, 1, 1, 'move');
    }
    if (step.part === 'D') {
      lanes.add('channels');
      lanes.add('topics');
      scenarios.channels = scenario(p.channelRate, '1s', seconds, p.smoke ? 2 : 500, p.smoke ? 8 : 2000, 'channels');
      for (let i = 0; i < p.topicReaders; i++) {
        const name = `topic${i}`;
        topicScenarios.push(name);
        scenarios[name] = { executor: 'constant-vus', vus: 1, duration: `${seconds}s`, gracefulStop: drain, exec: 'topics' };
      }
    }
  }
  const counts = ['attempted', ...outcomes];
  return { scenarios, discardResponseBodies: true, summaryTrendStats: ['p(95)', 'p(99)'], systemTags: ['scenario', 'status', 'name'],
    thresholds: Object.fromEntries([
      ...Object.keys(scenarios).map(name => [`dropped_iterations{scenario:${name}}`, ['count>=0']]),
      ...[...lanes].flatMap(lane => [
        ...counts.map(name => [`move_${name}{scenario:${lane}}`, ['count>=0']]),
        [`move_success_ms{scenario:${lane}}`, ['max>=0']],
      ]),
      ...topicScenarios.map(name => [`move_topic_reads{scenario:${name}}`, ['count>=0']]),
    ]) };
}

test('unset and all read lanes serialize exactly the pre-#758 k6 options for every step', () => {
  for (const p of [plan(false), plan(true)]) {
    for (const step of steps(p)) {
      const expected = JSON.stringify(frozen(p, step));
      assert.equal(JSON.stringify(workloadOptions(p, step).options), expected);
      assert.equal(JSON.stringify(workloadOptions(p, step, 'all').options), expected);
    }
  }
});

test('channels and topics attribution runs remove exactly the other Part D read lane', () => {
  for (const p of [plan(false), plan(true)]) {
    for (const step of steps(p).filter(s => s.part === 'D')) {
      const all = workloadOptions(p, step).options;
      const keys = (options: typeof all) => Object.keys(options.scenarios!);
      const topicNames = Array.from({ length: p.topicReaders }, (_, i) => `topic${i}`);
      const channels = workloadOptions(p, step, 'channels');
      const topics = workloadOptions(p, step, 'topics');
      assert.deepEqual(keys(channels.options), keys(all).filter(name => !topicNames.includes(name)));
      assert.deepEqual(keys(topics.options), keys(all).filter(name => name !== 'channels'));
      assert.deepEqual([...channels.lanes].includes('topics'), false);
      assert.deepEqual([...topics.lanes].includes('channels'), false);
      assert.deepEqual(channels.topicScenarios, []);
      for (const options of [channels.options, topics.options]) {
        for (const name of keys(options)) assert.deepEqual(options.scenarios![name], all.scenarios![name]);
        assert.ok(Object.keys(options.thresholds!).every(key => key in all.thresholds!));
      }
      assert.ok(!Object.keys(channels.options.thresholds!).some(key => /topic|scenario:topics/.test(key)));
      assert.ok(!Object.keys(topics.options.thresholds!).some(key => /scenario:channels/.test(key)));
    }
    const formal = steps(p).find(s => s.part === 'B')!;
    for (const readLanes of ['channels', 'topics'])
      assert.equal(JSON.stringify(workloadOptions(p, formal, readLanes).options), JSON.stringify(frozen(p, formal)));
  }
});

test('D0 full-rate rehearsal keeps the exact arrival schedules in both arms', () => {
  const p = rehearsalPlan();
  for (const [size, moveTimeUnit] of [[100, '1s'], [1000, '5s']] as const) {
    for (const arm of ['baseline', 'move'] as const) {
      const step: Step = { part: 'D', size, round: 1, arm };
      const scenarios = workloadOptions(p, step, 'channels').options.scenarios!;
      const expected = { reader: [2, '1s', '31s'], send: [250, '1s', '20s'], channels: [500, '1s', '20s'],
        ...(arm === 'move' && { move: [1, moveTimeUnit, '20s'] }) };
      assert.deepEqual(Object.keys(scenarios).sort(), Object.keys(expected).sort());
      for (const [name, values] of Object.entries(expected)) {
        const scenario = scenarios[name];
        assert.equal(scenario.executor, 'constant-arrival-rate');
        assert.equal(scenario.gracefulStop, '11s');
        assert.deepEqual([scenario.rate, scenario.timeUnit, scenario.duration], values);
      }
    }
  }
});
