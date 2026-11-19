import assert from 'node:assert/strict';
import test from 'node:test';
import { infrastructureFailure, judge, laneProblems, limitDecision, type Measurement, type Result, type Verdict } from './judge.ts';
import { formalSizes, plan, steps, moveLimits, moveInterval, tombstones, type Arm, type Cell, type Part } from './plan.ts';
import type { Lane } from './metrics.ts';
import { canRerun, checkImageRevision } from './run.ts';

const formal = plan(false);
function lane(attempted: number, p95 = 10, p99 = 20, accepted = attempted): Lane {
  return { attempted, accepted, droppedIterations: 0, otherErrors: attempted - accepted,
    rejected429: 0, rejected503: 0, clientTimeouts: 0, transportErrors: 0, p95, p99 };
}

function results(p = formal): Result[] {
  return steps(p).map(step => {
    const { part, size, arm } = step;
    const active = arm === 'move';
    const evidence = { samples: 10, maxSampleGapMs: 1000, samplingErrors: 0 };
    const readerTarget = part === 'A' || part === 'F' ? 4 : p.readerRate * ((part === 'E' ? p.replaySeconds : p.seconds) + p.drain);
    const m: Measurement = { lanes: { reader: lane(readerTarget) }, evidence, readerTarget };
    if (part === 'A' || part === 'F') m.lanes[active ? 'move' : 'create'] = lane(p.moves);
    else if (part === 'E') m.lanes.replay = lane(p.topicReaders * p.replayPerReader);
    else {
      m.lanes.send = lane(p.sendRate * p.seconds);
      if (active) m.lanes.move = lane(p.seconds / moveInterval(size));
      if (part === 'D') {
        m.lanes.channels = lane(p.channelRate * p.seconds);
        m.lanes.topics = lane(20 * p.topicReaders);
        m.topicReaders = Array.from({ length: p.topicReaders }, () => 20);
      }
    }
    if (active && part !== 'E') m.moveVerified = true;
    if (part === 'F') m.wal = { lsnBytes: p.moves * 100 * (active ? size : 1), messagesDelta: active ? 0 : p.moves,
      relationBytesDelta: 0, autovacuumInside: [], checkpointsInside: 0, statsReset: false };
    return { ...step, attempts: [{ measurement: m }] };
  });
}

const selected = (v: ReturnType<typeof judge>, part: Part, size: number) => v.rows.find(row => row.part === part && row.size === size)!;
function status(r: Result[], part: Part, size: number) {
  return selected(judge(formal, r, true), part, size).status;
}
function step(r: Result[], part: Part, size: number, arm: Arm = 'move', round = 1) {
  return r.find(row => row.part === part && row.size === size && row.arm === arm && row.round === round)!;
}
const measurement = (r: Result[], part: Part, size: number, arm?: Arm, round?: number) => step(r, part, size, arm, round).attempts[0].measurement!;

test('formal fixture dimensions, Move frequencies, and three alternating rounds are fixed', () => {
  assert.equal(formal.members, 4000);
  assert.equal(formal.channels, 200);
  assert.deepEqual(formal.sizes, [1, 10, 100, 1000]);
  assert.deepEqual(formal.sizes.map(tombstones), [0, 0, 1, 10]);
  assert.equal(formal.moves, 30);
  assert.equal(formal.sendRate, 250);
  assert.equal(formal.channelRate, 500);
  assert.equal(formal.readerRate, 2);
  assert.equal(formal.topicReaders, 4);
  assert.equal(formal.topicLimit, 50);
  assert.equal(formal.replayPage, 50);
  assert.deepEqual([100, 1000].map(moveInterval), [1, 5]);
  assert.deepEqual(steps(formal).filter(s => s.part === 'B' && s.size === 100).map(s => [s.round, s.arm]), [
    [1, 'baseline'], [1, 'move'], [2, 'move'], [2, 'baseline'], [3, 'baseline'], [3, 'move'],
  ]);
});

test('all three rounds are required and smoke and incomplete runs cannot pass', () => {
  assert.equal(judge(formal, results(), true).overall, 'PASS');
  const missing = results().filter(s => s.part !== 'A' || s.round !== 3);
  assert.equal(status(missing, 'A', 1000), 'NOT EVALUATED');
  assert.equal(status(missing, 'B', 1000), 'NOT EVALUATED');
  assert.equal(judge(formal, results(), false).overall, 'NOT EVALUATED');
  const smoke = plan(true);
  for (const part of ['A', 'B', 'C', 'D', 'E', 'F']) {
    const rows = steps(smoke).filter(s => s.part === part);
    assert.deepEqual([...new Set(rows.map(s => [s.round, s.size].join('/')))], ['1/2']);
  }
  const measured = judge(smoke, results(smoke), true);
  assert.equal(measured.overall, 'NOT EVALUATED');
  assert.equal(measured.functional, 'PASS');
  assert.equal(measured.limit.status, 'NOT EVALUATED');
});

test('any drops invalidate the step and the offered-work floor is inclusive at 95%', () => {
  assert.deepEqual(laneProblems('send', lane(95), 100), []);
  assert.match(laneProblems('send', lane(94), 100).join(), /offered load/);
  assert.deepEqual(laneProblems('send', lane(101), 100), []);
  assert.match(laneProblems('send', lane(102), 100).join(), /offered load/);
  for (const name of ['send', 'reader', 'move'] as const) {
    const r = results();
    measurement(r, 'B', 100).lanes[name]!.droppedIterations = 1;
    assert.equal(status(r, 'B', 100), 'INVALID');
  }
});

test('incomplete outcomes, send rate limiting, and missing latency invalidate evidence', () => {
  const r = results();
  const m = measurement(r, 'B', 100, 'baseline');
  const send = m.lanes.send!;
  send.accepted--;
  assert.equal(status(r, 'B', 100), 'INVALID');
  send.rejected429++;
  assert.equal(status(r, 'B', 100), 'INVALID');
  send.rejected429--;
  send.otherErrors++;
  send.p99 = null;
  assert.equal(status(r, 'B', 100), 'INVALID');
  send.p99 = 20;
  delete m.lanes.send;
  assert.equal(status(r, 'B', 100), 'INVALID');
});

test('missing resource samples, sampling errors and gaps over 2.5 seconds are INVALID', () => {
  const r = results(), m = measurement(r, 'B', 100);
  m.evidence = { samples: 2, maxSampleGapMs: 2500, samplingErrors: 0 };
  assert.equal(status(r, 'B', 100), 'PASS');
  m.evidence.maxSampleGapMs++;
  assert.equal(status(r, 'B', 100), 'INVALID');
  m.evidence.maxSampleGapMs = 1000;
  m.evidence.samplingErrors = 1;
  assert.equal(status(r, 'B', 100), 'INVALID');
  m.evidence.samplingErrors = 0;
  m.evidence.samples = 0;
  assert.equal(status(r, 'B', 100), 'INVALID');
  delete m.evidence;
  assert.equal(status(r, 'B', 100), 'INVALID');
});

test('never-started reader invalidates every part even with zero reported drops', () => {
  for (const part of ['A', 'B', 'C', 'D', 'E', 'F'] as const) {
    const r = results();
    measurement(r, part, 100).lanes.reader = lane(0, 0, 0);
    const row = selected(judge(formal, r, true), part, 100);
    assert.equal(row.status, 'INVALID');
    assert.match(row.rounds[0].reasons.join(), /reader: never started/);
  }
  const r = results(), m = measurement(r, 'A', 100);
  delete m.readerTarget;
  assert.equal(status(r, 'A', 100), 'INVALID');
});

test('a second-Organization reader 5xx makes the round FAIL', () => {
  const r = results();
  const reader = measurement(r, 'B', 100, 'baseline', 2).lanes.reader!;
  reader.accepted--;
  reader.rejected503++;
  const row = selected(judge(formal, r, true), 'B', 100);
  assert.equal(row.rounds[1].status, 'FAIL');
  assert.match(row.rounds[1].reasons.join(), /second-Organization reader errors/);
  assert.equal(row.status, 'FAIL');
});

test('A allows each exact p95 limit and requires all 30 position and version checks', () => {
  for (const size of formalSizes) {
    const r = results();
    const m = measurement(r, 'A', size, 'move', 3);
    m.lanes.move = lane(30, moveLimits[size], moveLimits[size] + 2);
    assert.equal(status(r, 'A', size), 'PASS');
    m.lanes.move.p95! += 0.001;
    assert.equal(status(r, 'A', size), 'FAIL');
    m.lanes.move.p95 = moveLimits[size];
    m.moveVerified = false;
    assert.equal(status(r, 'A', size), 'FAIL');
    delete m.moveVerified;
    assert.equal(status(r, 'A', size), 'INVALID');
    m.moveVerified = true;
    m.lanes.move = lane(29);
    assert.equal(status(r, 'A', size), 'INVALID');
  }
});

test('B enforces exactly 99% acceptance in the Move arm on both chain sizes', () => {
  for (const size of [100, 1000]) {
    const r = results(), m = measurement(r, 'B', size);
    measurement(r, 'B', size, 'baseline').lanes.send = lane(15_000, 10, 20, 14_849);
    m.lanes.send = lane(15_000, 10, 20, 14_850);
    assert.equal(status(r, 'B', size), 'PASS');
    m.lanes.send = lane(15_000, 10, 20, 14_849);
    assert.equal(status(r, 'B', size), 'FAIL');
  }
});

test('B uses the 110% p95 limit for 100, and same-round A p95 added to baseline p99 for 1,000', () => {
  const r = results(), send100 = measurement(r, 'B', 100).lanes.send!;
  send100.p95 = 11;
  send100.p99 = 1000;
  assert.equal(status(r, 'B', 100), 'PASS');
  send100.p95 += 0.001;
  assert.equal(status(r, 'B', 100), 'FAIL');
  measurement(r, 'A', 1000, 'move', 2).lanes.move = lane(30, 500, 510);
  const send1000 = measurement(r, 'B', 1000, 'move', 2).lanes.send!;
  send1000.p95 = 100;
  send1000.p99 = 520;
  assert.equal(status(r, 'B', 1000), 'PASS');
  send1000.p99 += 0.001;
  assert.equal(status(r, 'B', 1000), 'FAIL');
  send1000.p99 = 520;
  measurement(r, 'A', 1000, 'move', 2).lanes.move!.p95 = null;
  assert.equal(status(r, 'B', 1000), 'NOT EVALUATED');
});

test('B-1000 allows exactly the lower of same-round A p95 and 500 ms above baseline p99', () => {
  for (const [aP95, limit] of [[50, 70], [2000, 520]]) {
    const r = results();
    measurement(r, 'A', 1000, 'move', 2).lanes.move = lane(30, aP95, aP95);
    const send = measurement(r, 'B', 1000, 'move', 2).lanes.send!;
    send.p99 = limit;
    assert.equal(status(r, 'B', 1000), 'PASS');
    send.p99 += 0.001;
    assert.equal(status(r, 'B', 1000), 'FAIL');
  }
});

test('B-1000 is NOT EVALUATED when same-round A-1000 is INVALID with a p95', () => {
  const r = results();
  measurement(r, 'A', 1000, 'move', 2).lanes.move!.droppedIterations = 1;
  const verdict = judge(formal, r, true);
  assert.equal(selected(verdict, 'A', 1000).rounds[1].status, 'INVALID');
  const b = selected(verdict, 'B', 1000);
  assert.equal(b.rounds[1].status, 'NOT EVALUATED');
  assert.equal(b.status, 'NOT EVALUATED');
});

test('C requires at least 99% send acceptance in each arm in every round', () => {
  for (const size of [100, 1000]) {
    for (const arm of ['baseline', 'move'] as const) {
      for (let round = 1; round <= formal.rounds; round++) {
        const r = results();
        const m = measurement(r, 'C', size, arm, round);
        m.lanes.send = lane(15_000, 10, 20, 14_850);
        assert.equal(status(r, 'C', size), 'PASS', `${size}, ${arm}, round ${round}`);
        m.lanes.send = lane(15_000, 10, 20, 14_849);
        assert.equal(status(r, 'C', size), 'FAIL', `${size}, ${arm}, round ${round}`);
      }
    }
  }
});

test('D requires at least 99% Channel-list acceptance in each arm in every round', () => {
  for (const size of [100, 1000]) {
    for (const arm of ['baseline', 'move'] as const) {
      for (let round = 1; round <= formal.rounds; round++) {
        const r = results();
        const m = measurement(r, 'D', size, arm, round);
        m.lanes.channels = lane(30_000, 10, 20, 29_700);
        assert.equal(status(r, 'D', size), 'PASS', `${size}, ${arm}, round ${round}`);
        m.lanes.channels = lane(30_000, 10, 20, 29_699);
        assert.equal(status(r, 'D', size), 'FAIL', `${size}, ${arm}, round ${round}`);
      }
    }
  }
});

test('C checks both inclusive 110% send latency ratios', () => {
  for (const size of [100, 1000]) {
    for (const metric of ['p95', 'p99'] as const) {
      const r = results(), m = measurement(r, 'C', size);
      m.lanes.send = lane(15_000, 11, 22);
      assert.equal(status(r, 'C', size), 'PASS');
      m.lanes.send[metric]! += 0.001;
      assert.equal(status(r, 'C', size), 'FAIL');
    }
  }
});

test('D checks Channel-list 110%, Topic-list 100 ms and samples from all four readers', () => {
  const r = results(), m = measurement(r, 'D', 100);
  m.lanes.channels!.p95 = 11;
  m.lanes.topics = lane(80, 100, 110);
  assert.equal(status(r, 'D', 100), 'PASS');
  m.lanes.channels!.p95! += 0.001;
  assert.equal(status(r, 'D', 100), 'FAIL');
  m.lanes.channels!.p95 = 11;
  m.lanes.topics.p95! += 0.001;
  assert.equal(status(r, 'D', 100), 'FAIL');
  m.lanes.topics.p95 = 100;
  m.topicReaders = [0, 30, 25, 25];
  assert.equal(status(r, 'D', 100), 'INVALID');
});

test('E checks the inclusive relative and absolute limits and needs every validated replay sample', () => {
  const r = results(), live = measurement(r, 'E', 100), control = measurement(r, 'E', 100, 'baseline');
  control.lanes.replay = lane(100, 90, 110);
  live.lanes.replay = lane(100, 99, 110);
  assert.equal(status(r, 'E', 100), 'PASS');
  live.lanes.replay.p95 = 99.001;
  assert.equal(status(r, 'E', 100), 'FAIL');
  control.lanes.replay.p95 = 100;
  live.lanes.replay.p95 = 100;
  assert.equal(status(r, 'E', 100), 'PASS');
  live.lanes.replay.p95 += 0.001;
  assert.equal(status(r, 'E', 100), 'FAIL');
  live.lanes.replay = lane(99, 99, 110);
  assert.equal(status(r, 'E', 100), 'INVALID');
  live.lanes.replay = lane(100, 99, 110, 99);
  assert.equal(status(r, 'E', 100), 'FAIL');
});

test('F checks the inclusive 2x WAL limit, missing WAL, and additional Message rows', () => {
  const r = results(), m = measurement(r, 'F', 1000);
  m.wal!.lsnBytes = 2 * 100 * formal.moves * 1000;
  m.wal!.relationBytesDelta = 1_000_000_000;
  assert.equal(status(r, 'F', 1000), 'PASS');
  m.wal!.lsnBytes++;
  assert.equal(status(r, 'F', 1000), 'FAIL');
  m.wal!.lsnBytes--;
  m.wal!.messagesDelta = 1;
  assert.equal(status(r, 'F', 1000), 'FAIL');
  m.wal!.messagesDelta = 0;
  m.wal!.checkpointsInside = 1;
  assert.equal(status(r, 'F', 1000), 'INVALID');
  m.wal!.checkpointsInside = 0;
  m.wal!.autovacuumInside = ['public.messages'];
  assert.equal(status(r, 'F', 1000), 'INVALID');
  m.wal!.autovacuumInside = [];
  m.wal!.statsReset = true;
  assert.equal(status(r, 'F', 1000), 'INVALID');
  delete m.wal;
  assert.equal(status(r, 'F', 1000), 'INVALID');
});

test('1,000 is kept on A and B alone, otherwise report the largest fully passing eligible size', () => {
  const row = (part: Part, size: number, status: Verdict['status'] = 'PASS'): Cell & Verdict => ({ part, size, status, reasons: [] });
  const at = (size: number) => (['A', 'B', 'C', 'D', 'E', 'F'] as const).map(part => row(part, size));
  assert.deepEqual(limitDecision([row('A', 1000), row('B', 1000), ...at(1500)]), { status: 'kept', size: 1000 });
  const failing = [row('A', 1000, 'FAIL'), row('B', 1000)];
  assert.deepEqual(limitDecision([...failing, ...at(100), ...at(500), ...at(1500)]), { status: 'largest passing size', size: 500 });
  const partial = at(500).map(r => r.part === 'E' ? { ...r, status: 'INVALID' as const } : r);
  assert.deepEqual(limitDecision([...failing, ...at(100), ...partial]), { status: 'largest passing size', size: 100 });
  assert.equal(limitDecision([...failing, ...partial, ...at(10)]).status, 'no eligible passing size');
  assert.equal(limitDecision([row('A', 1000, 'INVALID'), row('B', 1000), ...at(100)]).status, 'NOT EVALUATED');
});

test('only one confirmed infrastructure rerun is accepted and smoke never reruns', () => {
  const r = results(), row = step(r, 'A', 1000);
  const infra = { infrastructure: infrastructureFailure, problem: 'command failed' } as const;
  assert.equal(canRerun(infra, false, false, false), true);
  assert.equal(canRerun(infra, true, false, false), false);
  assert.equal(canRerun(infra, false, true, false), false);
  assert.equal(canRerun(infra, false, false, true), false);
  assert.equal(canRerun({ problem: 'dropped iteration' }, false, false, false), false);
  row.attempts.unshift({ problem: 'threshold failed' });
  assert.equal(status(r, 'A', 1000), 'INVALID');
  row.attempts[0] = infra;
  assert.equal(status(r, 'A', 1000), 'PASS');
  step(r, 'A', 100).attempts.unshift(infra);
  assert.equal(status(r, 'A', 1000), 'INVALID');
});

test('full image revision must equal the requested commit', () => {
  const commit = 'a'.repeat(40);
  assert.doesNotThrow(() => checkImageRevision(commit, commit));
  assert.throws(() => checkImageRevision(commit, 'b'.repeat(40)), /does not equal/);
  assert.throws(() => checkImageRevision(commit, ''), /does not equal/);
  assert.throws(() => checkImageRevision(commit.slice(0, 7), commit), /full commit SHA/);
});
