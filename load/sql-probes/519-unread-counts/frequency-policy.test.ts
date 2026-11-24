import assert from 'node:assert/strict';
import test from 'node:test';
import { withCap } from './frequency-policy.ts';
import { frozenFloors } from './frequency-approval.ts';

for (const fault of ['workload error', 'interruption', 'partial cap write', 'restore write error'] as const) {
  test(`control verifies restoration of every saved policy after ${fault}`, async () => {
    const saved = Object.fromEntries(Array.from({ length: 16 }, (_, cpu) => [`policy${cpu}`, String(2_000_000 + cpu)]));
    const capped = Object.fromEntries(Object.keys(saved).map(p => [p, '1700000']));
    const live = { ...saved };
    let pending = false;
    const events: string[] = [];
    const io = {
      async write(values: typeof saved) {
        const restore = values === saved;
        assert.equal(pending, true);
        events.push(restore ? 'restore' : 'cap');
        if (!restore && fault === 'partial cap write') {
          live.policy0 = values.policy0;
          throw new Error(fault);
        }
        Object.assign(live, values);
        if (restore && fault === 'restore write error') throw new Error(fault);
      },
      verify(values: typeof saved) {
        events.push(values === saved ? 'verify restored' : 'verify capped');
        assert.deepEqual(live, values === saved ? saved : capped);
      },
      pending(values: typeof saved) { assert.deepEqual(values, saved); pending = true; },
      restored() { pending = false; },
    };
    const signal = new AbortController();
    await assert.rejects(withCap(saved, async () => {
      assert.deepEqual(live, capped);
      if (fault === 'interruption') { signal.abort(new Error(fault)); signal.signal.throwIfAborted(); }
      if (fault === 'workload error') throw new Error(fault);
    }, io), new RegExp(fault));
    assert.deepEqual(events.slice(-2), ['restore', 'verify restored']);
    assert.deepEqual(live, saved);
    assert.equal(pending, fault === 'restore write error');
  });
}

test('missing frozen floors and the reviewed Rehearsal 2 approval STOP formal use', () => {
  assert.throws(() => frozenFloors(new URL('no-floors.fixture.json', import.meta.url)), /STOP: formal #796 requires frozen block-1 floors/);
});
