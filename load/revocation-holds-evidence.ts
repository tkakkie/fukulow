// Positive evidence for the fallback pass under test (v4 E1–E8).
import { CELLS, SOCKETS_PER_ACCOUNT, STALL_MESSAGES, TIMELINE } from './revocation-holds-plan.ts';
import type { HoldsRun, TargetSocket } from './revocation-holds-judgment.ts';

const UINT = /^(0|[1-9]\d*)$/;
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const count = (s: string) => UINT.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : NaN;
const records = (data: string) => data === '' ? [] : data.split(',').map(row => row.split(':'));
const validIdXor = (s: string) => UINT.test(s) && BigInt(s) <= 0xffff_ffff_ffff_ffffn;

export function channelsXor(ids: string[]) {
  if (!ids.every(id => UUID.test(id))) return undefined;
  return ids.reduce((xor, id) => xor ^ BigInt('0x' + id.replaceAll('-', '')), 0n).toString(16).padStart(32, '0');
}

export function stallMessagesAfterResume(target: TargetSocket) {
  const resumed = target.stall.resumedAt[0] ?? Infinity;
  return new Set(target.stallMessages.filter(message => message.at >= resumed).map(message => message.id)).size;
}

export function evidence(run: HoldsRun) {
  const issues: { rule: string; message: string }[] = [];
  const add = (rule: string, message: string) => issues.push({ rule, message });
  const fail = (rule: string, condition: boolean, message: string) => { if (condition) add(rule, message); };
  const trace = run.trace;
  for (const message of trace ? new Set([...trace.evidenceErrors, ...trace.timingErrors]) : ['trace file missing']) add('E8', message);
  const events = trace?.events ?? [];
  if (!events.length) add('E8', 'no S1–S4 events');
  const bounds = run.sendTiming?.offsetBoundsMs;
  const offset = bounds && (bounds[0] + bounds[1]) / 2;
  const s1s = events.filter(event => event.name === 'subscription_fallback_pass')
    .filter(event => offset !== undefined && Math.abs(event.started + offset - run.times.pass) <= 1000);
  const s1 = s1s.length === 1 ? s1s[0] : undefined;
  if (!s1) add('E1', 'expected exactly one S1 near P with clock calibration');
  if (s1 && (s1.started > s1.session || s1.session > s1.completed)) add('E1', 'unordered worker pass timestamps');
  if (s1 && run.kind === 'control' && s1.outcome !== 'ok') add('E1', `control S1 outcome is ${s1.outcome}`);
  const s4s = events.filter(event => event.name === 'revocation_fallback_check')
    .filter(event => s1 && s1.started <= event.started && event.started <= event.finished && event.finished <= s1.completed && event.seq < s1.seq);
  const s4 = s4s.length === 1 ? s4s[0] : undefined;
  if (!s4) add('E1', 'expected exactly one S4 inside S1');
  if (s4 && run.kind === 'fault' && !(s4.chunks === s4.failed && s4.chunks > 0)) add('E3', 'the gate did not fail every chunk');
  if (s4 && run.kind === 'control' && s4.failed !== 0) add('E1', 'a control chunk failed');
  const belongs = (event: { check: number; at: number; seq: number }) =>
    s4 && event.check === s4.check && event.at >= s4.started && event.at <= s4.finished && event.seq < s4.seq;
  const overlaps = (event: { check: number; at: number }) =>
    event.check === s4?.check || (s1 && event.at >= s1.started && event.at <= s1.completed);
  const snapshots = events.filter(event => event.name === 'revocation_fallback_snapshot').filter(overlaps);
  const outcomes = events.filter(event => event.name === 'revocation_fallback_outcome').filter(overlaps);
  if ([...snapshots, ...outcomes].some(event => !belongs(event))) add('E1', 'S2 or S3 does not match the worker pass');
  const s2 = snapshots.length === 1 && belongs(snapshots[0]) ? snapshots[0] : undefined;
  const s3 = outcomes.length === 1 && belongs(outcomes[0]) ? outcomes[0] : undefined;
  const queued = records(s2?.records ?? '');
  const disposed = records(s3?.records ?? '');
  const members = new Map(run.accounts.map(account => [account.memberId, 0]));
  const cell = CELLS[run.cell];
  const expectedXor = channelsXor(run.revokedChannels);
  if (!s2 || !queued.length || s2.registrations !== queued.length || members.size !== cell.accounts || members.has(undefined) ||
    run.revokedChannels.length !== cell.channels || new Set(run.revokedChannels).size !== cell.channels || !expectedXor) {
    add('E2', 'missing or incomplete snapshot or target fixture');
  }
  if (s2 && run.kind === 'fault' && (!bounds || s2.at + bounds[0] < run.times.gateOn[1])) add('E2', 'snapshot not certainly after gate-on acknowledgement');

  const dispositionRule = run.kind === 'fault' ? 'E4' : 'E4c';
  if (!s3 || !s2 || s3.seq <= s2.seq || s3.at < s2.at || !disposed.length || disposed.length !== queued.length) {
    add(dispositionRule, 'missing or incomplete registration dispositions');
  }
  let refusedTotal = 0, heldTotal = 0;
  const admissions: { member: string; registration: number; marginMs: number }[] = [];
  for (const [i, row] of queued.entries()) {
    const [member, checks, queueSize, verifiedAtSnapshot, xor, ids] = row;
    const n = count(checks);
    if (members.has(member)) members.set(member, members.get(member)! + 1);
    fail('E2', row.length !== 6 || !members.has(member) || n !== cell.channels || count(queueSize) !== n ||
      !(count(verifiedAtSnapshot) <= n) || xor !== expectedXor || !validIdXor(ids), `snapshot registration ${i + 1} lacks all queued revoked checks`);
    const out = disposed[i];
    if (!out) continue;
    const outMember = out[0], [held, refused, closed, verified, unverified, gone] = out.slice(1, 7).map(count);
    const idXor = out[7], admitted = out[8];
    if (out.length !== 9 || outMember !== member || held + refused + closed + verified + unverified + gone !== n ||
      !validIdXor(idXor) || (gone === 0 && idXor !== ids)) {
      add(dispositionRule, `registration ${i + 1} dispositions do not match its snapshot`);
      continue;
    }
    if (run.kind === 'control') {
      fail('E4c', held !== 0 || refused !== 0 || closed !== 0 || unverified !== 0 || admitted !== '-', `control registration ${i + 1} did not verify or account for every check`);
    } else {
      heldTotal += held;
      refusedTotal += refused;
      const at = admitted === '-' || !admitted?.trim() ? NaN : Number(admitted);
      const marginMs = bounds ? run.times.resume - (at + bounds[1]) : NaN;
      if (Number.isFinite(marginMs)) admissions.push({ member, registration: i + 1, marginMs });
      fail('E4', held + refused !== n || !(Number(s2?.at) <= at && at <= Number(s3?.at)) || !(marginMs > 0),
        `registration ${i + 1} did not hold or refuse every check before release`);
    }
  }
  if ([...members.values()].some(n => n !== SOCKETS_PER_ACCOUNT)) add('E2', 'wrong snapshot registration count per target Member');
  if (run.kind === 'fault') {
    const capTotal = (run.metrics?.revocation_retired_registration_cap ?? NaN) + (run.metrics?.revocation_retired_global_cap ?? NaN);
    if (heldTotal < 1 || refusedTotal !== capTotal) add('E4', 'no holds or disposition refusals disagree with the cap counters');
  }
  if (run.targets.length !== cell.accounts * SOCKETS_PER_ACCOUNT || run.targets.some(t => stallMessagesAfterResume(t) !== STALL_MESSAGES)) {
    add('E6', `not every target received all ${STALL_MESSAGES} stall Messages after release`);
  }

  const lagMs = run.times.resume - (run.times.pass + TIMELINE.resume);
  const s4FinishAfterPassMs = s4 && bounds ? s4.finished + bounds[1] - run.times.pass : undefined;
  const completeAdmissions = members.size === cell.accounts && [...members].every(([member, registrations]) =>
    registrations === SOCKETS_PER_ACCOUNT && admissions.filter(a => a.member === member).length === registrations);
  return {
    issues, admissions, held: heldTotal, refused: refusedTotal,
    workerCompletionMarginMs: s1 && bounds ? run.times.resume - (s1.completed + bounds[1]) : undefined,
    s4SpanMs: s4 && s4.finished - s4.started, s1SpanMs: s1 && s1.completed - s1.started,
    s4FinishAfterPassMs,
    q2AdmissionReview: run.kind === 'fault' && (s4FinishAfterPassMs === undefined || s4FinishAfterPassMs > 50 ||
      !completeAdmissions || admissions.some(a => a.marginMs <= 0)),
    e7ResumeLagMs: lagMs, q8Over50Ms: lagMs > 50,
  };
}
