import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appEvidence, cgroupSample, dbEvidence, k6CeilingWarnings, k6Evidence, parseDbSample, parseStatements,
  readTimingProblems, requiredReadPhases, sendTimingProblems, statementGroup, statementGroupSql } from './diagnostic-evidence.ts';
import { attributionLabel, diagnosticCommit, diagnosticSelection, diagnosticTargets, readSampleEnvironment, remainingArmsSkipped,
  rejectDiagnosticImage } from './diagnostic-mode.ts';
import { judge } from './judge.ts';
import { plan, type Step } from './plan.ts';

test('diagnostic selection retains the formal Part D fixture and order for the chosen round', () => {
  const selection = diagnosticSelection({ diagnostic: true, sizes: '100,1000', round: '2' })!;
  assert.deepEqual(selection.plan, { ...plan(false), mode: 'DIAGNOSTIC' });
  assert.deepEqual(selection.steps.map(({ part, size, round, arm }) => [part, size, round, arm]),
    [['D', 100, 2, 'move'], ['D', 100, 2, 'baseline'], ['D', 1000, 2, 'move'], ['D', 1000, 2, 'baseline']]);
  assert.deepEqual(diagnosticSelection({ diagnostic: true })!.steps.map(s => [s.size, s.round, s.arm]),
    [[100, 1, 'baseline'], [100, 1, 'move']]);
  const smoke = diagnosticSelection({ diagnostic: true, smoke: true })!;
  assert.equal(smoke.plan.seconds, 3);
  assert.deepEqual(smoke.steps.map(s => [s.part, s.size, s.arm]), [['D', 2, 'baseline'], ['D', 2, 'move']]);
});

test('diagnostic options, image, plan and evidence cannot enter the formal judge path', () => {
  assert.equal(diagnosticSelection({ smoke: true }), undefined);
  assert.throws(() => diagnosticSelection({ sizes: '100' }), /require --diagnostic/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, sizes: '1' }), /Use --sizes/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, round: '4' }), /Use --sizes/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, smoke: true, round: '1' }), /fixed small fixture/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, image: 'test' }), /builds its own/);
  assert.throws(() => rejectDiagnosticImage('true'), /require --diagnostic/);
  assert.doesNotThrow(() => rejectDiagnosticImage(null));
  assert.throws(() => judge(diagnosticSelection({ diagnostic: true })!.plan, [], true), /refuses DIAGNOSTIC/);
  const step: Step = { part: 'D', arm: 'baseline', size: 100, round: 1 };
  const row = { ...step, attempts: [], mode: 'DIAGNOSTIC' };
  assert.throws(() => judge(plan(false), [row], true), /refuses DIAGNOSTIC/);
  const measurement = { mode: 'DIAGNOSTIC', lanes: {} };
  assert.throws(() => judge(plan(false), [{ ...step, attempts: [{ measurement }] }], true), /refuses DIAGNOSTIC/);
});

test('cgroup parser preserves zero throttles and treats missing memory as missing evidence', () => {
  const raw = 'usage_usec 789\nuser_usec 100\nnr_throttled 0\nthrottled_usec 0\nmemory.current 1024\n';
  assert.deepEqual(cgroupSample(raw), { usage_usec: 789, nr_throttled: 0, throttled_usec: 0, memoryBytes: 1024 });
  assert.equal(cgroupSample(raw.replace('memory.current', 'memory.peak')), null);
  assert.equal(cgroupSample(raw.replace('nr_throttled 0', 'nr_throttled -1')), null);
});

test('server parsing aggregates timing and 503 causes by lane and retains only allowed fields', () => {
  const event = (fields: object) => JSON.stringify({ timestamp: '2026-11-20T00:00:01Z', fields: { ...fields, unrelated: 'discard' } });
  const timing = (us: number, interrupted = false) =>
    event({ event: 'move_diag_timing', lane: 'send', phase: 'channel_admission_wait', us, interrupted });
  const app = appEvidence([timing(12), timing(5), timing(1000, true),
    event({ event: 'move_diag_503', lane: 'move', reason: 'channel_queue_full' }),
    event({ event: 'move_diag_503', lane: 'send', reason: 'limiter_pending_cap' }),
    event({ event: 'move_diag_503', lane: 'send', reason: 'not-a-known-reason' }),
    'unrelated line'].join('\n'));
  assert.deepEqual(app.byLane.send.phasesUs.channel_admission_wait, { count: 2, p50: 5, p95: 12, p99: 12, max: 12, interrupted: 1 });
  assert.equal(app.byLane.move.reasons.channel_queue_full, 1);
  assert.equal(app.byLane.send.reasons.limiter_pending_cap, 1);
  assert.equal(app.unavailable.length, 2);
  assert.doesNotMatch(JSON.stringify(app), /discard/);
});

const sendTiming = (request_id: number, phase: string, us: number, send_children?: number, interrupted = false) =>
  JSON.stringify({ timestamp: '2026-11-20T00:00:01Z',
    fields: { event: 'move_diag_timing', lane: 'send', phase, us, interrupted, request_id, send_children } });

test('send residuals pair interleaved requests and subtract each inclusive phase once', () => {
  const app = appEvidence([
    sendTiming(0, 'pool_acquire', 5), sendTiming(0, 'write_pool_acquire', 10),
    sendTiming(32, 'send_begin_sql', 15), sendTiming(0, 'send_access_channel_sql', 20),
    sendTiming(0, 'send_access_members_sql', 20), sendTiming(0, 'send_access_grants_sql', 10),
    sendTiming(0, 'send_access_sql', 70), sendTiming(32, 'send_message_insert_sql', 25),
    sendTiming(32, 'admitted_work', 200, 2), sendTiming(0, 'admitted_work', 100, 5),
    sendTiming(64, 'send_begin_sql', 20, undefined, true), sendTiming(64, 'admitted_work', 30, 0, true),
  ].join('\n'));
  assert.deepEqual(app.byLane.send.phasesUs.send_unattributed,
    { count: 2, p50: 20, p95: 160, p99: 160, max: 160, incomplete: 0, interrupted: 1 });
  assert.deepEqual(sendTimingProblems(app), []);
});

test('a missing send child is excluded and counted; more than 1% incomplete invalidates the evidence', () => {
  const app = appEvidence([
    sendTiming(0, 'send_access_sql', 70), sendTiming(0, 'admitted_work', 100, 2),
    sendTiming(32, 'send_begin_sql', 15), sendTiming(32, 'admitted_work', 150, 1),
  ].join('\n'));
  const residual = app.byLane.send.phasesUs.send_unattributed;
  assert.equal(residual.count, 1);
  assert.equal(residual.p50, 135);
  assert.equal(residual.incomplete, 1);
  assert.deepEqual(sendTimingProblems(app), ['send admitted-work breakdown']);
  assert.deepEqual(sendTimingProblems(appEvidence('')), ['send admitted-work breakdown']);
  const complete = Array.from({ length: 100 }, (_, i) => [sendTiming(i + 100, 'send_begin_sql', 15), sendTiming(i + 100, 'admitted_work', 150, 1)]).flat();
  const onePercent = appEvidence([...complete, sendTiming(0, 'send_access_sql', 70), sendTiming(0, 'admitted_work', 100, 2)].join('\n'));
  assert.equal(onePercent.byLane.send.phasesUs.send_unattributed.incomplete, 1);
  assert.deepEqual(sendTimingProblems(onePercent), []);
  const twoMissing = appEvidence([...complete, sendTiming(0, 'admitted_work', 100, 2), sendTiming(1, 'admitted_work', 100, 2)].join('\n'));
  assert.deepEqual(sendTimingProblems(twoMissing), ['send admitted-work breakdown']);
});

test('duplicate children, children longer than the parent and missing ids are incomplete', () => {
  const app = appEvidence([
    sendTiming(0, 'send_begin_sql', 10), sendTiming(0, 'send_begin_sql', 10), sendTiming(0, 'admitted_work', 100, 2),
    sendTiming(1, 'send_begin_sql', 150), sendTiming(1, 'admitted_work', 100, 1),
    sendTiming(2, 'send_begin_sql', 10),
    sendTiming(3, 'send_begin_sql', 10), sendTiming(3, 'admitted_work', 50, 1),
    JSON.stringify({ timestamp: '2026-11-20T00:00:01Z', fields: { event: 'move_diag_timing', lane: 'send', phase: 'send_begin_sql', us: 5, interrupted: false } }),
  ].join('\n'));
  const residual = app.byLane.send.phasesUs.send_unattributed;
  assert.equal(residual.count, 1);
  assert.equal(residual.p50, 40);
  assert.equal(residual.incomplete, 4);
});

test('every send hook in the diagnostic patch is included in the parser and child count', () => {
  const patch = readFileSync(new URL('./diagnostic-d655a3a.patch', import.meta.url), 'utf8');
  const added = patch.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n');
  const phases = [...added.matchAll(/::send_(?:timed|sync)\(\s*"(send_[a-z_]+)"/g)].map(match => match[1]);
  for (const phase of ['write_pool_acquire', 'send_access_sql', 'channel_advisory_sql', 'commit_sql']) assert.ok(patch.includes(`"${phase}"`), phase);
  assert.ok(phases.includes('send_search_terms_sql'));
  const app = appEvidence([
    ...phases.map(phase => sendTiming(0, phase, 1)), sendTiming(0, 'admitted_work', 100, phases.length),
  ].join('\n'));
  for (const phase of phases) assert.equal(app.byLane.send.phasesUs[phase]?.count, 1, phase);
  assert.deepEqual(sendTimingProblems(app), []);
});

test('k6 parser pairs VU gauges and uses full iterations to reconstruct write occupancy at drops', async () => {
  const point = (metric: string, sec: string, value: number, tags: object = {}) =>
    JSON.stringify({ type: 'Point', metric, data: { time: '2026-11-20T00:00:' + sec + 'Z', value, tags } });
  async function* lines() {
    yield point('iteration_duration', '02.500', 1000, { scenario: 'send' });
    yield point('dropped_iterations', '02.000001', 1, { scenario: 'send' });
    yield point('vus_max', '02', 800);
    yield point('vus', '02', 500);
    yield point('dropped_iterations', '02.500', 1, { scenario: 'send' });
    yield point('http_reqs', '02', 1, { scenario: 'move', status: '503', other: 'discard' });
    yield point('dropped_iterations', '03', 1, { scenario: 'topic0' });
    yield point('dropped_iterations', '03', 1, { scenario: 'unknown' });
  }
  const evidence = await k6Evidence(lines());
  assert.deepEqual(evidence.vus, [{ at: Date.parse('2026-11-20T00:00:02Z'), active: 500, allocated: 800 }]);
  assert.deepEqual(evidence.drops.map(d => [d.scenario, d.reconstructedWriteIterationsInFlight]), [['send', 1], ['send', 0], ['topic0', null]]);
  assert.equal(evidence.completed503.move, 1);
  assert.doesNotMatch(JSON.stringify(evidence), /discard/);
  assert.deepEqual(k6CeilingWarnings('time="2026-11-20T00:00:02Z" level=warning msg="Insufficient VUs, reached 2000 active VUs and cannot initialize more" executor=constant-arrival-rate scenario=send'),
    [{ scenario: 'send', at: Date.parse('2026-11-20T00:00:02Z'), maxVUs: 2000 }]);
});

test('PostgreSQL aggregation keeps query IDs precise and leaves sampling gaps unweighted', () => {
  const id = '-9223372036854775808';
  const waits = [{ id, type: 'Lock', event: 'advisory', count: 2 }, { id, type: 'IO', event: 'WALSync', count: 1 }];
  const sample = (at: number, rows = waits) => parseDbSample(JSON.stringify({ at, waits: rows }));
  const stats = parseStatements(JSON.stringify({ id, group: 'channel_advisory_write', calls: 3, execMs: 250, ignored: 'discard' }));
  const evidence = dbEvidence([sample(100), sample(200), sample(700, [])], stats);
  assert.equal(evidence.coveredMs, 100);
  assert.deepEqual(evidence.waits.map(row => [row.event, row.observations, row.estimatedBackendMs]), [['advisory', 4, 200], ['WALSync', 2, 100]]);
  assert.deepEqual(evidence.statements[0], { queryId: id, group: 'channel_advisory_write', calls: 3,
    execMs: 250, text: null, estimatedLockMs: 200, estimatedExecExcludingLockMs: 50 });
  assert.equal(dbEvidence([sample(100), sample(200)], [{ ...stats[0], execMs: 50 }]).statements[0].estimatedExecExcludingLockMs, null);
  assert.equal(dbEvidence([], stats).statements[0].estimatedExecExcludingLockMs, null);
  assert.throws(() => parseStatements(JSON.stringify({ id: 10, group: 'other', calls: 3, execMs: 4 })), /Invalid PostgreSQL statement/);
});

const mainCommit = 'd655a3ad2795530c4a18587b7c589e58180d6ffb';

test('diagnostic commit and read lanes are pinned choices recorded with the selection', () => {
  const pinned = diagnosticSelection({ diagnostic: true })!;
  assert.deepEqual([pinned.commit, pinned.patch, pinned.readTimingSampleEvery, pinned.readLanes],
    [diagnosticCommit, 'load/move/diagnostic.patch', null, 'all']);
  const main = diagnosticSelection({ diagnostic: true, commit: mainCommit, 'read-lanes': 'topics' })!;
  assert.deepEqual([main.commit, main.patch, main.readTimingSampleEvery, main.readLanes],
    [mainCommit, 'load/move/diagnostic-d655a3a.patch', 8, 'topics']);
  assert.equal(main.sendBreakdown, true);
  assert.equal(pinned.sendBreakdown, undefined);
  assert.deepEqual(main.steps, pinned.steps);
  assert.equal(diagnosticSelection({ diagnostic: true, smoke: true, commit: mainCommit })!.readTimingSampleEvery, 1);
  assert.equal(diagnosticSelection({ diagnostic: true, smoke: true })!.readTimingSampleEvery, null);
  assert.deepEqual(readSampleEnvironment(8), { FUKULOW_MOVE_DIAG_READ_EVERY: '8' });
  assert.equal(readSampleEnvironment(null), undefined);
  for (const invalid of [0, -1, 1.5, 1025, Number.NaN]) assert.throws(() => readSampleEnvironment(invalid), /Invalid DIAGNOSTIC read sample/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, commit: 'a'.repeat(40) }), /pinned Part D commit/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, commit: mainCommit.slice(0, 7) }), /pinned Part D commit/);
  assert.throws(() => diagnosticSelection({ diagnostic: true, 'read-lanes': 'reader' }), /--read-lanes all/);
  assert.throws(() => diagnosticSelection({ 'read-lanes': 'all' }), /require --diagnostic/);
  assert.equal(attributionLabel('all'), undefined);
  assert.match(attributionLabel('channels')!, /^ATTRIBUTION RUN .*channels only.*not the Part D Done-when load$/);
});

test('the main patch ports every hook of the pinned patch and adds the read-lane phases', () => {
  const hooks = (file: string) => new Set([...readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
    .split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n')
    .matchAll(/(?:timed|rejection)\(\s*"(\w+)"|Some\("(\w+)"\)|"(before_admission)"/g)].map(match => match[1] ?? match[2] ?? match[3]));
  const pinned = hooks(diagnosticTargets[diagnosticCommit].patch);
  const main = hooks(diagnosticTargets[mainCommit].patch);
  assert.ok(pinned.size >= 20);
  assert.deepEqual([...pinned].filter(hook => !main.has(hook)), []);
  for (const phase of ['topic_visible_scoped', 'topic_dm_check', 'topic_barrier', 'topic_page_tx', 'topic_page_sql',
    'channel_list_total', 'channel_visible_sql', 'channel_history_sql', 'channel_counts_sql', 'watermark_channel_timeout'])
    assert.ok(main.has(phase), phase);
});

const organizations = { partD: '00000000-0000-4000-8000-00000000000d', reader: '00000000-0000-4000-8000-00000000000e' };
const diagEvent = (fields: object) => JSON.stringify({ timestamp: '2026-11-20T00:00:01Z', fields });
const diagTiming = (lane: string, phase: string, us: number, organization = '', interrupted = false) =>
  diagEvent({ event: 'move_diag_timing', lane, organization, phase, us, interrupted });

test('server parsing keeps Part D read lanes apart from the write-lane 503 accounting', () => {
  const app = appEvidence([diagTiming('topics', 'topic_page_sql', 40), diagTiming('topics', 'topic_barrier', 7),
    diagTiming('topics', 'channel_advisory_sql', 3), diagTiming('channels', 'channel_counts_sql', 9, organizations.partD),
    diagTiming('channels', 'not_a_phase', 1, organizations.partD), diagTiming('reader', 'channel_list_total', 1),
    diagEvent({ event: 'move_diag_503', lane: 'topics', reason: 'watermark_channel_timeout' }),
    diagEvent({ event: 'move_diag_503', lane: 'send', reason: 'channel_queue_full' })].join('\n'), organizations);
  assert.equal(app.byLane.topics.phasesUs.topic_page_sql.p50, 40);
  assert.equal(app.byLane.topics.phasesUs.channel_advisory_sql.count, 1);
  assert.deepEqual(Object.keys(app.byLane.channels.phasesUs), ['channel_counts_sql']);
  assert.deepEqual(Object.keys(app.byLane.reader.phasesUs), []);
  assert.equal(app.byLane.topics.reasons.watermark_channel_timeout, 1);
  assert.equal(app.timing.length, 4);
  assert.deepEqual([app.unavailable.length, app.writeUnavailable], [2, 1]);
});

test('Channel-list events are attributed by Organization and never mix the reader into the Part D lane', () => {
  const app = appEvidence([diagTiming('channels', 'channel_list_total', 5, organizations.reader),
    diagTiming('channels', 'channel_list_total', 6, organizations.partD),
    diagTiming('channels', 'channel_list_total', 7), diagTiming('channels', 'channel_list_total', 8, 'not-a-fixture-org'),
    diagEvent({ event: 'move_diag_503', lane: 'channels', organization: organizations.reader, reason: 'unclassified' })].join('\n'), organizations);
  assert.deepEqual([app.byLane.channels.phasesUs.channel_list_total.max, app.byLane.reader.phasesUs.channel_list_total.max], [6, 5]);
  assert.equal(app.byLane.reader.reasons.unclassified, 1);
  assert.equal(app.timing.length, 2);
  assert.doesNotMatch(JSON.stringify(app), /0000-4000/);
  assert.equal(appEvidence(diagTiming('channels', 'channel_list_total', 6, organizations.partD)).timing.length, 0);
});

test('read-lane completeness requires finished samples for every phase of each enabled lane', () => {
  const lines = (lane: string, organization = '', interrupted = false, skip = '') =>
    requiredReadPhases[lane as keyof typeof requiredReadPhases].filter(phase => phase !== skip)
      .map(phase => diagTiming(lane, phase, 4, organization, interrupted));
  const complete = [...lines('channels', organizations.partD), ...lines('topics')];
  assert.deepEqual(readTimingProblems(appEvidence(complete.join('\n'), organizations).byLane, 'all'), []);
  const check = (log: string[], readLanes = 'all') => readTimingProblems(appEvidence(log.join('\n'), organizations).byLane, readLanes);
  assert.deepEqual(check([...lines('channels', organizations.partD), ...lines('topics', '', true)]),
    ['Topic-list timings (topic_visible_scoped, topic_dm_check, topic_barrier, topic_page_tx, topic_page_sql)']);
  assert.deepEqual(check([...lines('channels', organizations.partD, false, 'channel_counts_sql'), ...lines('topics')]),
    ['Channel-list timings (channel_counts_sql)']);
  assert.deepEqual(check([...lines('channels', organizations.reader), ...lines('topics')]),
    ['Channel-list timings (channel_list_total, channel_visible_sql, channel_history_sql, channel_counts_sql)']);
  assert.deepEqual(check(lines('topics'), 'topics'), []);
  assert.deepEqual(check(lines('channels', organizations.partD), 'channels'), []);
  assert.equal(check(lines('channels', organizations.partD), 'topics').length, 1);
  assert.equal(readTimingProblems(undefined, 'all').length, 2);
});

test('statement groups keep the write groups first and identify the Part D read statements', () => {
  assert.ok(statementGroupSql().startsWith(`CASE WHEN query LIKE '%pg_advisory_xact_lock_shared(%' THEN 'channel_advisory_read'
  WHEN query LIKE '%pg_advisory_xact_lock(%' THEN 'channel_advisory_write'
  WHEN query LIKE '%UPDATE messages SET topic_id=%' THEN 'move_update'
  WHEN query LIKE '%UNION ALL (SELECT id, reply_to_id, seq, version, sender, topic_id FROM messages%' THEN 'move_chain_lookup'
  WHEN query LIKE 'INSERT INTO messages %' THEN 'send_insert'
  WHEN query ~* 'FOR (NO KEY UPDATE|KEY SHARE|UPDATE|SHARE)' THEN 'row_lock_sql'
  WHEN `));
  assert.match(statementGroupSql(), / ELSE 'other' END$/);
  const cases: [string, string][] = [
    ['\nWITH unread_topics AS MATERIALIZED (\n    SELECT t.organization_id FROM topics t WHERE t.channel_id = ANY($4)\n) SELECT c.channel_id', 'channel_list_counts'],
    ["SELECT c.id FROM (x) u LEFT JOIN channels c ON c.organization_id = $2 AND (c.kind=$5 AND ($6::bool IS NULL OR (c.archived_at IS NOT NULL)=$6)) AND (v)", 'channel_list_visible'],
    ['SELECT visible FROM (SELECT u.id, u.membership_revision, EXISTS (SELECT $1 FROM channels c WHERE c.organization_id = $2', 'member_visibility'],
    ['SELECT s.account_id, u.id, u.name, u.role FROM account_sessions s LEFT JOIN users u ON true', 'auth_session'],
    ['SELECT history_generation FROM organizations WHERE organization_id=$1', 'organization_history'],
    ['WITH mention_page AS MATERIALIZED (\nWITH access AS MATERIALIZED (SELECT (v) AS visible),\npositions AS (SELECT 1 FROM messages m LEFT JOIN topic_read_positions tr ON true),\ncandidates AS (\n    SELECT * FROM positions)', 'topic_page'],
    ['WITH expired AS (SELECT id FROM invites), candidates AS (SELECT id FROM expired) DELETE FROM invites', 'other'],
    ['SELECT EXISTS (SELECT $3 FROM channels WHERE organization_id=$1 AND id=$2 AND kind=$4)', 'dm_check'],
    ['SELECT seq FROM channel_message_sequences WHERE organization_id = $1 AND channel_id = $2', 'watermark_seq'],
    ['SELECT seq, mutation_seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2', 'history_page_seq'],
    ['SELECT seq + $3 FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2', 'other'],
    ['SELECT pg_advisory_xact_lock_shared($1, $2)', 'channel_advisory_read'],
    ['INSERT INTO messages (id) VALUES ($1)', 'send_insert'],
    ['WITH unread_topics AS MATERIALIZED (SELECT 1) SELECT 1 FOR SHARE', 'row_lock_sql'],
  ];
  assert.deepEqual(cases.map(([query]) => statementGroup(query)), cases.map(([, group]) => group));
});

test('statement summaries accept bounded normalized text only', () => {
  const row = { id: '1', group: 'topic_page', calls: 1, execMs: 2 };
  assert.equal(parseStatements(JSON.stringify({ ...row, text: 'SELECT $1' }))[0].text, 'SELECT $1');
  assert.equal(parseStatements(JSON.stringify({ ...row, text: null }))[0].text, null);
  assert.throws(() => parseStatements(JSON.stringify({ ...row, text: 'x'.repeat(201) })), /Invalid PostgreSQL statement/);
  assert.throws(() => parseStatements(JSON.stringify({ ...row, text: 3 })), /Invalid PostgreSQL statement/);
  assert.throws(() => parseStatements(JSON.stringify({ ...row, group: 'unknown' })), /Invalid PostgreSQL statement/);
});

test('#769: a DIAGNOSTIC arm with missing evidence skips the remaining arms; formal runs never do', () => {
  assert.equal(remainingArmsSkipped(true, 'Missing DIAGNOSTIC evidence (Topic-list timings (topic_barrier))'), true);
  assert.equal(remainingArmsSkipped(true, undefined), false);
  assert.equal(remainingArmsSkipped(true, ''), false);
  assert.equal(remainingArmsSkipped(false, 'stack launch failed (Error)'), false);
});
