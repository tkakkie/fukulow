import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acceptedPreflight, preflightIdentity as identity, preflightReadbackValue, preflightSendBuffer } from './revocation-holds-preflight-fixture.ts';
import { preflightLedgerPath, recordPreflight, requireRecordedLedger } from './revocation-holds-preflight-ledger.ts';
import { requirePreflight, SetupAbort } from './revocation-holds-setup.ts';
import type { SessionIdentity } from './revocation-holds-provenance.ts';

const expectedReadbacks = { receiveBuffer: preflightReadbackValue, sendBuffer: preflightSendBuffer };

function outputs(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'revocation-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = preflightLedgerPath(identity.hostname, undefined, join(root, 'home'));
  mkdirSync(join(root, 'evidence'));
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

test('the host ledger is one fixed state path per host and OS user unless configured', () => {
  const configured = '/shared/host-ledger.ndjson';
  assert.equal(preflightLedgerPath('first-host', undefined, '/home/m'),
    '/home/m/.local/state/fukulow/revocation-holds-preflights.first-host.ndjson');
  assert.equal(preflightLedgerPath('second host', undefined, '/home/m'),
    '/home/m/.local/state/fukulow/revocation-holds-preflights.second%20host.ndjson');
  assert.equal(preflightLedgerPath('first-host', configured, '/home/m'), configured);
  assert.equal(preflightLedgerPath('first-host'),
    join(userInfo().homedir, '.local/state/fukulow/revocation-holds-preflights.first-host.ndjson'));
});

test('changing XDG_STATE_HOME or HOME between preflight and a later stage cannot hide a failed preflight', async t => {
  const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, HOME: process.env.HOME };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const root = mkdtempSync(join(tmpdir(), 'revocation-ledger-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const underEnv = (name: string) => {
    process.env.XDG_STATE_HOME = join(root, name, 'state');
    process.env.HOME = join(root, name, 'home');
    return { fixed: preflightLedgerPath(identity.hostname), ledger: preflightLedgerPath(identity.hostname, undefined, join(root, 'passwd-home')) };
  };
  const first = underEnv('first');
  const later = underEnv('later');
  assert.equal(later.fixed, first.fixed);
  assert.equal(later.fixed, preflightLedgerPath(identity.hostname, undefined, userInfo().homedir));
  assert.equal(later.ledger, first.ledger);
  const output = (name: string) => { const dir = join(root, name); mkdirSync(dir); return dir; };
  await recordPreflight(first.ledger, output('pass'), identity, async () => identity, pass);
  await recordPreflight(later.ledger, output('fail'), identity, async () => identity, fail);
  assert.throws(() => requirePreflight({ kind: 'measured', identity, ledger: first.ledger, preflightFile: join(root, 'pass', 'preflight.json') }), SetupAbort);
});

test('stages with different --out parents share the fixed ledger, so a later failed preflight blocks the earlier pass', async t => {
  const { ledger, stage, readback } = outputs(t);
  const first = stage('first');
  await recordPreflight(ledger, first.output, identity, async () => identity, pass);
  assert.equal(JSON.parse(readFileSync(first.artifact, 'utf8')).ledger, ledger);
  requireRecordedLedger(first.artifact, ledger);
  assert.deepEqual(readback(first.artifact), expectedReadbacks);
  const later = stage(join('evidence', 'later'));
  await recordPreflight(ledger, later.output, identity, async () => identity, fail);
  assert.throws(() => readback(first.artifact), SetupAbort);
});

test('a later stage refuses a ledger other than the one its preflight recorded', async t => {
  const { ledger, stage } = outputs(t);
  const { output, artifact } = stage('first');
  await recordPreflight(ledger, output, identity, async () => identity, pass);
  const other = `${ledger}.other`;
  assert.throws(() => requireRecordedLedger(artifact, other), /differs from .* recorded in/);
  assert.throws(() => requireRecordedLedger(join(output, 'missing.json'), ledger), /Cannot read the ledger/);
  const legacy = join(output, 'legacy.json');
  writeFileSync(legacy, JSON.stringify({ passed: true }));
  assert.throws(() => requireRecordedLedger(legacy, ledger), /differs from none recorded/);
  // A copy of the ledger with the same entries still cannot authorize SA2 for that artifact.
  writeFileSync(other, readFileSync(ledger));
  assert.throws(() => requirePreflight({ kind: 'measured', identity, ledger: other, preflightFile: artifact }), SetupAbort);
});

test('SA2 accepts an exact passing artifact only with a readable matching ledger', async t => {
  const { ledger, stage, readback, entries } = outputs(t);
  const { output, artifact } = stage('first');
  await recordPreflight(ledger, output, identity, async () => identity, pass);
  const data = readFileSync(artifact);
  assert.deepEqual(JSON.parse(data.toString('utf8')).identity, identity);
  assert.equal(entries().at(-1).status, 'passed');
  assert.equal(entries().at(-1).artifactSha256, hash('sha256', data));
  assert.deepEqual(readback(artifact), expectedReadbacks);
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
    assert.deepEqual(readback(artifact), expectedReadbacks, name);
  }
  const later = stage('later');
  await recordPreflight(ledger, later.output, identity, async () => identity, fail);
  assert.equal(JSON.parse(readFileSync(later.artifact, 'utf8')).passed, false);
  assert.deepEqual(entries().map(entry => entry.status), ['started', 'passed', 'started', 'failed', 'started', 'failed', 'started', 'failed']);
  assert.throws(() => readback(artifact), SetupAbort);

  const fresh = stage('fresh');
  await recordPreflight(ledger, fresh.output, identity, async () => identity, pass);
  assert.deepEqual(readback(fresh.artifact), expectedReadbacks);
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

test('a preflight through either ledger is mirrored into the host ledger, so a later failure through the other is never missed', async t => {
  const { ledger: host, stage } = outputs(t);
  const override = `${host}.override`;
  const authorizes = (selected: string, artifact: string) =>
    requirePreflight({ kind: 'measured', identity, ledger: selected, hostLedger: host, preflightFile: artifact });
  const viaHost = stage('via-host');
  await recordPreflight(host, viaHost.output, identity, async () => identity, pass, host);
  assert.deepEqual(authorizes(host, viaHost.artifact), expectedReadbacks);
  await recordPreflight(override, stage('fail-override').output, identity, async () => identity, fail, host);
  assert.throws(() => authorizes(host, viaHost.artifact), SetupAbort, 'failure through the override');

  const viaOverride = stage('via-override');
  await recordPreflight(override, viaOverride.output, identity, async () => identity, pass, host);
  assert.deepEqual(authorizes(override, viaOverride.artifact), expectedReadbacks);
  await recordPreflight(host, stage('fail-host').output, identity, async () => identity, fail, host);
  assert.throws(() => authorizes(override, viaOverride.artifact), SetupAbort, 'failure through the host ledger');
});

test('every later stage refuses a mismatched ledger before it creates its output', async t => {
  const { ledger, stage } = outputs(t);
  const { output, artifact } = stage('first');
  await recordPreflight(ledger, output, identity, async () => identity, pass);
  const cli = join(import.meta.dirname, 'revocation-holds.ts');
  for (const extra of [['--rehearsal'], ['--overhead'], [], ['--overhead-summary', join(output, 'summary.json')]]) {
    const out = join(output, `later-${extra.join('') || 'formal'}`);
    const result = spawnSync(process.execPath, [cli, '--out', out, '--session', identity.session, '--preflight-result', artifact,
      '--preflight-ledger', `${ledger}.other`, ...extra], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0, extra.join(' '));
    assert.match(result.stderr, /Preflight ledger .* differs from .* recorded in/, extra.join(' '));
    assert.equal(existsSync(out), false, extra.join(' '));
  }
});
