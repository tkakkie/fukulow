import assert from 'node:assert/strict';
import test from 'node:test';
import { revokeSessions } from './sessions.ts';

test('sign-out attempts every session and reports all failures without credentials', () => {
  const attempted: string[] = [];
  assert.throws(() => revokeSessions(['secret-a', 'secret-b', 'secret-c', 'secret-d'], (token) => {
    attempted.push(token);
    if (token === 'secret-a' || token === 'secret-c') throw new Error(token);
  }), { message: 'Session sign-out failed for 2 session(s): 1, 3' });
  assert.deepEqual(attempted, ['secret-a', 'secret-b', 'secret-c', 'secret-d']);
});

test('sign-out succeeds for all sessions or an empty setup', () => {
  const attempted: string[] = [];
  revokeSessions(['a', 'b'], (token) => { attempted.push(token); });
  revokeSessions([], () => { assert.fail('no sessions to revoke'); });
  assert.deepEqual(attempted, ['a', 'b']);
});
