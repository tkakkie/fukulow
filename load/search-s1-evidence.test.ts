import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { repoPath, sha256 } from './search-m1-bodies.ts';
import { frozenPool } from './search-s1-bodies.ts';
import {
  acceptedMessages, originalTermsSha256, overlaySource, preflightS1, termCheck, termCountsSql, validTermCheck, type TermCheck,
} from './search-s1-evidence.ts';

const id1 = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';
const ids = [id1, id2];
const counts = (a: number, b: number) => `${id1}\t${id1}\t${a}\n${id2}\t${id2}\t${b}`;

function migratedDefinition() {
  const migration = readFileSync(repoPath('server/migrations/202611210725_message_search.sql'), 'utf8');
  const source = migration.match(/^CREATE FUNCTION public\.fukulow_search_terms\b.*?^    END;$/ms);
  assert.ok(source);
  // Replay the deparser's formatting for this SQL-standard function body.
  return source[0]
    .replace(/^CREATE FUNCTION (.*?) RETURNS /, 'CREATE OR REPLACE FUNCTION $1\n RETURNS ')
    .replace('    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE\n    BEGIN ATOMIC', ' LANGUAGE sql\n IMMUTABLE PARALLEL SAFE STRICT\nBEGIN ATOMIC')
    .replace(/ {8}WITH normalized AS MATERIALIZED \(SELECT (.*?)\(body\) AS value\)/,
      ' WITH normalized AS MATERIALIZED (\n          SELECT $1(fukulow_search_terms.body) AS value\n         )')
    .replace(/ {8}SELECT DISTINCT substr\(value, position, width\) COLLATE pg_catalog\."C"/,
      '  SELECT DISTINCT (substr(normalized.value, positions."position", widths.width) COLLATE "C") AS substr')
    .replace('        FROM normalized\n        CROSS JOIN (VALUES (2), (3)) AS widths(width)',
      '    FROM ((normalized\n      CROSS JOIN ( VALUES (2), (3)) widths(width))')
    .replace('        CROSS JOIN LATERAL generate_series(1, char_length(value) - width + 1) AS positions(position);',
      '      CROSS JOIN LATERAL generate_series(1, ((char_length(normalized.value) - widths.width) + 1)) positions("position"));')
    .replace('    END;', 'END\n');
}

test('the pinned function hash comes from the Message Search migration', () => {
  assert.equal(sha256(migratedDefinition()), originalTermsSha256);
});

test('preflight leaves A untouched and verifies every body and the retained B function properties', async () => {
  const pool = frozenPool();
  const overlay = overlaySource();
  let migrated = migratedDefinition();
  const properties = { owner: 'fukulow', result: 'SETOF text', volatility: 'i', strict: true, parallel: 's' };
  let installed = false;
  const sql = async (query: string) => {
    if (query === overlay.text) {
      installed = true;
      return '';
    }
    if (query.startsWith('SELECT count')) return '0';
    return JSON.stringify({ ...properties, definition: installed ? overlay.text : migrated });
  };
  const sqlInput = async (query: string) => {
    assert.match(query, /public\.fukulow_search_normalize\(body\)/);
    assert.ok(pool.pool.every(body => query.includes(body)));
    return String(pool.count);
  };
  const functions = { overlay };
  assert.equal(await preflightS1('A', functions, pool, sql, sqlInput), pool.count);
  assert.equal(installed, false);
  assert.equal(await preflightS1('B', functions, pool, sql, sqlInput), pool.count);
  assert.equal(installed, true);
  installed = false;
  await assert.rejects(preflightS1('A', functions, pool, sql, async () => String(pool.count - 1)), /normalization/);

  migrated = migrated.replace('VALUES (2), (3)', 'VALUES (2), (4)');
  for (const arm of ['A', 'B'] as const) {
    await assert.rejects(preflightS1(arm, { overlay }, pool, sql, sqlInput), /differs from the pinned migration/);
    assert.equal(installed, false);
  }
});

test('accepted IDs are counted separately from failed sends and must be unique and complete', () => {
  const organization = `LOAD_S1_ORGANIZATION ${id1}\n`;
  const log = `${organization}LOAD_S1_ACCEPTED ${id1}\ntransport timeout\nLOAD_S1_ACCEPTED ${id2}\n`;
  assert.deepEqual(acceptedMessages(log, 2), { organizationId: id1, ids });
  assert.throws(() => acceptedMessages(log, 3), /differs from k6/);
  assert.throws(() => acceptedMessages(log.replace(id2, id1), 2), /Duplicate/);
  assert.throws(() => acceptedMessages(log.replace(id2, "';"), 2), /Malformed/);
  assert.throws(() => acceptedMessages(log.replace(organization, ''), 2), /Organization/);
  assert.match(termCountsSql(acceptedMessages(organization, 0)), /FROM STDIN;\n\\\.\n/);
});

test('checks every accepted Message, including missing rows, and does not substitute an average', () => {
  assert.equal(validTermCheck(termCheck(ids, counts(7997, 7997), 'A'), 2, 'A'), true);
  assert.equal(validTermCheck(termCheck(ids, counts(7996, 7998), 'A'), 2, 'A'), false);
  assert.equal(validTermCheck(termCheck(ids, counts(0, 0), 'B'), 2, 'B'), true);
  assert.equal(validTermCheck(termCheck(ids, counts(0, 1), 'B'), 2, 'B'), false);
  assert.equal(validTermCheck(termCheck(ids, `${id1}\t${id1}\t0\n${id2}\t\\N\t\\N`, 'B'), 2, 'B'), false);
  assert.throws(() => termCheck(ids, `${id1}\t${id1}\t0`, 'B'), /Incomplete/);
  assert.equal(validTermCheck(termCheck([], '', 'A'), 0, 'A'), true);
});

test('missing or malformed per-Message count distributions return false', () => {
  for (const rowsPerMessage of [undefined, null, 0, '0', []]) {
    const malformed = { ...termCheck([], '', 'B'), rowsPerMessage } as unknown as TermCheck;
    assert.equal(validTermCheck(malformed, 0, 'B'), false);
  }
});
