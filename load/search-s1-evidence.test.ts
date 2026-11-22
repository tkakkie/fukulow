import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frozenPool } from './search-s1-bodies.ts';
import { acceptedMessages, overlaySource, preflightS1, termCheck, termCountsSql, validTermCheck } from './search-s1-evidence.ts';

const id1 = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';
const ids = [id1, id2];
const counts = (a: number, b: number) => `${id1}\t${id1}\t${a}\n${id2}\t${id2}\t${b}`;

test('preflight leaves A untouched and verifies every body and the retained B function properties', async () => {
  const pool = frozenPool();
  const overlay = overlaySource();
  const migrated = 'FUNCTION public.fukulow_search_terms(body text) AS fukulow_search_normalize(body)';
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
