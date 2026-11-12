import assert from 'node:assert/strict'
import { test } from 'node:test'
import { violations } from './check-local-context.ts'

test('allows local context and unrelated settings in SQL and decoded Rust literals', () => {
  for (const sql of [
    "SET LOCAL fukulow.organization_id = 'id';",
    "-- comment\nSET LOCAL fukulow.organization_id = 'id';",
    "set local fukulow.account_id TO 'id';",
    "SELECT set_config('fukulow.organization_id'::text, $1, true);",
    "SELECT set_config('fukulow.account_id', concat('a,b', upper('c')), true);",
    "SELECT set_config('fukulow.account_id', concat(')', 'true'), true);",
    "SELECT set_config('fukulow.account_id', ',', true);",
    "SELECT set_config('fukulow.account_id', $$), true$$, true);",
    "SET lock_timeout = '5s'; SELECT set_config('lock_timeout', '5s', false);",
    "SELECT set_config('fukulow.organization_id', $1, (true)::pg_catalog.boolean); SELECT other($1, false);",
    "-- SET fukulow.organization_id = 'id';\n/* SET SESSION fukulow.account_id = 'id'; */",
    "SELECT 'SET fukulow.organization_id = ''id''';",
    "SELECT 'set_config(''fukulow.organization_id'', $1, false)';",
    "SELECT 'it''s -- inert'; /* outer /* nested */ SET fukulow.account_id = 'id' */",
    "SELECT '-- comment';\nSET LOCAL fukulow.organization_id = 'id';",
  ]) {
    assert.deepEqual(violations(sql), [], sql)
    assert.deepEqual(violations(`sqlx::query(${JSON.stringify(sql)});`, 'rust'), [], sql)
    assert.deepEqual(violations(`sqlx::query(r##"${sql}"##);`, 'rust'), [], sql)
  }
})

test('rejects executable session settings with comments, casts and multiline arguments', () => {
  for (const sql of [
    "SET fukulow.organization_id = 'id';",
    "SET SESSION fukulow.account_id TO 'id';",
    'SET "fukulow.organization_id" = \'id\';',
    'sEt /* comment */ SeSsIoN "fukulow"."organization_id" = \'id\';',
    "SELECT set_config('fukulow.organization_id', $1, false);",
    "SELECT set_config('fukulow.organization_id'::text, $1, false);",
    "SELECT set_config(('fukulow.account_id')::pg_catalog.text, $1, false);",
    "SELECT set_config(CAST('fukulow.account_id' AS text), $1, false);",
    "SELECT set_config('fukulow.account_id', 'a--b, c''d /* value */', false);",
    "SELECT set_config('fukulow.account_id', concat(')', 'true'), false);",
    "SELECT set_config('fukulow.account_id', $$), true$$, false);",
    "SELECT set_config('fukulow.account_id', $1, (false)::boolean);",
    "SELECT SET_CONFIG(\n 'fukulow.account_id',\n concat('a,b', upper('c')),\n FALSE\n);",
    "SELECT set_config('fukulow.organization_id', $1, $2);",
    "SELECT set_config($1, $2, false);",
    String.raw`SELECT set_config(E'\x66ukulow.organization_id', $1, false);`,
    "-- comment\rSET fukulow.organization_id = 'id';",
    "DO $$ BEGIN SET fukulow.organization_id = 'id'; END $$;",
  ]) {
    assert.deepEqual(violations(sql), [1], sql)
    assert.deepEqual(violations(`sqlx::query(${JSON.stringify(sql)});`, 'rust'), [1], sql)
    assert.deepEqual(violations(`sqlx::query(r#"${sql}"#);`, 'rust'), [1], sql)
  }
})

test('decodes Rust escapes before SQL comments and preserves physical diagnostic lines', () => {
  assert.deepEqual(violations(String.raw`sqlx::query("-- comment\nSET fukulow.organization_id = 'id'")`, 'rust'), [1])
  assert.deepEqual(violations(String.raw`sqlx::query("SET\nSESSION\tfukulow.organization_id = 'id'")`, 'rust'), [1])
  assert.deepEqual(violations(String.raw`sqlx::query("\x53ET fukulow.\u{6f}rganization_id = 'id'")`, 'rust'), [1])
  assert.deepEqual(violations('sqlx::query(r###"-- comment\nSET fukulow.organization_id = \'id\'"###)', 'rust'), [2])
  assert.deepEqual(violations('sqlx::query("SELECT 1;\\\n   SET fukulow.organization_id = \'id\'")', 'rust'), [2])
})

test('separates Rust comments, character literals, raw strings and SQL tokens', () => {
  const source = String.raw`
// sqlx::query("SET fukulow.organization_id = 'id'");
/* outer /* nested */ "SET fukulow.account_id = 'id'" */
let quote = '"';
let apostrophe = '\'';
let lifetime: &'static str = "SELECT 'SET fukulow.organization_id = ''id''';";
sqlx::query(r#"SELECT '/*'; -- comment
SET LOCAL fukulow.organization_id = 'id'"#);
sqlx::query("-- comment\nSELECT set_config('fukulow.organization_id'::text, $1, false)");
`
  assert.deepEqual(violations(source, 'rust'), [9])
})

test('reports every violation line without matching across calls', () => {
  assert.deepEqual(violations("\nSET fukulow.organization_id = 'id';\nSELECT set_config('fukulow.account_id', $1, false);"), [2, 3])
})

test('documents conservative matches for non-query Rust strings and dollar bodies', () => {
  assert.deepEqual(violations('let explanation = "SET fukulow.organization_id";', 'rust'), [1])
  assert.deepEqual(violations("SELECT $$SET fukulow.organization_id = 'id'$$;"), [1])
  assert.deepEqual(violations(String.raw`SELECT set_config(E'lock\x5ftimeout', '5s', false);`), [1])
})
