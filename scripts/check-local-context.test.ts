import assert from 'node:assert/strict'
import { test } from 'node:test'
import { violations } from './check-local-context.ts'

test('allows literal local settings and read-only or unrelated settings', () => {
  for (const source of [
    "SET LOCAL fukulow.organization_id = 'x';",
    "set\n local fukulow.account_id TO 'x';",
    "SELECT set_config('fukulow.organization_id', $1, true);",
    "SELECT SET_CONFIG(\n 'fukulow.organization_id',\n $1,\n TRUE\n);",
    "SELECT set_config('fukulow.account_id', concat($1, upper($2)), true);",
    "SELECT set_config('lock_timeout', $1, true);",
    "SELECT current_setting('fukulow.organization_id', true);",
    'SET search_path = public;',
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
    `sEt /* comment */ SeSsIoN "fukulow"."organization_id" = 'id';`,
    "ALTER ROLE app SET fukulow.organization_id = 'id';",
    "ALTER DATABASE app SET fukulow.organization_id = 'id';",
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
    String.raw`sqlx::query("SET\nSESSION\tfukulow.organization_id = 'id'")`,
    "-- comment\rSET fukulow.organization_id = 'id';",
    "DO $$ BEGIN SET fukulow.organization_id = 'id'; END $$;",
  ]) {
    assert.deepEqual(violations(source), [1], source)
    assert.deepEqual(violations(`sqlx::query("${source}");`), [1], source)
    assert.deepEqual(violations(`sqlx::query(r#"${source}"#);`), [1], source)
  }
})

test('requires exactly three arguments and literal true for every setting name', () => {
  for (const args of [
    "'lock_timeout', $1, false",
    "'fukulow.' || 'organization_id', v, false",
    "key(), nested($1, other($2, $3)), false",
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
  assert.deepEqual(violations('set_config(key($1, $2), nested($3, other($4)), true)'), [])
  assert.deepEqual(violations('set_config(key, set_config(other, $1, false), true)'), [1])
})

test('rejects all Unicode escape prefixes case-insensitively', () => {
  for (const source of ["SELECT U&'anything';", 'SELECT u&"anything";', "SET LOCAL U&'anything';"]) {
    assert.deepEqual(violations(source), [1], source)
  }
})

test('checks each SET independently within the 200-character window', () => {
  assert.deepEqual(violations(`SET${' '.repeat(200)}fukulow`), [1])
  assert.deepEqual(violations(`SET${' '.repeat(201)}fukulow`), [])
  assert.deepEqual(violations('SET locality fukulow'), [1])
  assert.deepEqual(violations("SET LOCAL fukulow.account_id = 'x';\nSET fukulow.organization_id = 'x';"), [2])
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
    'SET search_path = public; -- fukulow',
    'SET /* comment */ LOCAL fukulow.organization_id = 1;',
  ]) assert.deepEqual(violations(source), [1], source)
})

test('returns sorted unique physical line numbers for all matches', () => {
  assert.deepEqual(violations("\nSET U&\"fukulow.organization_id\" = 'id';\nset_config(key, $1, false);\nu&'value'"), [2, 3, 4])
  assert.deepEqual(violations('sqlx::query(r###"-- comment\nSET fukulow.organization_id = \'id\'"###)'), [2])
  assert.deepEqual(violations('sqlx::query("SELECT 1;\\\n   SET fukulow.organization_id = \'id\'")'), [2])
})
