import assert from 'node:assert/strict'
import { test } from 'node:test'
import { violations } from './check-local-context.ts'

test('allows literal local settings and read-only or unrelated settings', () => {
  for (const source of [
    "SET LOCAL fukulow.organization_id = 'x';",
    "set\n local fukulow.account_id TO 'x';",
    "SELECT set_config('fukulow.organization_id', $1, true);",
    "WITH context AS MATERIALIZED (SELECT set_config('fukulow.organization_id', $1::uuid::text, true)) SELECT * FROM context;",
    "SELECT SET_CONFIG(\n 'fukulow.organization_id',\n $1,\n TRUE\n);",
    "SELECT set_config('fukulow.organization_id', :org::text, true);",
    "SELECT set_config('lock_timeout', '10s', true);",
    "SELECT set_config('pg_stat_statements.track', 'top', true);",
    "SELECT set_config('fukulow.app_password', $1, true);",
    `format!("SELECT set_config('fukulow.{key}', $1, true)")`,
    "set_config('key', '', true)",
    "set_config('key', :org, true)",
    "SELECT set_config('lock_timeout', $1, true);",
    "SELECT current_setting('fukulow.organization_id', true);",
    'SET search_path = public;',
    'SET search_path = public; -- fukulow',
    'UPDATE accounts SET name = $1',
    'SET SESSION search_path = public',
    'SET (a, b) = (1, 2)',
    'RESET search_path;',
  ]) {
    assert.deepEqual(violations(source), [], source)
    assert.deepEqual(violations(`sqlx::query("${source}");`), [], source)
    assert.deepEqual(violations(`sqlx::query(r##"${source}"##);`), [], source)
  }
})

test('rejects round 2 split literals, executable bodies, Unicode names and dynamic keys', () => {
  for (const source of [
    `sqlx::query(concat!("SET ", "fukulow.organization_id = 'id'"));`,
    `sqlx::query(concat!("SET ",\n "fukulow.organization_id = 'id'"));`,
    "DO 'BEGIN SET fukulow.organization_id = ''id''; END';",
    `SET U&"fukulow.organization_id" = 'id';`,
    String.raw`SET U&"\0066ukulow.organization_id" = 'id';`,
    "set_config('fukulow.' || 'organization_id', v, false)",
  ]) assert.deepEqual(violations(source), [1], source)
})

test('rejects round 1 session settings, casts, escaped keys and dollar bodies', () => {
  for (const source of [
    "SET fukulow.organization_id = 'id';",
    "SET SESSION fukulow.account_id TO 'id';",
    `SET "fukulow.organization_id" = 'id';`,
    `SET "fukulow".x = 'id';`,
    `sEt /* comment */ SeSsIoN "fukulow"."organization_id" = 'id';`,
    "ALTER ROLE app SET fukulow.organization_id = 'id';",
    "ALTER DATABASE app SET fukulow.organization_id = 'id';",
    "SELECT set_config('fukulow.organization_id', $1, false);",
    "SELECT set_config('fukulow.organization_id', $1::uuid::text, false);",
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
    String.raw`sqlx::query("SET\nSESSION\tfukulow.organization_id = 'id'")`,
    "-- comment\rSET fukulow.organization_id = 'id';",
    "DO $$ BEGIN SET fukulow.organization_id = 'id'; END $$;",
  ]) {
    assert.deepEqual(violations(source), [1], source)
    assert.deepEqual(violations(`sqlx::query("${source}");`), [1], source)
    assert.deepEqual(violations(`sqlx::query(r#"${source}"#);`), [1], source)
  }
})

test('requires strict literal keys, simple values and literal true for every setting name', () => {
  for (const args of [
    "'lock_timeout', $1, false",
    "'fukulow.' || 'organization_id', v, false",
    "key(), nested($1, other($2, $3)), false",
    "'fukulow.account_id', concat($1, upper($2)), true",
    "'key'::text, $1, true",
    "('key'), $1, true",
    "'key' || '.name', $1, true",
    "'key', ($1), true",
    "'key', $1::text, true",
    "'key', $1::uuid::text || $2, true",
    "'key', 'x' || 'y', true",
    "'key', $1, true\v",
    "'key', $1, (true)",
    "'key', $1, true::boolean",
    "'key', $1, 'true'",
    "'key', $1, true /* comment */",
    "'key', $1, true OR false",
    "'key', $1, true_value",
    "'key', $1",
    "'key', $1,",
    "'key', $1, true, false",
    ', $1, true',
    "'key', , true",
  ]) assert.deepEqual(violations(`set_config(${args})`), [1], args)
  for (const source of ["set_config(", "set_config('key', $1, true", "set_config('key', nested($1, $2), true"]) {
    assert.deepEqual(violations(source), [1], source)
  }
  assert.deepEqual(violations('set_config(key($1, $2), nested($3, other($4)), true)'), [1])
  assert.deepEqual(violations('set_config(key, set_config(other, $1, false), true)'), [1])
})

test('rejects comment and argument-counter bypasses without stripping raw text', () => {
  for (const source of [
    "SELECT set_config/*comment*/(\n 'fukulow.organization_id',\n $1,\n false\n);",
    "set_config /*c*/ ('fukulow.organization_id', $1, false)",
    "set_config('fukulow.organization_id', $1 /*, true) */ , false)",
    "set_config('k', ' , true) ', false)",
    "set_config('k', /* comment */ $1, true)",
    "set_config('k', $1, /* comment */ true)",
    "set_config('k', $1, true /* comment */)",
    "set_config ('k', $1, true)",
    "set_config\n('k', $1, true)",
    'set_config',
    'pg_catalog.set_config',
    '"set_config"',
  ]) assert.deepEqual(violations(source), [1], source)
  assert.deepEqual(violations("pg_catalog.SET_CONFIG('k', $1, true)"), [])
  assert.deepEqual(violations('my_set_config'), [])
})

test('rejects all Unicode escape prefixes case-insensitively', () => {
  for (const source of ["SELECT U&'anything';", 'SELECT u&"anything";', "SET LOCAL U&'anything';"]) {
    assert.deepEqual(violations(source), [1], source)
  }
})

test('checks each SET independently without a distance limit', () => {
  assert.deepEqual(violations('SET'), [])
  assert.deepEqual(violations(`SET${' '.repeat(200)}fukulow`), [1])
  assert.deepEqual(violations(`SET${' '.repeat(201)}fukulow`), [1])
  assert.deepEqual(violations('SET locality fukulow'), [])
  assert.deepEqual(violations("SET LOCAL fukulow.account_id = 'x';\nSET fukulow.organization_id = 'x';"), [2])
})

test('rejects obscured SET targets and session-setting table access', () => {
  for (const source of [
    `SET /* ${'x'.repeat(500)} */ fukulow.organization_id = 'x'`,
    "SET -- long comment\n fukulow.organization_id = 'x'",
    "SET SESSION /* c */ fukulow.organization_id = 'x'",
    "SET\n\n  fukulow.organization_id = 'x'",
    "SET // comment\n fukulow.organization_id = 'x'",
    "SET 'fukulow.organization_id' = 'x'",
    "SET U&anything = 'x'",
    'SET $target = 1',
    String.raw`SET\nLOCAL fukulow.organization_id = 'x'`,
    "SET\\\n LOCAL fukulow.organization_id = 'x'",
    "UPDATE pg_settings SET setting = 'x' WHERE name = 'fukulow.organization_id'",
    'SELECT * FROM PG_SETTINGS',
  ]) assert.deepEqual(violations(source), [1], source)
})

test('ignores fukulow-prefixed identifiers that are not the setting namespace', () => {
  for (const source of [
    '"Set-Cookie" = String, description = "__Host-fukulow_session; Secure"',
    'must be set to a nonempty value".into());\n let origins = std::env::var("FUKULOW_WS_ALLOWED_ORIGINS");',
  ]) assert.deepEqual(violations(source), [], source)
  assert.deepEqual(violations('concat!("SET ", "fukulow", ".organization_id")'), [1])
})

test('documents accepted false positives: comments, inert strings and quoted punctuation', () => {
  for (const source of [
    '-- SET fukulow',
    '// SET fukulow',
    '/* SET fukulow */',
    `let explanation = "SET fukulow.organization_id";`,
    "SELECT 'SET fukulow.organization_id = ''id''';",
    "-- set_config('anything', $1, false)",
    "SELECT 'set_config(''anything'', $1, false)';",
    "SELECT set_config('key', 'a,b', true);",
    "SELECT set_config('key', ')', true);",
    'SET /* comment */ LOCAL fukulow.organization_id = 1;',
  ]) assert.deepEqual(violations(source), [1], source)
})

test('returns sorted unique physical line numbers for all matches', () => {
  assert.deepEqual(violations("\nSET U&\"fukulow.organization_id\" = 'id';\nset_config(key, $1, false);\nu&'value'"), [2, 3, 4])
  assert.deepEqual(violations('sqlx::query(r###"-- comment\nSET fukulow.organization_id = \'id\'"###)'), [2])
  assert.deepEqual(violations('sqlx::query("SELECT 1;\\\n   SET fukulow.organization_id = \'id\'")'), [2])
})
