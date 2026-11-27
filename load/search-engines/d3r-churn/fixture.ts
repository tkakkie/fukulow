import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { docker, save } from '../bench.ts';
import { backfill, verifiedBackfill, verifyTerms } from '../d3r/backfill.ts';
import { readSource, sources } from '../d3r/path.ts';
import { directRls, directRlsExpected, forceSearchRls, verifyRls } from '../d3r/rls.ts';
import { withSession } from '../d3r/session.ts';
import { hash, appSessionSettings } from '../manifest.ts';
import { copySql, finishSql, fixtureSql, generate, literal, member, org } from '../seed.ts';
import { appSql, owner, type Names } from './cluster.ts';
import { base, db, full } from './design.ts';

const authFixture = readSource('server/tests/auth.rs');
export const loadEmail = 'synthetic-1-1@example.invalid';
export const loadPassword = authFixture.match(/^const PASSWORD: &str = "([^"]+)";$/m)![1];
const fixturePasswordHash = authFixture.match(/^const ARGON2_053_PHC: &str = "([^"]+)";$/m)![1];

export const normalizationSql = `BEGIN;
  WITH removed AS (
    DELETE FROM public.channel_message_sequences s
    WHERE NOT EXISTS (SELECT FROM public.messages m
      WHERE (m.organization_id, m.channel_id) = (s.organization_id, s.channel_id))
    RETURNING 1
  ), empty_topics AS (
    UPDATE public.topics t SET first_seq = NULL, last_seq = NULL, message_count = 0
    WHERE message_count <> 0 AND NOT EXISTS (SELECT FROM public.messages m
      WHERE (m.organization_id, m.channel_id, m.topic_id) = (t.organization_id, t.channel_id, t.id))
    RETURNING 1
  )
  SELECT jsonb_build_object('removedEmptyWatermarks', (SELECT count(*) FROM removed),
    'normalizedEmptyTopics', (SELECT count(*) FROM empty_topics));
  COMMIT;`;

const positionViolations = `WITH positions AS (
    SELECT organization_id, channel_id, min(seq) AS first, max(seq) AS last, count(*) AS n
    FROM public.messages GROUP BY organization_id, channel_id
  )
  SELECT count(*) FROM positions p
  FULL JOIN public.channel_message_sequences s USING (organization_id, channel_id)
  WHERE p.first IS DISTINCT FROM 1::bigint OR p.last IS DISTINCT FROM s.seq OR p.n IS DISTINCT FROM s.seq;`;

export function verifyMigrationHistory(resources: Names) {
  const error = 'Phase A requires valid SQLx migration history from the production migrate command';
  assert.equal(owner(resources, "SELECT to_regclass('public._sqlx_migrations') IS NOT NULL;"), 't', error);
  const expected = base.migrations.map(path => {
    const version = path.match(/\/(\d+)_/)![1];
    return `${version}|t|${createHash('sha384').update(readSource(path)).digest('hex')}`;
  }).join('\n');
  assert.ok(owner(resources, "SELECT version, success, encode(checksum, 'hex') FROM public._sqlx_migrations ORDER BY version;") === expected,
    error);
}

export function verifyFixture(resources: Names, rows: number) {
  assert.equal(owner(resources, 'SELECT count(*) FROM public.messages WHERE NOT deleted;'), String(rows), 'Backfill Message count mismatch');
  assert.equal(owner(resources, 'SELECT count(*) FROM public.messages WHERE deleted;'), '0', 'Backfill contains deleted Messages');
  assert.equal(owner(resources, positionViolations), '0', 'Fixture Message positions do not cover each Channel watermark');
  const app = (text: string) => appSql(resources, text);
  const rls = verifyRls(app, {...appSessionSettings, jit: 'off'});
  // Very small smoke can have no Messages in Organization 2. Verify its control from the fixture count.
  const hasSecond = owner(resources, `SELECT EXISTS (SELECT FROM public.messages WHERE organization_id='${org(2)}');`) === 't';
  assert.equal(directRls(app), hasSecond ? directRlsExpected : directRlsExpected.replace(`${org(2)}\nt|t`, `${org(2)}\nf|f`),
    'Organization RLS controls differ');
  return rls;
}

async function bodies(tsv: string, count: number, dest: string) {
  const lines = createInterface({input: createReadStream(tsv), crlfDelay: Infinity});
  const output: string[] = [];
  for await (const line of lines) {
    const raw = line.split('\t')[6];
    assert.ok(raw, 'Missing fixture body');
    output.push(raw.replace(/\\([\\nt])/g, (_, escape: string) => ({'\\': '\\', n: '\n', t: '\t'})[escape]!));
    if (output.length === count) break;
  }
  assert.equal(output.length, count, 'Missing fixture bodies');
  const json = JSON.stringify(output);
  writeFileSync(dest, json);
  return {bodyPool: output, bodyHash: hash(json)};
}

export async function prepareBodies(out: string, rows: number, restored: boolean, sendCount: number) {
  const tsv = `${out}/fixture-messages.tsv`;
  const data = generate(tsv, restored ? sendCount : rows);
  assert.equal(data.seed, full.seed, 'Generator seed mismatch');
  const body = await bodies(tsv, sendCount, `${out}/send-bodies.json`);
  save(`${out}/generator.json`, {...data, purpose: restored ? 'W1 body source' : 'base fixture plus W1 body source',
    bodyCount: sendCount, bodyHash: body.bodyHash});
  return {...body, tsv};
}

export async function freshFixture(resources: Names, rows: number, out: string, tsv: string) {
  owner(resources, `${forceSearchRls}
    ALTER ROLE fukulow_app IN DATABASE fukulow SET jit = off;
    CREATE EXTENSION pgstattuple;
    CREATE EXTENSION pg_visibility;`);
  owner(resources, fixtureSql());
  owner(resources, `UPDATE public.accounts SET password_hash = ${literal(fixturePasswordHash)}
    WHERE id = '${member(1, 1)}' AND email = '${loadEmail}';`);
  docker('cp', tsv, `${resources.server}:/tmp/messages.tsv`);
  owner(resources, copySql);
  docker('exec', resources.server, 'rm', '/tmp/messages.tsv');
  rmSync(tsv);
  // The registered W0 performs the VACUUM ANALYZE after term backfill.
  assert.ok(finishSql.endsWith('VACUUM ANALYZE;'));
  owner(resources, finishSql.slice(0, -'VACUUM ANALYZE;'.length));
  const normalized = JSON.parse(owner(resources, normalizationSql));
  assert.equal(owner(resources, positionViolations), '0', 'Fixture Message positions do not cover each Channel watermark');
  save(`${out}/normalization.json`, normalized);
  const record = await withSession(resources.client, db, false, own =>
    withSession(resources.client, db, true, app => backfill(own, app, readSource(sources.engine), rows)));
  save(`${out}/backfill.json`, record);
  assert.ok(verifiedBackfill(record, rows), 'Backfill verification mismatch');
  return {record, normalized};
}

export async function consistency(resources: Names, messages: number) {
  return withSession(resources.client, db, false, async sql => {
    const [actualMessages, termRows, deletedTermRows]: [number, number, number] = JSON.parse(await sql(`
      SELECT jsonb_build_array((SELECT count(*) FROM public.messages),
        (SELECT count(*) FROM public.message_search_terms),
        (SELECT count(*) FROM public.messages m JOIN public.message_search_terms t
          USING (organization_id) WHERE t.message_id = m.id AND m.deleted));`));
    const verification = await verifyTerms(sql, messages, termRows);
    return {actualMessages, termRows, deletedTermRows, ...verification,
      equal: verification.equal && actualMessages === messages && deletedTermRows === 0};
  });
}
export type Consistency = Awaited<ReturnType<typeof consistency>>;

export function checkBodyHash(out: string, expected: string) {
  assert.equal(hash(readFileSync(`${out}/send-bodies.json`, 'utf8')), expected, 'W1 body source hash mismatch');
}
