import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acceptedPreflight, preflightIdentity as identity, preflightReadbackValue } from './revocation-holds-preflight-fixture.ts';
import { preflightLedgerPath, recordPreflight } from './revocation-holds-preflight-ledger.ts';
import { requirePreflight, SetupAbort } from './revocation-holds-setup.ts';
import type { SessionIdentity } from './revocation-holds-provenance.ts';

function outputs(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'revocation-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = preflightLedgerPath(join(root, 'first'), identity.hostname);
  const stage = (name: string) => {
    const output = join(root, name);
    mkdirSync(output);
    return { output, artifact: join(output, 'preflight.json') };
  };
  const readback = (preflightFile: string, current = identity) =>
    requirePreflight({ kind: 'measured', identity: current, ledger, preflightFile });
  return { ledger, stage, readback, entries: () => readFileSync(ledger, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)) };
}

const pass = async (identity: SessionIdentity) => acceptedPreflight(identity);
const fail = async (identity: SessionIdentity) => ({ ...acceptedPreflight(identity), passed: false, readback: null });

test('the host ledger defaults to the output parent and can be configured across output roots', () => {
  const configured = '/shared/host-ledger.ndjson';
  assert.equal(preflightLedgerPath('/evidence/preflight', 'first-host'), '/evidence/revocation-holds-preflights.first-host.ndjson');
  assert.equal(preflightLedgerPath('/evidence/rehearsal', 'second-host'), '/evidence/revocation-holds-preflights.second-host.ndjson');
  assert.equal(preflightLedgerPath('/separate/rehearsal', 'first-host', configured), configured);
});

test('SA2 accepts an exact passing artifact only with a readable matching ledger', async t => {
  const { ledger, stage, readback, entries } = outputs(t);
  const { output, artifact } = stage('first');
  await recordPreflight(ledger, output, identity, async () => identity, pass);
  const data = readFileSync(artifact);
  assert.deepEqual(JSON.parse(data.toString('utf8')).identity, identity);
  assert.equal(entries().at(-1).status, 'passed');
  assert.equal(entries().at(-1).artifactSha256, hash('sha256', data));
  assert.equal(readback(artifact), preflightReadbackValue);
  assert.throws(() => requirePreflight({ kind: 'measured', identity, ledger: `${ledger}.missing`, preflightFile: artifact }), SetupAbort);
  for (const patch of [{ bootId: 'rebooted' }, { serverSha256: 'c'.repeat(64) }, { stallHelperSha256: 'd'.repeat(64) }, { gitClean: false }]) {
    assert.throws(() => readback(artifact, { ...identity, ...patch }), SetupAbort, JSON.stringify(patch));
  }
  appendFileSync(artifact, '\n');
  assert.throws(() => readback(artifact), SetupAbort, 'same JSON with different bytes');
  appendFileSync(ledger, 'null\n');
  assert.throws(() => readback(artifact), SetupAbort, 'malformed ledger');
});

test('only the latest result for the same host and session can authorize SA2', async t => {
  const { ledger, stage, readback, entries } = outputs(t);
  const { output, artifact } = stage('first');
  await recordPreflight(ledger, output, identity, async () => identity, pass);
  for (const [name, patch] of [['other-host', { hostname: 'second-host' }], ['other-session', { session: 'second-session' }]] as const) {
    const other = { ...identity, ...patch };
    await recordPreflight(ledger, stage(name).output, other, async () => other, fail);
    assert.equal(readback(artifact), preflightReadbackValue, name);
  }
  const later = stage('later');
  await recordPreflight(ledger, later.output, identity, async () => identity, fail);
  assert.equal(JSON.parse(readFileSync(later.artifact, 'utf8')).passed, false);
  assert.deepEqual(entries().map(entry => entry.status), ['started', 'passed', 'started', 'failed', 'started', 'failed', 'started', 'failed']);
  assert.throws(() => readback(artifact), SetupAbort);

  const fresh = stage('fresh');
  await recordPreflight(ledger, fresh.output, identity, async () => identity, pass);
  assert.equal(readback(fresh.artifact), preflightReadbackValue);
  assert.throws(() => readback(artifact), SetupAbort, 'a newer passing artifact supersedes the old one');
});

test('starting a preflight withdraws the earlier pass and records an early setup failure', async t => {
  const { ledger, stage, readback, entries } = outputs(t);
  const first = stage('first');
  await recordPreflight(ledger, first.output, identity, async () => identity, pass);
  const next = stage('next');
  await assert.rejects(recordPreflight(ledger, next.output, identity, async () => {
    assert.equal(entries().at(-1).status, 'started');
    assert.throws(() => readback(first.artifact), SetupAbort);
    throw new Error('dirty working tree');
  }, async () => assert.fail('must abort before trials')), /dirty working tree/);
  assert.equal(existsSync(next.artifact), false);
  assert.equal(entries().at(-1).status, 'failed');
  assert.throws(() => readback(first.artifact), SetupAbort);
});

test('a preflight publishes passing evidence only after confirming unchanged provenance', async t => {
  const { ledger, stage, readback, entries } = outputs(t);
  const { output, artifact } = stage('changed');
  let reads = 0;
  await assert.rejects(recordPreflight(ledger, output, identity, async () =>
    reads++ === 0 ? identity : { ...identity, gitClean: false }, async (identity, saveProgress) => {
    const result = acceptedPreflight(identity);
    saveProgress(result);
    assert.equal(JSON.parse(readFileSync(artifact, 'utf8')).passed, false);
    return result;
  }), /provenance changed/);
  assert.equal(JSON.parse(readFileSync(artifact, 'utf8')).passed, false);
  assert.equal(entries().at(-1).status, 'failed');
  assert.throws(() => readback(artifact), SetupAbort);
});
