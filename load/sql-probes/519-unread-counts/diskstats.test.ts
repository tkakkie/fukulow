import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diskDelta, parseDiskstats } from './diskstats.ts';

test('diskstats selects by major:minor and gives each requested field its kernel column', () => {
  const text = '  8 0 sda 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17\n' +
    '  259 2 nvme0n1p2 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37\n';
  const [row] = parseDiskstats(text, ['259:2']);
  assert.deepEqual(row, { id: '259:2', name: 'nvme0n1p2', readsCompleted: 21, writesCompleted: 25, sectorsWritten: 27,
    msWriting: 28, ioTicks: 30, weightedMsInQueue: 31, flushesCompleted: 36, msFlushing: 37 });
  assert.throws(() => parseDiskstats(text, ['259:3']), /259:3 missing/);
});

test('pre-flush kernels retain nulls in both snapshots and deltas', () => {
  for (const discardFields of ['', ' 0 0 0 0']) {
    const [start] = parseDiskstats('8 0 sda 1 0 0 0 4 0 8 2 0 3 4' + discardFields, ['8:0']);
    const [end] = parseDiskstats('8 0 sda 3 0 0 0 8 0 16 6 0 8 11' + discardFields, ['8:0']);
    assert.deepEqual(diskDelta(start, end), { id: '8:0', name: 'sda', readsCompleted: 2, writesCompleted: 4, sectorsWritten: 8,
      msWriting: 4, ioTicks: 5, weightedMsInQueue: 7, flushesCompleted: null, msFlushing: null });
  }
});

test('diskstats rejects partial flush fields, resets and device changes', () => {
  const line = '8 0 sda 1 0 0 0 4 0 8 2 0 3 4 0 0 0 0';
  assert.throws(() => parseDiskstats(line + ' 2', ['8:0']), /invalid .* row/);
  const [start] = parseDiskstats(line + ' 1 2', ['8:0']);
  const [end] = parseDiskstats(line + ' 2 5', ['8:0']);
  assert.equal(diskDelta(start, end).flushesCompleted, 1);
  assert.equal(diskDelta(start, end).msFlushing, 3);
  assert.throws(() => diskDelta(end, start), /msFlushing|flushesCompleted/);
  assert.throws(() => diskDelta(start, { ...end, name: 'sdb' }), /identity changed/);
});
