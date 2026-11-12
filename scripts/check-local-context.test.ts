import assert from 'node:assert/strict'
import { test } from 'node:test'
import { violations } from './check-local-context.ts'

test('allows local context in Rust and SQL and unrelated settings', () => {
  for (const source of [
    "SET LOCAL fukulow.organization_id = 'id';",
    "set local fukulow.account_id TO 'id';",
    `sqlx::query("SELECT set_config('fukulow.organization_id', $1, true)").bind(id);`,
    "SELECT set_config('fukulow.account_id', concat('a,b', upper('c')), true);",
    "SET lock_timeout = '5s'; SELECT set_config('lock_timeout', '5s', false);",
    "SELECT set_config('fukulow.organization_id', $1, true); SELECT other($1, false);",
    "-- SET fukulow.organization_id = 'id';\n/* SET SESSION fukulow.account_id = 'id'; */",
  ]) assert.deepEqual(violations(source), [], source)
})

test('rejects session context in Rust and SQL, with case, comments and multiline arguments', () => {
  for (const sql of [
    "SET fukulow.organization_id = 'id';",
    "SET SESSION fukulow.account_id TO 'id';",
    'SET "fukulow.organization_id" = \'id\';',
    "SET\\nSESSION\\tfukulow.organization_id = 'id';",
    'sEt /* comment */ SeSsIoN "fukulow"."organization_id" = \'id\';',
    "SELECT set_config('fukulow.organization_id', $1, false);",
    "SELECT set_config('fukulow.account_id', 'a--b, c''d /* value */', false);",
    "SELECT set_config('fukulow.account_id', $1, (false)::boolean);",
    "SELECT SET_CONFIG(\n 'fukulow.account_id',\n concat('a,b', upper('c')),\n FALSE\n);",
  ]) {
    assert.deepEqual(violations(sql), [1], sql)
    assert.deepEqual(violations(`sqlx::query(r#"${sql}"#);`), [1], sql)
  }
})

test('reports every violation line without matching across calls', () => {
  assert.deepEqual(violations("\nSET fukulow.organization_id = 'id';\nSELECT set_config('fukulow.account_id', $1, false);"), [2, 3])
})
