import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { save } from '../bench.ts';
import { verifiedBackfill, type BackfillRecord } from '../d3r/backfill.ts';
import { preserveSnapshot, receiptFile, snapshotFile, stageSnapshot } from '../d3r/snapshot.ts';
import { owner, type Names } from './cluster.ts';
import { full, sourceCommit } from './design.ts';
import type { Options } from './options.ts';

type Provenance = {manifest: string; image: string; settings: string; rows: number; seed: number; productCommit: string};
type Receipt = {
  kind: 'd3r-churn-phase-a';
  provenance: Provenance;
  record: BackfillRecord;
  normalized: {removedEmptyWatermarks: number; normalizedEmptyTopics: number};
  snapshot: Awaited<ReturnType<typeof preserveSnapshot>>;
};

export function provenance(args: Options, manifest: string, image: string, settings: string): Provenance {
  return {manifest, image, settings, rows: args.rows, seed: full.seed, productCommit: sourceCommit};
}

export const systemIdentifier = (resources: Names) =>
  owner(resources, 'SELECT system_identifier FROM pg_control_system();');

export async function preserve(resources: Names, out: string, provenance: Provenance, record: BackfillRecord,
  normalized: Receipt['normalized']) {
  const snapshot = await preserveSnapshot(resources.server, out, systemIdentifier(resources));
  const receipt: Receipt = {kind: 'd3r-churn-phase-a', provenance, record, normalized, snapshot};
  save(join(out, receiptFile), receipt);
}

export async function loadArchive(dir: string, stage: string, expected: Omit<Provenance, 'settings'>) {
  let receipt: Receipt;
  try { receipt = JSON.parse(readFileSync(join(dir, receiptFile), 'utf8')); }
  catch { throw new Error('Expected a Phase A archive prepared with the production migrate command'); }
  assert.equal(receipt?.kind, 'd3r-churn-phase-a', 'Expected a Phase A archive prepared with the production migrate command (v18 archives are incompatible)');
  const {settings, ...identity} = receipt.provenance;
  assert.deepEqual(identity, expected, 'Backfill archive identity mismatch');
  assert.match(settings, /^[0-9a-f]{64}$/);
  assert.ok(verifiedBackfill(receipt.record, expected.rows), 'Backfill archive verification mismatch');
  assert.ok(receipt.snapshot?.file === snapshotFile && /^\d+$/.test(receipt.snapshot.systemIdentifier), 'Invalid backfill archive identity');
  assert.ok(Object.values(receipt.normalized ?? {}).length === 2 &&
    Object.values(receipt.normalized).every(n => Number.isSafeInteger(n) && n >= 0), 'Missing fixture normalization receipt');
  await stageSnapshot(join(dir, snapshotFile), {bytes: receipt.snapshot.bytes, sha256: receipt.snapshot.sha256}, stage);
  return receipt;
}
