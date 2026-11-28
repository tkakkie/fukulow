import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { docker, save } from '../bench.ts';
import { verifyRls } from '../d3r/rls.ts';
import { withSession } from '../d3r/session.ts';
import { appSessionSettings } from '../manifest.ts';
import { callerLock } from '../d3r-leak/host.ts';
import * as archives from './archive.ts';
import { appSql, images as resolveImages, maintenanceSql, refreshRestoredRole, start, startApp, stopApp, verifyApp, verifyImage, type Names } from './cluster.ts';
import { db, full, modelLabel, sessionOverrides, stages, appSettings } from './design.ts';
import { checkBodyHash, consistency, freshFixture, prepareBodies, recordFixtureRls, verifyMigrationHistory } from './fixture.ts';
import { identity } from './identity.ts';
import { loadManifest, verifyProduct } from './manifest.ts';
import { planModel, runModel } from './model.ts';
import type { Options } from './options.ts';
import type { Evidence } from './report.ts';
import { sequence } from './sequence.ts';
import { capture } from './snapshot.ts';
import { idle, maintenance, monitor, sends } from './windows.ts';

export async function worker(args: Options, resources: Names) {
  const evidence: Evidence = {snapshots: [], windows: {}, checks: {}, errors: []};
  const persist = () => save(join(args.out, 'evidence.json'), evidence);
  const smoke = args.mode === 'smoke';
  const note = (message: string) => console.log(`${stages[args.mode]} | ${message}`);
  try {
    const manifest = loadManifest();
    verifyProduct();
    const images = resolveImages(args);
    const expected = archives.provenance(args, manifest.fileHash, images.pg, '');
    const stage = join(args.out, 'staged-backfill');
    let receipt;
    if (args.from) {
      mkdirSync(stage, {mode: 0o700});
      const {settings: _settings, ...archiveIdentity} = expected;
      receipt = await archives.loadArchive(args.from, stage, archiveIdentity);
    }
    note(receipt ? 'Restoring the verified Phase A backfill' : 'Preparing the Phase A fixture');
    const session = smoke ? undefined : callerLock().session;
    const live = await start(resources, images, session, receipt ? stage : undefined);
    save(join(args.out, 'placement.json'), live.placement);
    verifyMigrationHistory(resources);
    evidence.initial = identity(resources, images);
    save(join(args.out, 'settings.json'), {postgresOverrides: manifest.frozen.postgres.settings,
      postgresEffective: evidence.initial.settings, sessionOverrides, appSettings});
    if (receipt) {
      refreshRestoredRole(resources, live.appPassword);
      assert.equal(archives.systemIdentifier(resources), receipt.snapshot.systemIdentifier, 'Restored system identifier mismatch');
      assert.equal(evidence.initial.settingsHash, receipt.provenance.settings, 'Restored PostgreSQL settings mismatch');
      const verified = await consistency(resources, args.rows);
      save(join(args.out, 'restored-backfill.json'), {receipt, verified});
      assert.ok(verified.equal && verified.termRows === receipt.record.termRows, 'Restored backfill verification mismatch');
      save(join(args.out, 'normalization.json'), receipt.normalized);
      rmSync(stage, {recursive: true});
    }
    const {tsv, bodyPool, bodyHash} = await prepareBodies(args.out, args.rows, !!receipt, smoke ? 1 : full.rate * full.sendSeconds);
    if (receipt) rmSync(tsv);
    const fresh = receipt ? undefined : await freshFixture(resources, args.rows, args.out, tsv);
    recordFixtureRls(resources, args.rows, args.out);
    evidence.backfillVerified = true;
    persist();
    if (args.preserve && fresh) {
      await archives.preserve(resources, args.out,
        archives.provenance(args, manifest.fileHash, images.pg, evidence.initial.settingsHash), fresh.record, fresh.normalized);
      docker('exec', resources.server, 'rm', '-rf', '/tmp/backfill');
    }
    let messageCount = args.rows;
    await sequence({
      sql: async (text, label) => {
        if (!label || smoke) await maintenanceSql(resources.client, text);
        else evidence.windows[label] = await maintenance(resources.client, args, label, text);
        persist();
      },
      snapshot: async id => {
        note(`${id} snapshot`);
        evidence.snapshots.push(await capture(resources.client, args.out, id, smoke));
        persist();
        if (id === 'W1' || id === modelLabel) {
          evidence.checks![id] = await consistency(resources, messageCount);
          persist();
          if (!smoke && id === 'W1') assert.ok(evidence.send?.sustained, 'W1 Send not sustained under S1');
        }
      },
      sends: async () => {
        note('W1 real Sends');
        const lane = await startApp(resources, images, live.appPassword, !smoke);
        if (lane) save(join(args.out, 'w1-app-placement.json'), lane);
        const result = await sends(resources, images, args, bodyHash);
        verifyApp(resources, images);
        verifyImage(resources.k6, images.k6);
        checkBodyHash(args.out, bodyHash);
        evidence.send = result.result;
        evidence.windows.W1 = result.window;
        messageCount += result.result.accepted;
        persist();
        await stopApp(resources);
      },
      model: async () => {
        note(`${modelLabel} workloads`);
        const {targets, ...plan} = await withSession(resources.client, db, false, planModel);
        save(join(args.out, 'w2-model-plan.json'), {...plan, targets,
          plannedPerSecond: smoke ? null : plan.planned.total / full.modelSeconds});
        assert.equal(plan.population, messageCount, 'W2 MODEL population does not match the base plus W1');
        let window;
        const result = await runModel(resources.client, targets, bodyPool, smoke, async work => {
          window = await monitor(resources.client, args, modelLabel, full.modelSeconds, work);
        });
        evidence.windows[modelLabel] = window;
        evidence.model = {...plan, ...result, plannedPerSecond: smoke ? null : plan.planned.total / full.modelSeconds};
        persist();
      },
      idle: async () => {
        note('W3 IDLE');
        evidence.windows['W3 IDLE'] = await monitor(resources.client, args, 'W3 IDLE', full.idleSeconds,
          smoke ? async () => {} : idle);
        persist();
      },
    });
    save(join(args.out, 'final-rls.json'), verifyRls(text => appSql(resources, text), {...appSessionSettings, jit: 'off'}));
    verifyProduct();
    evidence.final = identity(resources, images);
  } catch (error) {
    evidence.errors.push(error instanceof Error ? error.message : String(error));
    console.error(`Phase A INVALID: ${evidence.errors.at(-1)}`);
    process.exitCode = 1;
  } finally {
    persist();
  }
}
