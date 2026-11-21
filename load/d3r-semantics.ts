import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { CommandTimeoutError, command, docker, sql } from './search-engines/bench.ts';
import { loadManifest, postgresArguments, resolveImage } from './search-engines/manifest.ts';
import { ownedContainer, ownedVolume, ownershipLabel, supervise } from './search-engines/runtime.ts';
import { literal } from './search-engines/seed.ts';
import { classes, corpus, queries, type Query } from './search-engines/quality/dataset.ts';
import { aggregate, score } from './search-engines/quality/metrics.ts';

export function evaluate(owner: (text: string) => string,
  messages: { id: string; body: string }[] = corpus(), cases: Query[] = queries) {
  const queryTexts = literal(JSON.stringify(cases.map(query => query.text)));
  const normalized: string[] = JSON.parse(owner(`
    SELECT json_agg(public.fukulow_search_normalize(value) ORDER BY position)
    FROM json_array_elements_text(${queryTexts}) WITH ORDINALITY AS raw(value, position);
  `));
  assert.equal(normalized.length, cases.length);
  const prepared = cases.map((query, index) => {
    // Rust's split_whitespace uses Unicode White_Space (including NEL).
    const tokens = normalized[index].split(/\p{White_Space}+/u).filter(Boolean);
    return { query, tokens, tooShort: !tokens.some(token => [...token].length >= 2) };
  });
  const eligible = prepared.filter(row => !row.tooShort).map(({ query, tokens }) => ({ id: query.id, tokens }));
  const candidateQueries = literal(JSON.stringify(eligible));
  const bodies = literal(JSON.stringify(messages));
  const found: Record<string, string[]> = JSON.parse(owner(`
    WITH normalized AS MATERIALIZED (
      SELECT id, public.fukulow_search_normalize(body) AS body
      FROM json_to_recordset(${bodies}) AS message(id text, body text)
    )
    SELECT coalesce(json_object_agg(query.id, ARRAY(
      SELECT message.id FROM normalized AS message
      WHERE NOT EXISTS (
        SELECT 1 FROM unnest(query.tokens) AS token
        WHERE strpos(message.body COLLATE pg_catalog."C", token) = 0
      )
    )), '{}')
    FROM json_to_recordset(${candidateQueries}) AS query(id text, tokens text[]);
  `));
  return prepared.map(({ query, tooShort }) => {
    const ids = tooShort ? [] : found[query.id];
    assert.ok(Array.isArray(ids), `Missing result for ${query.id}`);
    return { class: query.class, tooShort, ...score(query.gold, ids) };
  });
}

function markdown(rows: ReturnType<typeof evaluate>) {
  const line = (name: string, selected: typeof rows) => {
    const { tp, fp, fn, precision, recall, f1 } = aggregate(selected).micro;
    const rates = [precision, recall, f1].map(rate => rate.toFixed(3));
    return `| ${[name, tp, fp, fn, ...rates, selected.filter(row => row.tooShort).length].join(' | ')} |`;
  };
  return [
    'Frozen #153 quality set, d3r semantics. Earlier literal micro F1 was **0.639** (`docs/measurements.md`, #153).',
    '',
    '| Class | TP | FP | FN | Micro precision | Micro recall | Micro F1 | Too short |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.keys(classes).map(name => line(name, rows.filter(row => row.class === name))),
    line('Overall', rows),
    '',
  ].join('\n');
}

async function runWorker(scratch: string) {
  const container = ownedContainer();
  const volume = ownedVolume();
  assert.ok(container && volume, 'Missing supervised Docker resource names');
  const { id: image } = resolveImage(docker, 'fukulow-search-measure-153', true);
  const owner = (text: string) => sql(container, 'postgres', text);
  const migration = readFileSync(new URL('../server/migrations/202611210725_message_search.sql', import.meta.url), 'utf8');
  const normalize = migration.match(/^CREATE FUNCTION public\.fukulow_search_normalize\([\s\S]+?(?=\n\nCREATE FUNCTION public\.fukulow_search_terms\()/m)?.[0];
  assert.ok(normalize, 'Missing Search normalization function');

  docker('volume', 'create', '--label', ownershipLabel, volume);
  command('docker', ['run', '-d', '--label', ownershipLabel, '--name', container, '--shm-size=1g',
    '--mount', `type=volume,source=${volume},target=/var/lib/postgresql`, '-e', 'POSTGRES_PASSWORD',
    '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=postgres', image, ...postgresArguments],
  undefined, { ...process.env, POSTGRES_PASSWORD: randomUUID() });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'fukulow', '-d', 'postgres');
    } catch (error) {
      if (error instanceof CommandTimeoutError) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    assert.equal(owner('SHOW server_version_num;'), '180006', 'Expected PostgreSQL 18.6');
    owner(normalize);
    writeFileSync(`${scratch}/report.md`, markdown(evaluate(owner)));
    return;
  }
  throw new Error('PostgreSQL startup timed out');
}

if (import.meta.main) {
  if (process.env.SEARCH_WORKER === '1') {
    const scratch = process.env.SEARCH_D3R_QUALITY_DIR;
    assert.ok(scratch, 'Missing supervised artifact directory');
    await runWorker(scratch);
  } else {
    const { sha256 } = loadManifest();
    const scratch = mkdtempSync('/private/tmp/725-quality-d3r-');
    process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
    process.env.SEARCH_D3R_QUALITY_DIR = scratch;
    await supervise(import.meta.url, scratch, sha256);
    if (!process.exitCode) {
      const report = readFileSync(`${scratch}/report.md`, 'utf8');
      writeFileSync('/private/tmp/725-quality-d3r.md', report);
      process.stdout.write(report);
    }
  }
}
