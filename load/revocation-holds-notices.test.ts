import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelId, holdsFence, holdsFixture } from './revocation-holds-fixture.ts';
import { noticeCorrectness } from './revocation-holds-notices.ts';

test('several send records per Channel match client notices by count', () => {
  const run = holdsFixture();
  assert.deepEqual(noticeCorrectness(run).reasons, []);
  assert.equal(noticeCorrectness(run).details.serverSends[channelId(3)], 32);
  const lost = holdsFixture(); // a notice lost on both sides is allowed (spec O5)
  lost.notices = lost.notices.filter(n => !(n.socket === 4 && n.channelId === channelId(3)));
  lost.sendTiming!.records.pop();
  assert.equal(lost.sendTiming!.records.filter(r => r.channelId === channelId(15)).length, 31);
  assert.ok(noticeCorrectness(lost).reasons.includes('2 Channels whose server send count differs from the client notice count'));
  lost.sendTiming!.records = lost.notices.map(n => ({ channelId: n.channelId!, beforeMs: 44_000, afterMs: 44_002 }));
  assert.deepEqual(noticeCorrectness(lost).reasons, []);
  const extra = holdsFixture(); extra.sendTiming!.records.push({ channelId: channelId(0), beforeMs: 44_000, afterMs: 44_002 });
  assert.deepEqual(noticeCorrectness(extra).details.mismatched, [channelId(0)]);
});

test('duplicates are per (socket, Channel), not per Channel', () => {
  const run = holdsFixture();
  run.notices.push({ socket: 1, channelId: channelId(0), at: 44_500 });
  run.sendTiming!.records.push({ channelId: channelId(0), beforeMs: 44_000, afterMs: 44_002 });
  assert.deepEqual(noticeCorrectness(run).reasons, ['duplicate revocation on a (socket, Channel)']);
});

test('wrong, early and restored-registration notices fail', () => {
  const wrong = holdsFixture(); wrong.notices[0].channelId = 'stall';
  assert.ok(noticeCorrectness(wrong).reasons.includes('a revocation reached a bystander or a Channel that was not revoked'));
  const bystander = holdsFixture(); bystander.bystanderNotices = 1;
  assert.ok(noticeCorrectness(bystander).reasons.includes('a revocation reached a bystander or a Channel that was not revoked'));
  const record = holdsFixture(); record.sendTiming!.records.push({ channelId: 'stall', beforeMs: 44_000, afterMs: 44_000 });
  assert.ok(noticeCorrectness(record).reasons.includes('a revocation send record names a Channel that was not revoked'));
  const early = holdsFixture(); early.notices[0].at = 36_999;
  assert.ok(noticeCorrectness(early).reasons.includes('a revocation arrived before its revoke started'));
  const onTime = holdsFixture(); onTime.notices[0].at = 37_000;
  assert.deepEqual(noticeCorrectness(onTime).reasons, []);
  const fence = holdsFence();
  fence.notices = [{ socket: 40, channelId: channelId(1), at: 42_049 }, { socket: 0, channelId: channelId(1), at: 50_000 }];
  fence.sendTiming!.records = [{ channelId: channelId(1), beforeMs: 39_000, afterMs: 39_000 }, { channelId: channelId(1), beforeMs: 45_000, afterMs: 45_000 }];
  assert.deepEqual(noticeCorrectness(fence).reasons, []);
  fence.notices[0].at = 42_050;
  assert.deepEqual(noticeCorrectness(fence).reasons, ['a restored registration received a revocation']);
});
