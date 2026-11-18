import { settings } from '../pool-before-after-summary.ts';
import { evidenceComplete, walInvalid, worst, type Evidence, type Status, type Wal } from '../slice5/judge.ts';
import { cells, moveInterval, moveLimits, thresholds, type Cell, type Plan, type Step } from './plan.ts';

import { outcomes, type Lane } from './metrics.ts';
export type LaneName = 'reader' | 'send' | 'move' | 'channels' | 'topics' | 'replay' | 'create';
export type Measurement = {
  lanes: Partial<Record<LaneName, Lane>>;
  evidence?: Evidence;
  readerTarget?: number;
  topicReaders?: number[];
  moveVerified?: boolean;
  wal?: Wal & { relationBytesDelta: number; messagesDelta: number };
};
export const infrastructureFailure = 'Docker daemon was independently unreachable';
export type Attempt = { measurement?: Measurement; infrastructure?: typeof infrastructureFailure; problem?: string };
export type Result = Step & { attempts: Attempt[] };
export type Verdict = { status: Status; reasons: string[] };
const verdict = (status: Status, ...reasons: string[]): Verdict => ({ status, reasons });
const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
const duration = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;

export function laneProblems(name: LaneName, lane: Lane | undefined, target?: number) {
  if (!lane) return [`${name}: missing outcomes`];
  const problems: string[] = [];
  const counts = outcomes.map(outcome => lane[outcome]);
  if (![lane.attempted, lane.droppedIterations, ...counts].every(count) ||
      lane.attempted !== counts.reduce((sum, n) => sum + n, 0)) problems.push(`${name}: incomplete outcomes`);
  if (lane.droppedIterations > 0) problems.push(`${name}: dropped iterations`);
  if (name === 'reader' && lane.attempted === 0) problems.push('reader: never started');
  if (target !== undefined && (lane.attempted < target * settings.minimumOfferedFraction || lane.attempted > target + 1))
    problems.push(`${name}: offered load outside #196 B bounds`);
  if (lane.accepted > 0 && (!duration(lane.p95) || !duration(lane.p99) || lane.p99 < lane.p95))
    problems.push(`${name}: missing latency samples`);
  if (name === 'send' && lane.rejected429 > 0) problems.push('send: rate limiter interfered (429)');
  return problems;
}

function targets(p: Plan, step: Step, m: Measurement): Partial<Record<LaneName, number | undefined>> {
  const active = step.arm === 'move';
  switch (step.part) {
    case 'A': return { reader: m.readerTarget, move: p.moves };
    case 'F': return { reader: m.readerTarget, [active ? 'move' : 'create']: p.moves };
    case 'E': return { reader: p.readerRate * (p.replaySeconds + p.drain), replay: p.topicReaders * p.replayPerReader };
    default: return {
      reader: p.readerRate * (p.seconds + p.drain),
      send: p.sendRate * p.seconds,
      ...(active && { move: p.seconds / moveInterval(step.size) }),
      ...(step.part === 'D' && { channels: p.channelRate * p.seconds, topics: undefined }),
    };
  }
}

function validity(p: Plan, step: Step, m: Measurement) {
  const scheduled = targets(p, step, m);
  const reasons = (Object.keys(scheduled) as LaneName[]).flatMap(name => laneProblems(name, m.lanes[name], scheduled[name]));
  if (!m.evidence || !evidenceComplete(m.evidence)) reasons.push('missing resource samples');
  if (['A', 'F'].includes(step.part) && (!m.readerTarget || !count(m.readerTarget))) reasons.push('missing reader schedule');
  if (step.part === 'D' && (m.topicReaders?.length !== p.topicReaders || m.topicReaders.some(n => !count(n) || n === 0) ||
    m.topicReaders.reduce((sum, n) => sum + n, 0) !== m.lanes.topics?.attempted)) reasons.push('missing Topic-list reader samples');
  const exact = step.part === 'E' ? 'replay' : step.part === 'A' ? 'move' : step.part === 'F' ? (step.arm === 'move' ? 'move' : 'create') : undefined;
  if (exact && m.lanes[exact]?.attempted !== scheduled[exact]) reasons.push(`${exact}: incomplete fixed iteration count`);
  if (step.part === 'F') {
    if (!m.wal || !Array.isArray(m.wal.autovacuumInside) || typeof m.wal.statsReset !== 'boolean' ||
        !Number.isFinite(m.wal.relationBytesDelta) || !Number.isSafeInteger(m.wal.messagesDelta)) reasons.push('missing WAL or storage samples');
    else reasons.push(...walInvalid(m.wal));
  }
  if (step.arm === 'move' && step.part !== 'E' && m.moveVerified === undefined) reasons.push('missing committed Move verification');
  return reasons;
}

function lastAttempt(row: Result, reruns: number): Attempt | undefined {
  if (row.attempts.length === 1) return row.attempts[0];
  if (reruns === 1 && row.attempts.length === 2 && row.attempts[0].infrastructure === infrastructureFailure) return row.attempts[1];
  return { problem: 'unauthorized rerun' };
}

function acceptedAll(lane: Lane | undefined) {
  return !!lane && lane.attempted > 0 && lane.accepted === lane.attempted;
}

function structural(step: Step, m: Measurement): string[] {
  if (!acceptedAll(m.lanes.reader)) return ['second-Organization reader errors'];
  switch (step.part) {
    case 'E': return acceptedAll(m.lanes.replay) ? [] : ['replay failed or returned an incorrect page'];
    case 'F': {
      if (step.arm === 'baseline') return acceptedAll(m.lanes.create) && m.wal?.messagesDelta === m.lanes.create?.accepted
        ? [] : ['Create failed or its Message row count differs'];
      if (m.wal?.messagesDelta !== 0) return ['Move changed the number of Message rows'];
      break;
    }
    case 'D':
      if (!acceptedAll(m.lanes.topics)) return ['Topic-list requests failed or returned a short page'];
      break;
  }
  if (step.arm === 'move' && (!m.moveVerified || !acceptedAll(m.lanes.move))) return ['Move failed or did not commit as expected'];
  return [];
}

type Metric = 'p95' | 'p99';
function within(lane: Lane | undefined, metric: Metric, limit: number | null, name: string): Verdict {
  const actual = lane?.[metric] ?? null;
  if (!duration(actual) || !duration(limit)) return verdict('INVALID', `${name}: missing ${metric} comparison sample`);
  return actual <= limit ? verdict('PASS') : verdict('FAIL', `${name} ${metric} ${actual} ms exceeds ${limit} ms`);
}

function combine(v: Verdict[]): Verdict {
  return { status: worst(v.map(row => row.status)), reasons: v.flatMap(row => row.reasons) };
}

function against(move: Lane | undefined, base: Lane | undefined, metric: Metric, name: string) {
  const baseline = base?.[metric] ?? null;
  return within(move, metric, duration(baseline) ? thresholds.latencyPercent * baseline / 100 : null, name);
}

function performanceGate(step: Step, move: Measurement, baseline: Measurement | undefined, a: Verdict | undefined, aP95: number | null) {
  const send = move.lanes.send, control = baseline?.lanes;
  switch (step.part) {
    case 'A': return within(move.lanes.move, 'p95', moveLimits[step.size as keyof typeof moveLimits] ?? null, 'Move');
    case 'B': {
      if (!send || send.accepted / send.attempted < thresholds.accepted) return verdict('FAIL', 'send acceptance below 99%');
      if (step.size === 100) return against(send, control?.send, 'p95', 'send');
      if (!a || a.status === 'INVALID' || a.status === 'NOT EVALUATED' || !duration(aP95))
        return verdict('NOT EVALUATED', 'same-round Part A 1,000-Message p95 unavailable');
      const p99 = control?.send?.p99 ?? null;
      return within(send, 'p99', duration(p99) ? p99 + aP95 : null, 'send');
    }
    case 'C': return combine([against(send, control?.send, 'p95', 'send'), against(send, control?.send, 'p99', 'send')]);
    case 'D': return combine([
      against(move.lanes.channels, control?.channels, 'p95', 'Channel-list'),
      within(move.lanes.topics, 'p95', thresholds.pageP95, 'Topic-list'),
    ]);
    case 'E': return combine([
      against(move.lanes.replay, control?.replay, 'p95', 'subscribe-replay'),
      within(move.lanes.replay, 'p95', thresholds.pageP95, 'subscribe-replay'),
    ]);
    case 'F': return move.wal!.lsnBytes / (step.size * move.lanes.move!.accepted) <=
      thresholds.walRatio * baseline!.wal!.lsnBytes / baseline!.lanes.create!.accepted
      ? verdict('PASS') : verdict('FAIL', 'WAL per moved Message exceeds twice the Create WAL per Message');
  }
}

export function judge(p: Plan, results: Result[], complete: boolean) {
  const reruns = results.filter(row => row.attempts.length > 1).length;
  const lookup = (cell: Cell, round: number, arm: Step['arm']) => {
    const matches = results.filter(row => row.part === cell.part && row.size === cell.size && row.round === round && row.arm === arm);
    return matches.length === 1 ? lastAttempt(matches[0], reruns) : undefined;
  };
  const evaluated = cells(p).map(cell => {
    const rounds = Array.from({ length: p.rounds }, (_, i) => {
      const round = i + 1;
      const arms: Step['arm'][] = cell.part === 'A' ? ['move'] : ['baseline', 'move'];
      const entries = arms.map(arm => ({ step: { ...cell, round, arm }, data: lookup(cell, round, arm) }));
      const checks = entries.map(({ step, data }) => {
        if (!data) return verdict('NOT EVALUATED', `${step.arm}: missing or duplicate step`);
        if (!data.measurement || data.problem || data.infrastructure) return verdict('INVALID', data.problem ?? data.infrastructure ?? 'missing step evidence');
        const reasons = validity(p, step, data.measurement);
        if (reasons.length) return verdict('INVALID', ...reasons.map(reason => `${step.arm}: ${reason}`));
        const failures = structural(step, data.measurement);
        if (p.smoke) for (const [name, lane] of Object.entries(data.measurement.lanes))
          if (!acceptedAll(lane)) failures.push(`smoke ${name} requests failed`);
        return failures.length ? verdict('FAIL', ...failures) : verdict('PASS');
      });
      const functional = combine(checks);
      const move = entries.at(-1)!.data?.measurement;
      const baseline = arms.length === 2 ? entries[0].data?.measurement : undefined;
      return { round, functional, move, baseline };
    });
    return { ...cell, rounds };
  });
  const rows = evaluated.map(cell => {
    const rounds = cell.rounds.map(r => {
      let gate = r.functional;
      if (gate.status === 'PASS' && !p.smoke) {
        const a = evaluated.find(row => row.part === 'A' && row.size === 1000)?.rounds[r.round - 1];
        gate = performanceGate({ ...cell, round: r.round, arm: 'move' }, r.move!, r.baseline, a?.functional, a?.move?.lanes.move?.p95 ?? null);
      }
      if (p.smoke || !complete) gate = verdict('NOT EVALUATED', p.smoke ? 'smoke is functional only' : 'run incomplete');
      return { round: r.round, functional: r.functional, ...gate };
    });
    return { part: cell.part, size: cell.size, rounds, ...combine(rounds) };
  });
  return {
    rows,
    overall: worst(rows.map(row => row.status)),
    functional: worst(rows.flatMap(row => row.rounds.map(round => round.functional.status))),
    limit: limitDecision(rows),
  };
}

export function limitDecision(rows: (Cell & Verdict)[]) {
  const status = (part: Cell['part'], size: number) => rows.find(row => row.part === part && row.size === size)?.status;
  const gates = [status('A', 1000), status('B', 1000)];
  if (gates.every(gate => gate === 'PASS')) return { status: 'kept', size: 1000 } as const;
  if (gates.includes('FAIL')) {
    const largest = Math.max(0, ...rows.filter(row => row.size >= 100 && row.size < 1000 &&
      (['A', 'B', 'C', 'D', 'E', 'F'] as const).every(part => status(part, row.size) === 'PASS')).map(row => row.size));
    if (largest) return { status: 'largest passing size', size: largest } as const;
    return { status: 'no eligible passing size', size: null } as const;
  }
  return { status: 'NOT EVALUATED', size: null } as const;
}
