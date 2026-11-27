import assert from 'node:assert/strict';
import { begin } from '../d3r/path.ts';
import { channel, org } from '../seed.ts';
import { slotIds, slotScope, type ArmFixture } from './arms.ts';
import type { SyncSql } from './fixture.ts';

export function readTermFingerprint(owner: SyncSql) {
  return owner(`${begin}
    SELECT encode(sha256(convert_to(string_agg(to_jsonb(t)::text, E'\\n'
      ORDER BY organization_id, channel_id, term, created_at, message_id), 'UTF8')), 'hex')
    FROM public.message_search_terms t;
    COMMIT;`);
}

type Fingerprints = {messages: string; terms: string};

export function assertMatchingVData(reference: Fingerprints, delayed: Fingerprints) {
  for (const table of ['messages', 'terms'] as const) {
    assert.match(reference[table], /^[a-f0-9]{64}$/, `Missing V ${table} fingerprint`);
    assert.equal(delayed[table], reference[table], `V ${table} fingerprints differ`);
  }
}

type HeapVisibility = {rows: number; pages: number; allVisiblePages: number};
type Visibility = {messages: HeapVisibility; message_search_terms: HeapVisibility};

export function readVisibility(owner: SyncSql, arm: ArmFixture): Visibility {
  const {o, c} = slotScope(arm);
  const scope = `organization_id = '${org(o)}' AND channel_id = '${channel(o, c)}'`;
  return JSON.parse(owner(`${begin}
    WITH slots AS (
      SELECT 'public.messages'::regclass AS heap, ctid FROM public.messages
      WHERE ${scope} AND ${slotIds('id', arm)}
      UNION ALL
      SELECT 'public.message_search_terms'::regclass, ctid FROM public.message_search_terms
      WHERE ${scope} AND ${slotIds('message_id', arm)}
    ), pages AS (
      SELECT heap, split_part(ltrim(ctid::text, '('), ',', 1)::bigint AS block, count(*) AS rows
      FROM slots GROUP BY 1, 2
    ), visibility AS (
      SELECT heap, json_build_object('rows', sum(rows), 'pages', count(*),
        'allVisiblePages', count(*) FILTER (WHERE vm.all_visible)) AS stats
      FROM pages CROSS JOIN LATERAL public.pg_visibility_map(heap, block) AS vm GROUP BY heap
    )
    SELECT json_build_object(
      'messages', (SELECT stats FROM visibility WHERE heap = 'public.messages'::regclass),
      'message_search_terms', (SELECT stats FROM visibility WHERE heap = (
        SELECT indrelid FROM pg_catalog.pg_index WHERE indexrelid = 'public.message_search_terms_lookup'::regclass
      )));
    COMMIT;`));
}

export function assertVisibility(reference: Visibility, delayed: Visibility, slots: number) {
  for (const [heap, expectedRows] of [['messages', slots], ['message_search_terms', 5 * slots]] as const) {
    for (const stats of [reference[heap], delayed[heap]]) {
      assert.ok(stats && stats.pages > 0 && stats.rows === expectedRows, `V ${heap} slot pages are incomplete`);
    }
    assert.equal(reference[heap].allVisiblePages, reference[heap].pages, `V reference ${heap} pages must be all-visible`);
    assert.equal(delayed[heap].allVisiblePages, 0, `V delayed ${heap} pages must have clear all-visible bits`);
  }
}
