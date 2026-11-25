import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { restore } from './frequency-ratios.ts';
import { checkPermissionEvidence, same, setNames } from './frequency-evidence.ts';
import type { Floors } from './frequency-judge.ts';
import { hostAffinityProblems } from './frequency-host-affinity.ts';

export type FrequencyStage = 'control' | 'rehearsal2' | 'formal';
type Quote = { quote: string; date: string };
type Review = Quote & { sha256: string };
export const reviewedFloorsUrl = new URL('frequency-floors.json', import.meta.url);
export const isQuote = (r: Partial<Quote> | null | undefined): r is Quote => Boolean(
  typeof r?.quote === 'string' && r.quote.trim() && typeof r.date === 'string' && r.date.trim());
const hasDigest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const isReview = (r: Review | null | undefined) => isQuote(r) && hasDigest(r?.sha256);
const digest = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');

function validateFloors(floors: Floors): Floors {
  for (const set of setNames) restore(floors?.[set]);
  return floors;
}

export function frozenFloors(file = reviewedFloorsUrl) {
  try {
    const raw = readFileSync(file);
    const record = JSON.parse(raw.toString());
    if (record.version !== 3 || !isReview(record.control) || !isReview(record.rehearsal2) ||
      record.control.sha256 === record.rehearsal2.sha256) throw new Error('missing control or Rehearsal 2 review');
    const floors = validateFloors(record.floors);
    const proposal = reviewedControlFloors(record.control).floors;
    if (!setNames.every(set => same(floors[set], proposal[set]))) throw new Error('frozen floors differ from the reviewed control proposal');
    return { floors, sha256: digest(raw) };
  } catch (e) { throw new Error(`STOP: formal #796 requires frozen block-1 floors and reviewed Rehearsal 2 (${String(e)})`); }
}

export function permissionCheck(path: string | undefined) {
  if (!path || !isAbsolute(path)) throw new Error('STOP: control needs --permission-check with an absolute path');
  const go = JSON.parse(readFileSync(path, 'utf8'));
  if (!isReview(go) || typeof go.report !== 'string' || !isAbsolute(go.report) || go.exit !== 0) {
    throw new Error('STOP: no passed permission check with its own go');
  }
  const raw = readFileSync(go.report);
  if (digest(raw) !== go.sha256) throw new Error('STOP: permission-check hash differs from its go record');
  return { go, identity: checkPermissionEvidence(JSON.parse(raw.toString())) };
}

export function controlFloors(reviewPath: string | undefined) {
  if (!reviewPath || !isAbsolute(reviewPath)) throw new Error('STOP: Rehearsal 2 needs --control-review with an absolute path');
  return reviewedControlFloors(JSON.parse(readFileSync(reviewPath, 'utf8')));
}

function reviewedControlFloors(review: (Review & { report?: unknown }) | null | undefined) {
  if (typeof review?.report !== 'string' || !isAbsolute(review.report) || !isReview(review)) throw new Error('STOP: no documented control review');
  const raw = readFileSync(review.report);
  if (digest(raw) !== review.sha256) throw new Error('STOP: control report hash differs from its review');
  const report = JSON.parse(raw.toString());
  if (report.stage !== 'control' || report.valid !== true) throw new Error('STOP: control did not validate');
  if (hostAffinityProblems(report.evidence?.hostAffinity, report.session?.id,
    report.evidence?.calibration?.calibration?.identity?.bootId).length > 0) {
    throw new Error('STOP: reviewed control has no valid #796 housekeeping preflight');
  }
  return { floors: validateFloors(report.frequency.floorProposal), sha256: review.sha256 };
}
