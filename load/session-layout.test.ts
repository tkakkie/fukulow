import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionLayout } from './session-layout.ts';

test('light defaults keep five Owner sessions, one per socket, and publish with the first', () => {
  const layout = sessionLayout(1 * 5, 1, 0, 1);
  assert.equal(layout.accounts, 1);
  assert.equal(layout.ownerSessions, 5);
  assert.equal(layout.socketSessions, 5);
  assert.equal(layout.sessionsToProvision, 5);
  assert.deepEqual([0, 1, 2, 3, 4].map(layout.socketTokenIndex), [0, 1, 2, 3, 4]);
  assert.equal(layout.publisherTokenIndex(0), 0);
});

test('publisher-only sessions follow the shared Owner socket sessions', () => {
  const layout = sessionLayout(5, 2, 0, 3);
  assert.equal(layout.accounts, 3);
  assert.equal(layout.socketAccounts, 1);
  assert.equal(layout.ownerSessions, 3);
  assert.equal(layout.socketSessions, 3);
  assert.equal(layout.sessionsToProvision, 5);
  assert.deepEqual([0, 1, 2, 3, 4].map(layout.socketTokenIndex), [0, 0, 1, 1, 2]);
  assert.deepEqual([0, 1, 2].map(layout.publisherTokenIndex), [0, 3, 4]);
});

test('one session per socket Account also serves its publishing Member', () => {
  for (const publishMembers of [2, 4]) {
    const layout = sessionLayout(5, 2, 2, publishMembers);
    assert.equal(layout.ownerSessions, 1);
    assert.equal(layout.socketAccounts, 3);
    assert.equal(layout.socketSessions, 3);
    assert.equal(layout.sessionsToProvision, publishMembers === 2 ? 3 : 4);
    assert.deepEqual([0, 1, 2, 3, 4].map(layout.socketTokenIndex), [0, 0, 1, 1, 2]);
    const members = Array.from({ length: publishMembers }, (_, i) => i);
    assert.deepEqual(members.map(layout.publisherTokenIndex), members);
  }
});

test('counts match the pre-extraction formulas in every mode', () => {
  for (const sockets of [1, 5, 7, 40]) for (const perSession of [1, 2, 5]) for (const perAccount of [0, perSession])
    for (const publishMembers of [1, 2, 8]) {
      const before = Math.ceil(sockets / perSession);
      const accounts = Math.max(perAccount ? before : 1, publishMembers);
      const layout = sessionLayout(sockets, perSession, perAccount, publishMembers);
      assert.deepEqual([layout.socketSessions, layout.accounts, layout.sessionsToProvision],
        [before, accounts, perAccount ? accounts : before + publishMembers - 1]);
    }
});
