import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNELS, holdsFixture, sample } from './revocation-holds-fixture.ts';

test('the fixture uses every revoked Channel on every target socket', () => {
  const run = holdsFixture();
  assert.equal(run.notices.length, 32 * CHANNELS.length);
  assert.equal(sample(0).highWaterMark, 0);
});
