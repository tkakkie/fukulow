import { isDeepStrictEqual } from 'node:util';
import { fullySampled } from '../d3r/acceptance.ts';
import { termEvidence } from '../d3r/backfill.ts';
import { full, modelLabel, queries, sampleSeconds, stages, type Stage } from './design.ts';
import type { Consistency } from './fixture.ts';
import type { Identity } from './identity.ts';
import type { ModelPlan, runModel } from './model.ts';
import { count, type Window } from './sampler.ts';
import { snapshots } from './sequence.ts';
import type { SendEvidence } from './send.ts';
import type { Snapshot } from './snapshot.ts';
import type { WindowEvidence } from './windows.ts';

export type Evidence = {
  initial?: Identity;
  final?: Identity;
  backfillVerified?: boolean;
  send?: SendEvidence;
  model?: ModelPlan & Awaited<ReturnType<typeof runModel>> & {plannedPerSecond: number | null};
  checks?: Partial<Record<'W1' | typeof modelLabel, Consistency>>;
  snapshots: Snapshot[];
  windows: Partial<Record<Window, WindowEvidence & {seconds?: number}>>;
  errors: string[];
};
export type Exit = {cleanupVerified: boolean; hostBusy: boolean | null; idle: boolean | null; interrupted: boolean};

const windowSeconds = {W1: full.sendSeconds, [modelLabel]: full.modelSeconds, 'W3 IDLE': full.idleSeconds} as const;
const completeWindow = (window: WindowEvidence | undefined, seconds: number) => {
  const length = seconds / sampleSeconds;
  return window?.samples.length === length + 1 && window.intervals.length === length &&
    window.samples.every((point, i) => point.second === i * sampleSeconds && count(point.startedMs) &&
      count(point.completedMs) && point.completedMs >= point.startedMs && (!i ||
        (point.startedMs > window.samples[i - 1].completedMs &&
          point.startedMs - window.samples[0].startedMs >= (i - 1) * sampleSeconds * 1000))) &&
    window.intervals.every(row => count(row.operations) && count(row.walBytes) &&
      (row.operations ? row.walBytesPerOperation === row.walBytes / row.operations : row.walBytesPerOperation === null));
};
const ids = queries.map(([id]) => id);

function completeSnapshot(snapshot: Snapshot | undefined, id: string, smoke: boolean) {
  if (!snapshot?.sample || !snapshot.physical || snapshot.id !== id) return false;
  const result = snapshot.search;
  if (!result) return false;
  if (smoke) return isDeepStrictEqual(result.untimedQueries, ids);
  return isDeepStrictEqual(result.latencies?.map(row => row.query), ids) &&
    result.latencies!.every(row => fullySampled(row) && 'p95' in row &&
      Number.isFinite(row.p95) && row.p95 >= 0) && isDeepStrictEqual(result.plans?.map(row => row.query), ids) &&
    result.plans!.every(row => typeof row.lookupExecuted === 'boolean' &&
      Array.isArray(row.lookupHeapFetches) && row.lookupHeapFetches.every(count));
}

const checked = (row: Consistency | undefined, messages: number) => termEvidence(row) &&
  count(row?.deletedTermRows) && count(row?.termRows) && row?.actualMessages === messages && row.checked === messages;

export function report(mode: Stage, rows: number, evidence: Evidence, exit: Exit) {
  const invalid = [...evidence.errors];
  if (!exit.cleanupVerified) invalid.push('Cleanup unverified');
  if (mode !== 'smoke' && exit.hostBusy !== true) invalid.push('HOST-BUSY was not held throughout');
  if (mode !== 'smoke' && exit.idle !== true) invalid.push('Host idle evidence missing or other work was running');
  if (exit.interrupted) invalid.push('Run interrupted');
  if (!evidence.initial || !evidence.final) invalid.push('Missing run identity');
  else if (!isDeepStrictEqual(evidence.initial, evidence.final) || evidence.initial.seed !== full.seed) invalid.push('Run identity mismatch');
  if (!evidence.backfillVerified) invalid.push('Backfill verification missing or mismatched');
  if (evidence.snapshots.length !== snapshots.length ||
      !snapshots.every((id, index) => completeSnapshot(evidence.snapshots[index], id, mode === 'smoke'))) {
    invalid.push('Missing snapshot evidence');
  }
  const sends = evidence.send;
  if (!sends || !count(sends.accepted)) invalid.push('Missing W1 Send evidence');
  else if (mode !== 'smoke' && sends.sustained !== true) invalid.push('W1 Send not sustained under S1');
  const messages = rows + (sends?.accepted ?? 0);
  const model = evidence.model;
  const edit = Math.floor(messages * full.editPercent / 100), remove = Math.floor(messages * full.deletePercent / 100);
  if (!model || model.label !== modelLabel || model.population !== messages || model.seed !== full.seed ||
      !isDeepStrictEqual(model.planned, {edit, delete: remove, total: edit + remove}) ||
      !isDeepStrictEqual(model.achieved, model.planned)) invalid.push('Missing or incomplete W2 MODEL workload evidence');
  const w1 = evidence.checks?.W1;
  const w2 = evidence.checks?.[modelLabel];
  if (!checked(w1, messages) || !checked(w2, messages)) invalid.push('Missing term consistency evidence');
  if (mode !== 'smoke') {
    for (const [label, seconds] of Object.entries(windowSeconds) as [Window, number][]) {
      if (!completeWindow(evidence.windows[label], seconds)) invalid.push(`Missing 5-minute evidence for ${label}`);
    }
    for (const label of ['W3 VACUUM', 'W3 REINDEX'] as const) {
      const window = evidence.windows[label];
      if (!window || typeof window.seconds !== 'number' || !Number.isFinite(window.seconds) || window.seconds < 0 ||
        !completeWindow(window, (window.samples.length - 1) * sampleSeconds) ||
        window.samples.length < 1 + Math.floor(window.seconds / sampleSeconds)) {
        invalid.push(`Missing 5-minute evidence for ${label}`);
      }
    }
  }
  const w1Defect = checked(w1, messages) && w1?.equal === false;
  const modelInvalid = (checked(w2, messages) && w2?.equal === false) || invalid.some(reason => reason.includes(modelLabel));
  return {
    label: stages[mode], status: invalid.length ? 'INVALID' : stages[mode], invalid,
    findings: [...(w1Defect ? ['W1 DEFECT: real Send term inconsistency'] : []),
      ...(modelInvalid ? ['W2 MODEL INVALID'] : [])],
    fixtureMessages: rows, realizedMessages: messages, cleanupVerified: exit.cleanupVerified,
    sampling: mode !== 'smoke', launcher: {hostBusy: exit.hostBusy, idle: exit.idle},
    snapshotted: evidence.snapshots.map(({id, sample, physical, search}) => ({id, sample,
      ...physical, p95Ms: search?.worstP95Ms, search})),
    windows: evidence.windows, send: sends, model, consistency: evidence.checks,
  };
}
