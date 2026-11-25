import assert from 'node:assert/strict';
import test from 'node:test';
import { turbostatArgv } from './frequency-spot-check.ts';

test('turbostat argv has no whitespace inside an element, so sudo-rs can match the scoped sudoers entry', () => {
  for (const arg of turbostatArgv) assert.doesNotMatch(arg, /\s/, arg);
  assert.deepEqual(turbostatArgv.slice(-2), ['--', '/usr/bin/cat']);
});
