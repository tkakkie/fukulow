import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionEvidence, logSettings, parseTraffic } from './c3-logs.ts';

const epoch = Date.parse('2026-11-25T00:00:00Z');
const log = (ms: number, session: string, role: string, db: string, message: string) =>
  `2026-11-25 00:00:00.${String(ms).padStart(3, '0')} UTC [${session}] ${role} ${db} | LOG:  ${message}`;
const receipt = (ms: number, session: string) => log(ms, session, '[unknown]', '[unknown]', 'connection received: host=client');
const auth = (ms: number, session: string, db = 'diag_1') => log(ms, session, 'fukulow_app', db, `connection authorized: user=fukulow_app database=${db}`);
const marker = (ms: number, stage: string) => log(ms, 'dead.ff', 'fukulow', 'diag_1', `C3_COVERAGE_${stage}`);
const lines = [receipt(20, 'dead.1'), auth(35, 'dead.1'), marker(50, 'BEGIN'), receipt(99, 'dead.2'), auth(103, 'dead.2'),
  receipt(101, 'dead.3'), auth(105, 'dead.3'), log(120, 'dead.3', 'fukulow_app', 'diag_1', 'disconnection: session time: 0:00:00.019'),
  receipt(200, 'dead.4'), auth(215, 'dead.4', 'other'), receipt(450, 'dead.5'), auth(460, 'dead.5'), marker(500, 'END')];
const verify = (entries: string[]) => connectionEvidence(entries.join('\n'), 'diag_1', epoch + 75, epoch + 100, epoch + 400);

test('pairs receipts with authorization even for disconnected sessions; filters role/database and detects late receipt not authorization', () => {
  assert.ok(logSettings.includes('log_connections=receipt,authorization'));
  assert.ok(logSettings.includes('log_disconnections=on'));
  const evidence = verify(lines);
  assert.deepEqual(evidence.late.map(row => row.session), ['dead.3']);
  assert.deepEqual(evidence.starts.map(row => row.session), ['dead.1', 'dead.2', 'dead.3', 'dead.5']);
  assert.ok(evidence.lines.some(line => line.includes('disconnection:')));
  assert.equal(evidence.lines.some(line => line.includes('dead.4')), false);
  const auto = log(300, 'dead.ee', '', 'diag_1', 'automatic analyze of table "diag_1.public.messages"');
  assert.deepEqual(verify([...lines, auto]).automaticMaintenance, [auto]);
});

test('both correctly placed coverage markers and receipt/authorization evidence are mandatory', () => {
  for (const stage of ['BEGIN', 'END']) assert.throws(() => verify(lines.filter(line => !line.includes(`C3_COVERAGE_${stage}`))), /coverage/);
  assert.throws(() => verify([...lines, marker(510, 'END')]), /coverage/);
  assert.throws(() => verify(lines.map(line => line.includes('C3_COVERAGE_END') ? marker(399, 'END') : line)), /coverage/);
  assert.throws(() => verify(lines.map(line => line.includes('C3_COVERAGE_BEGIN') ? marker(76, 'BEGIN') : line)), /coverage/);
  assert.throws(() => verify(lines.filter(line => !line.includes('dead.3') || !line.includes('received'))), /evidence missing/);
  assert.throws(() => verify([marker(50, 'BEGIN'), marker(500, 'END')]), /evidence missing/);
});

test('k6 parser requires one scenario marker and one summary and reads actual VU gauge points', () => {
  const start = `C3_START ${epoch}`;
  const request = `C3_REQUEST ${JSON.stringify({ id: 0, vu: 1, start: epoch, end: epoch + 1, latency: 0.5, status: 201 })}`;
  const summary = `C3_RESULT ${JSON.stringify(Object.fromEntries([['send_status', 1], ['send_failures', 0], ['iterations', 1]]
    .map(([name, count]) => [name, { values: { count } }])) )}`;
  const point = JSON.stringify({ type: 'Point', metric: 'vus', data: { time: '2026-11-25T00:00:00Z', value: 100 } });
  const traffic = parseTraffic([start, request, summary].join('\n'), point);
  assert.equal(traffic.load.accepted, 1);
  assert.equal(traffic.load.dropped, 0);
  assert.deepEqual(traffic.vus, [{ wallMs: epoch, value: 100 }]);
  assert.throws(() => parseTraffic([request, summary].join('\n'), point), /marker/);
  assert.throws(() => parseTraffic([start, summary, summary].join('\n'), point), /duplicate/);
  assert.throws(() => parseTraffic([start, request, summary].join('\n'), 'not json'), SyntaxError);
});
