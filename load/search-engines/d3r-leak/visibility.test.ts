import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMatchingVData, assertVisibility } from './visibility.ts';

test('V requires equal full-row fingerprints for both tables', () => {
  const reference = {messages: 'a'.repeat(64), terms: 'b'.repeat(64)};
  assertMatchingVData(reference, {...reference});
  assert.throws(() => assertMatchingVData(reference, {...reference, messages: 'c'.repeat(64)}), /messages fingerprints differ/);
  assert.throws(() => assertMatchingVData(reference, {...reference, terms: 'c'.repeat(64)}), /terms fingerprints differ/);
});

test('V requires the visibility difference on both heaps', () => {
  const reference = {
    messages: {rows: 40, pages: 2, allVisiblePages: 2},
    message_search_terms: {rows: 200, pages: 3, allVisiblePages: 3},
  };
  const delayed = {
    messages: {...reference.messages, allVisiblePages: 0},
    message_search_terms: {...reference.message_search_terms, allVisiblePages: 0},
  };
  assertVisibility(reference, delayed, 40);
  for (const heap of ['messages', 'message_search_terms'] as const) {
    assert.throws(() => assertVisibility(reference, {...delayed, [heap]: reference[heap]}, 40), new RegExp(`delayed ${heap}`));
    assert.throws(() => assertVisibility({...reference, [heap]: delayed[heap]}, delayed, 40), new RegExp(`reference ${heap}`));
    assert.throws(() => assertVisibility(reference, {...delayed, [heap]: {rows: 0, pages: 0, allVisiblePages: 0}}, 40),
      new RegExp(`${heap} slot pages are incomplete`));
  }
});
