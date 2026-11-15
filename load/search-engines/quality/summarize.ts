import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import type { snapshot } from '../manifest.ts';

// Separate from the runner so publication can be verified without starting a run.
export function finalizeQuality(root: string, publication: 'evaluation'|'smoke' = 'evaluation') {
  const read = (name: string) => JSON.parse(readFileSync(`${root}/${name}.json`,'utf8'));
  const manifest: {sha256:string;runKind?:string;frozen:ReturnType<typeof snapshot>} = read('manifest');
  const manifestHash = createHash('sha256').update(JSON.stringify(manifest.frozen)).digest('hex');
  assert.equal(manifestHash,manifest.sha256,'Manifest payload hash mismatch');
  const kind = manifest.runKind ?? 'evaluation';
  assert.equal(kind,publication,'SMOKE / NON-EVALUATION cannot be published as evaluation (or vice versa)');
  const expected = manifest.frozen.quality;
  for (const name of ['completed','finished','run-status']) {
    const record = read(name);
    assert.equal(record.runKind ?? 'evaluation',kind,'Completion run kind mismatch');
    assert.equal(record.manifestHash,manifestHash,'Completion manifest hash mismatch');
    if (name==='run-status') {
      assert.equal(record.valid,true);
      assert.equal(record.cleanupVerified,true);
      assert.equal(record.exitCode,0);
    } else {
      assert.equal(record.modes,expected.modes.length,'Completion mode count mismatch');
      assert.equal(record.queries,expected.queries,'Completion query count mismatch');
      assert.equal(record.rows,expected.totalRows,'Completion row count mismatch');
    }
  }
  const dataset = read('dataset');
  assert.equal(dataset.totalRows,expected.totalRows,'Dataset row count mismatch');
  assert.equal(dataset.messages.length,expected.visibleRows,'Dataset visible row count mismatch');
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(digest(dataset.messages),expected.corpusHash,'Dataset corpus hash mismatch');
  // Runner-added normalization and labels are not part of query identity.
  const identities = dataset.queries.map(({gold,trimmed,normalized,...q}: Record<string,unknown>)=>q);
  assert.equal(digest(identities),expected.queryHash,'Dataset query hash mismatch');
  const queryIds = expected.querySet.map(q=>q.id);
  assert.equal(queryIds.length,expected.queries);
  assert.deepEqual(dataset.queries.map((q: {id:string})=>q.id),queryIds,'Dataset queries mismatch');
  const results = read('pending-summary');
  assert.deepEqual(results.map((r: {mode:string})=>r.mode),expected.modes.map(m=>m.id),'Summary modes mismatch');
  for (const result of results) {
    assert.equal(result.runKind ?? 'evaluation',kind,'Result run kind mismatch');
    assert.equal(result.manifestHash,manifestHash,'Result manifest hash mismatch');
    assert.deepEqual(result.queries.map((q: {query:string})=>q.query),queryIds,'Summary queries mismatch');
  }
  if (kind==='smoke') {
    writeFileSync(`${root}/summary.json`,JSON.stringify({runKind:'smoke',label:'SMOKE / NON-EVALUATION',evaluation:false,formal:false,results},null,2)+'\n');
    rmSync(`${root}/pending-summary.json`);
  } else renameSync(`${root}/pending-summary.json`,`${root}/summary.json`);
}
