// Linux transport regression. The calibration invocation preserves diagnostics from just the capped arm.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { outsideCheckout } from './proxy-target.ts';
import { evidence, stallMessagesAfterResume } from './revocation-holds-evidence.ts';
import type { HoldsRun } from './revocation-holds-judgment.ts';
import { BYSTANDERS, CELLS, STALL_DEFAULT, targetSockets } from './revocation-holds-plan.ts';
import { cleanup, measure, type Active } from './revocation-holds-run.ts';
import { parseSendBuffer, SEND_BUFFER_ENV } from './revocation-measured-server.ts';

const checkout = resolve(import.meta.dirname, '..');
const binary = resolve(checkout, 'target/release/fukulow-server');
const helperBinary = resolve(process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname, 'harness-core/stall-helper/target'), 'release/fukulow-stall-helper');
const calibrationOutput = process.env.FUKULOW_668_CALIBRATION_OUT;
const trial = { kind: 'control', cell: 'Hcap', repeat: 1 } as const;
const volume = 60;
const count = targetSockets(trial.cell);
const { channels } = CELLS[trial.cell];

function checkTransport(run: HoldsRun) {
  assert.equal(run.setup.targetsReadyAtStall, count);
  assert.equal(run.setup.bystandersReadyAtStall, BYSTANDERS);
  assert.equal(run.setup.stallPostFailures, 0);
  assert.deepEqual(run.setup.stallErrors, []);
  assert.deepEqual(run.setup.calibrationErrors, []);
  assert.equal(run.stallReadbacks?.length, count);
  assert.ok(run.stallReadbacks?.every(({ before, after }) => before > 0 && after === before));
  assert.ok(run.accounts.every(account => account.revokeStatus === 200));
  assert.equal(run.times.resumeUnobserved, false);
  assert.equal(run.targets.length, count);
  for (const target of run.targets) {
    const [paused] = target.stall.pausedAt, [resumed] = target.stall.resumedAt;
    assert.ok(paused >= run.times.stall && paused < run.times.revoke && resumed > run.times.revoke);
    assert.ok(target.stall.reads.every(({ at }) => at <= paused || at >= resumed));
    assert.ok(target.stall.closes.every(({ at }) => at >= resumed));
    assert.ok(!target.close || target.close.at >= resumed);
    assert.equal(stallMessagesAfterResume(target), volume);
    assert.ok(target.stallMessages.every(({ at }) => at >= resumed));
  }
  const proof = evidence(run, volume);
  assert.deepEqual(proof.issues.filter(({ rule }) => rule !== 'E2' && rule !== 'E4c' && rule !== 'E7'), []);
  const bounds = run.sendTiming?.offsetBoundsMs;
  assert.ok(bounds && run.trace);
  const offset = (bounds[0] + bounds[1]) / 2;
  const pass = run.trace.events.find(event => event.name === 'subscription_fallback_pass' &&
    Math.abs(event.started + offset - run.times.pass) <= 1_000);
  assert.ok(pass?.name === 'subscription_fallback_pass');
  const check = run.trace.events.find(event => event.name === 'revocation_fallback_check' &&
    pass.started <= event.started && event.finished <= pass.completed);
  assert.ok(check?.name === 'revocation_fallback_check');
  assert.equal(check.registrations, count + BYSTANDERS);
  assert.ok(check.started + bounds[1] < run.times.resume, 'S4 must start during the proxy pause');
  return { proof, check, latestOffset: bounds[1] };
}

for (const capped of [false, true]) {
  test(`#668 Linux k60 Hcap control ${capped ? 'capped' : 'uncapped'}`, {
    skip: process.platform !== 'linux' || Boolean(calibrationOutput && !capped),
    timeout: 240_000,
  }, async () => {
    const sendBuffer = capped ? (calibrationOutput ? parseSendBuffer(process.env[SEND_BUFFER_ENV]) : 16_384) : undefined;
    const output = calibrationOutput ? outsideCheckout(calibrationOutput) : mkdtempSync(resolve(tmpdir(), 'fk668-sndbuf-'));
    if (calibrationOutput) mkdirSync(output);
    const active: Active = {};
    const id = capped ? 'k60-Hcap-capped' : 'k60-Hcap-uncapped';
    let passed = false;
    try {
      const run = await measure({
        binary, helperBinary, output, active, stall: STALL_DEFAULT, interrupted: () => false,
        setup: { kind: 'diagnostic', sendBuffer }, linuxPlacement: Boolean(calibrationOutput), preflightVolume: volume,
      }, trial, id);
      const { proof, check, latestOffset } = checkTransport(run);
      if (capped) {
        assert.ok(run.effectiveSendBuffer && run.effectiveSendBuffer > 0);
        assert.equal(proof.snapshotRecords, count);
        assert.deepEqual(proof.issues.filter(({ rule }) => rule === 'E2' || rule === 'E4c'), []);
        const snapshot = run.trace?.events.find(event => event.name === 'revocation_fallback_snapshot' && event.check === check.check);
        assert.ok(snapshot?.name === 'revocation_fallback_snapshot');
        assert.ok(snapshot.at + latestOffset < run.times.resume, 'S2 must observe the queue during the proxy pause');
        console.log(`#668 k60 requested SO_SNDBUF=${sendBuffer}, effective SO_SNDBUF=${run.effectiveSendBuffer}, SO_RCVBUF=${run.stallReadbacks?.[0]?.after}`);
      } else {
        assert.equal(run.effectiveSendBuffer, undefined);
        const file = JSON.parse(readFileSync(resolve(output, id, 'send-buffer-readbacks.json'), 'utf8'));
        assert.equal(file.requested, null);
        assert.equal(file.targets.length, count);
        assert.ok(file.targets.every(({ values }: { values: number[] }) => values.length === 0));
        assert.equal(proof.snapshotRecords, 0);
        assert.ok(!run.trace?.events.some(event =>
          (event.name === 'revocation_fallback_snapshot' || event.name === 'revocation_fallback_outcome') && event.check === check.check));
        const sends = run.sendTiming?.records;
        assert.equal(sends?.length, count * channels);
        assert.ok(sends?.every(send => send.afterHold === false && send.afterMs < check.started),
          'every uncapped revocation write must flush before S4');
        for (let index = 0; index < count; index++) {
          const notices = run.notices.filter(notice => notice.socket === index);
          assert.equal(notices.length, channels);
          assert.deepEqual(new Set(notices.map(notice => notice.channelId)), new Set(run.revokedChannels));
          assert.ok(notices.every(notice => notice.at >= run.targets[index].stall.resumedAt[0]));
        }
      }
      passed = true;
    } finally {
      await cleanup(active);
      if (passed && !calibrationOutput) rmSync(output, { recursive: true, force: true });
      else console.log(`#668 diagnostic artifacts: ${output}`);
    }
  });
}
