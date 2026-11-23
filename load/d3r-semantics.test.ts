import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from './d3r-semantics.ts';
import type { Query } from './search-engines/quality/dataset.ts';

test('normalized tokens and literal punctuation reach SQL, and short queries score empty results', t => {
  const cases: Query[] = [
    { id: 'multi', class: 'literal', text: 'Ｘ％Ｙ\u0085_\\', intent: '', gold: ['match'] },
    { id: 'short', class: 'short', text: '𠮷　a', intent: '', gold: ['match'] },
    { id: 'two', class: 'short', text: '𠮷a a', intent: '', gold: ['match', 'miss'] },
  ];
  const messages = [{ id: 'match', body: 'x%y _\\ 𠮷a' }];
  const replies = [JSON.stringify(['x%y\u0085_\\', '𠮷 a', '𠮷a a']), '{"two":["match"],"multi":["match"]}'];
  const sql = t.mock.fn((_text: string) => replies.shift() ?? '');
  const rows = evaluate(sql, messages, cases);

  assert.equal(sql.mock.callCount(), 2);
  const [normalize, match] = sql.mock.calls.map(call => call.arguments[0]);
  assert.ok(normalize.includes(JSON.stringify(cases.map(query => query.text))));
  assert.match(normalize, /public\.fukulow_search_normalize\(value\)/);
  assert.ok(match.includes(JSON.stringify(messages)));
  assert.ok(match.includes(JSON.stringify([
    { id: 'multi', tokens: ['x%y', '_\\'] }, { id: 'two', tokens: ['𠮷a', 'a'] },
  ])));
  assert.match(match, /public\.fukulow_search_normalize\(body\)/);
  assert.match(match, /strpos\(message\.body COLLATE pg_catalog\."C", token\) = 0/);
  assert.deepEqual(rows.map(({ class: name, tooShort, tp, fp, fn }) => [name, tooShort, tp, fp, fn]), [
    ['literal', false, 1, 0, 0], ['short', true, 0, 0, 1], ['short', false, 1, 0, 1],
  ]);
});
