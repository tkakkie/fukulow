import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hash, snapshot } from '../manifest.ts';
import { corpus, queries } from './dataset.ts';
import { finalizeQuality } from './summarize.ts';

const cases = ['success','smoke-success','smoke-refused','smoke-mixed','tampered-manifest','wrong-summary-hash','missing-mode','duplicate-mode','missing-query','duplicate-query',
  'wrong-completion-hash','wrong-finished-hash','wrong-status-hash','invalid-status','failed-cleanup','failed-exit',
  'incomplete-modes','incomplete-queries','incomplete-rows','incomplete-finished','incomplete-dataset',
  'incomplete-visible-rows','incomplete-dataset-queries','edited-corpus','edited-query-text',
  ...['manifest','pending-summary','completed','finished','run-status','dataset'].map(name=>`missing-${name}`)];
for (const mode of cases) {
  test(`quality publication fails closed: ${mode}`,t=>{
    const dir = mkdtempSync(join(tmpdir(),'search-quality-summary-'));
    t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const smoke = mode.startsWith('smoke-');
    const runKind = smoke?'smoke':'evaluation';
    const frozen = snapshot();
    const manifestHash = hash(JSON.stringify(frozen));
    const expected = frozen.quality;
    const results = expected.modes.map(m=>({manifestHash,runKind:mode==='smoke-mixed'?'evaluation':runKind,mode:m.id,queries:expected.querySet.map(q=>({query:q.id}))}));
    if (mode==='wrong-summary-hash') results[0]!.manifestHash='wrong';
    if (mode==='missing-mode') results.pop();
    if (mode==='duplicate-mode') results[0]!.mode=results[1]!.mode;
    if (mode==='missing-query') results[0]!.queries.pop();
    if (mode==='duplicate-query') results[0]!.queries[0]!.query=results[0]!.queries[1]!.query;
    const completion = {manifestHash,runKind,modes:expected.modes.length,queries:expected.queries,rows:expected.totalRows};
    const finished = {...completion};
    if (mode==='wrong-completion-hash') completion.manifestHash='wrong';
    if (mode==='wrong-finished-hash') finished.manifestHash='wrong';
    if (mode==='incomplete-modes') completion.modes=0;
    if (mode==='incomplete-queries') completion.queries=0;
    if (mode==='incomplete-rows') completion.rows=0;
    if (mode==='incomplete-finished') finished.rows=0;
    const dataset = {totalRows:expected.totalRows,messages:corpus(),queries:queries.map(q=>({...q,trimmed:q.text,normalized:q.text}))};
    if (mode==='edited-corpus') dataset.messages[0]!.body+='edited';
    if (mode==='edited-query-text') dataset.queries[0]!.text+='edited';
    if (mode==='incomplete-dataset') dataset.totalRows=0;
    if (mode==='incomplete-visible-rows') dataset.messages.pop();
    if (mode==='incomplete-dataset-queries') dataset.queries.pop();
    if (mode==='tampered-manifest') frozen.quality.totalRows++;
    const artifacts = {
      manifest:{sha256:manifestHash,frozen,runKind},'pending-summary':results,completed:completion,finished,dataset,
      'run-status':{manifestHash:mode==='wrong-status-hash'?'wrong':manifestHash,
        runKind,valid:mode!=='invalid-status',cleanupVerified:mode!=='failed-cleanup',exitCode:mode==='failed-exit'?1:0},
    };
    for (const [name,value] of Object.entries(artifacts)) {
      if (mode!==`missing-${name}`) writeFileSync(join(dir,name+'.json'),JSON.stringify(value));
    }
    if (mode==='success' || mode==='smoke-success') {
      finalizeQuality(dir,smoke?'smoke':'evaluation');
      const summary = JSON.parse(readFileSync(join(dir,'summary.json'),'utf8'));
      if (smoke) {
        assert.equal(summary.label,'SMOKE / NON-EVALUATION');
        assert.equal(summary.evaluation,false);
        assert.equal(summary.formal,false);
        assert.deepEqual(summary.results,results);
        assert.throws(()=>finalizeQuality(dir),/cannot be published as evaluation/);
      } else assert.deepEqual(summary,results);
      assert.equal(existsSync(join(dir,'pending-summary.json')),false);
    } else {
      assert.throws(()=>finalizeQuality(dir,mode==='smoke-mixed'?'smoke':'evaluation'));
      assert.equal(existsSync(join(dir,'summary.json')),false);
    }
  });
}
