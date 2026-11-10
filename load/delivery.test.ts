import assert from 'node:assert/strict';
import test from 'node:test';
import { Deliveries, positiveInteger } from './delivery.ts';

test('delivery latency starts before HTTP and waits for every subscriber', () => {
  const deliveries = new Deliveries();
  deliveries.start('first', 100, 2);
  deliveries.start('second', 110, 2);
  assert.equal(deliveries.receive('second', 120), 10);
  assert.equal(deliveries.receive('first', 125), 25);
  assert.equal(deliveries.missing, 2);
  assert.equal(deliveries.receive('first', 130), 30);
  assert.equal(deliveries.receive('second', 140), 30);
  assert.equal(deliveries.missing, 0);
  assert.throws(() => deliveries.receive('first', 150));
  assert.throws(() => deliveries.receive('unknown', 150));
});

test('missing deliveries include a message no subscriber received', () => {
  const deliveries = new Deliveries();
  deliveries.start('unseen', 100, 5);
  deliveries.start('partial', 110, 5);
  deliveries.receive('partial', 120);
  assert.equal(deliveries.missing, 9);
});

test('invalid load settings fail instead of silently disabling traffic', () => {
  assert.equal(positiveInteger(undefined, 5), 5);
  assert.equal(positiveInteger('10000', 5), 10000);
  for (const value of ['0', '-1', '1.5', 'NaN', '', '1s', 'Infinity', '9007199254740992']) {
    assert.throws(() => positiveInteger(value, 5));
  }
});

test('refused sends do not count as missing deliveries', () => {
  const deliveries = new Deliveries();
  deliveries.start('refused', 100, 5);
  deliveries.start('accepted', 100, 2);
  deliveries.cancel('refused');
  assert.equal(deliveries.missing, 2);
});
