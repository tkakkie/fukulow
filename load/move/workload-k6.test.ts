import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { Step } from './plan.ts';

export const check = () => true;
export const fail = (message: string): never => { throw new Error(message); };
export const randomBytes = (length: number) => new ArrayBuffer(length);
export class Counter {}
export class Trend {}
export class WebSocket {}
export class SharedArray {
  constructor(_name: string, load: () => unknown[]) { load(); }
}
export default {};

test('diagnostic summary uses the configured scenario names after k6 replaces scenarios', async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === 'k6' || specifier.startsWith('k6/')
        ? { url: import.meta.url, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const step: Step = { part: 'D', size: 100, round: 1, arm: 'move' };
  Object.assign(globalThis, {
    __ENV: { MOVE_STEP: JSON.stringify(step), MOVE_DIAGNOSTIC: '1', MOVE_REHEARSAL: '1' },
    open: (path: string) => path === '/fixture/tokens.json' ? '[]' : JSON.stringify({
      organization: 'org', channels: ['channel'], chain: { channel: 'channel', version: 1 },
    }),
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, '__ENV');
    Reflect.deleteProperty(globalThis, 'open');
  });

  const { handleSummary, options } = await import('./workload-k6.ts');
  Object.assign(options, { scenarios: {
    getFullExecutionRequirements() {},
    getSortedConfigs() {},
    unmarshalJSON() {},
    validate() {},
  } });
  const { stdout } = handleSummary({ metrics: {
    'dropped_iterations{scenario:reader}': { values: { count: 0 } },
    'dropped_iterations{scenario:send}': { values: { count: 15 } },
    'dropped_iterations{scenario:move}': { values: { count: 2 } },
    'dropped_iterations{scenario:channels}': { values: { count: 3 } },
    'dropped_iterations{scenario:topic0}': { values: { count: 4 } },
    'dropped_iterations{scenario:topic1}': { values: { count: 5 } },
    'dropped_iterations{scenario:topic2}': { values: { count: 6 } },
  } });
  assert.deepEqual(JSON.parse(stdout.slice('MOVE_RESULT '.length)).scenarioDrops,
    { reader: 0, send: 15, move: 2, channels: 3, topic0: 4, topic1: 5, topic2: 6, topic3: null });
});
