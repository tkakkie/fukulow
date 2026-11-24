import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { localImports, missingFromProvenance } from './provenance-coverage.ts';

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'harness-coverage-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const harness = {
  'load/run.ts': [
    "import { a } from './a.ts';",
    "import type { T } from '../web/src/types.ts';",
    "export * from './re.ts';",
    "import './side.ts';",
    "const lazy = await import('./lazy.ts');",
    "const require = createRequire(import.meta.url);",
    "const required = require('./required.json');",
    "// import { old } from './commented.ts';",
    "import { spawn } from 'node:child_process';",
    "import k6 from 'k6/http';",
    "const url = 'http://example.test/./not-an-import.ts';",
  ].join('\n'),
  'load/a.ts': "import { b } from './core/b.ts';\nimport { run } from './run.ts';",
  'load/core/b.ts': "import { a } from '../a.ts';\nimport data from './data.json' with { type: 'json' };",
  'load/core/data.json': '{}',
  'web/src/types.ts': 'export type T = 1;',
  'load/re.ts': '', 'load/side.ts': '', 'load/lazy.ts': '', 'load/required.json': '{}',
};

test('local imports follow static, type-only, re-export, side-effect, dynamic and require imports transitively', () => {
  const root = tree(harness);
  assert.deepEqual(localImports('load/run.ts', root), ['load/a.ts', 'load/core/b.ts', 'load/core/data.json', 'load/lazy.ts',
    'load/re.ts', 'load/required.json', 'load/side.ts', 'web/src/types.ts']);
});

test('package, node: and commented-out imports are not local modules; cycles end', () => {
  const root = tree(harness);
  const found = localImports('load/run.ts', root);
  for (const absent of ['load/commented.ts', 'load/run.ts', 'node:child_process', 'k6/http']) assert.ok(!found.includes(absent), absent);
});

test('an import that does not resolve to a file throws', () => {
  const root = tree({ 'load/run.ts': "import { x } from './gone.ts';" });
  assert.throws(() => localImports('load/run.ts', root), /load\/run\.ts imports a missing module: \.\/gone\.ts/);
  const dir = tree({ 'load/run.ts': "import x from './dir';", 'load/dir/index.ts': '' });
  assert.throws(() => localImports('load/run.ts', dir), /missing module: \.\/dir/);
});

test('a provenance list lacking the entry or any local module it imports is reported', () => {
  const root = tree(harness);
  const complete = ['load/run.ts', ...localImports('load/run.ts', root)];
  assert.deepEqual(missingFromProvenance('load/run.ts', complete, root), []);
  assert.deepEqual(missingFromProvenance('load/run.ts', complete.filter(p => p !== 'load/core/b.ts'), root), ['load/core/b.ts']);
  assert.deepEqual(missingFromProvenance('load/run.ts', complete.filter(p => p !== 'load/run.ts'), root), ['load/run.ts']);
  assert.deepEqual(missingFromProvenance('load/run.ts', ['load/compose.yml'], root), ['load/run.ts', ...localImports('load/run.ts', root)].sort());
});

const metaHarness = {
  'load/run.ts': [
    "import { fileURLToPath } from 'node:url';",
    "const sql = readFileSync(new URL('./query.sql', import.meta.url), 'utf8');",
    "const child = fileURLToPath(new URL(`./child.ts`, import.meta.url));",
    "const require = createRequire(import.meta.url);",
    "if (import.meta.main) run();",
    "if (process.argv[1] === import.meta.filename) run();",
    "if (process.argv[1] !== fileURLToPath(import.meta.url)) skip();",
  ].join('\n'),
  'load/query.sql': 'SELECT 1;',
  'load/child.ts': "const patch = readFileSync(new URL('../deploy/patch.diff', import.meta.url));",
  'deploy/patch.diff': '',
};

test('files loaded through a literal new URL(..., import.meta.url) count, and script targets are walked', () => {
  const root = tree(metaHarness);
  assert.deepEqual(localImports('load/run.ts', root), ['deploy/patch.diff', 'load/child.ts', 'load/query.sql']);
  assert.deepEqual(missingFromProvenance('load/run.ts', ['load/run.ts', 'load/child.ts', 'deploy/patch.diff'], root), ['load/query.sql']);
});

test('an import.meta form the walker cannot resolve fails loudly instead of being skipped', () => {
  const cases: [string, RegExp][] = [
    ["const f = readFileSync(new URL(name, import.meta.url));", /load\/run\.ts:1 loads a file the provenance walker cannot resolve: new URL\(name, import\.meta\.url\)/],
    ["const f = readFileSync(new URL(`./${name}.sql`, import.meta.url));", /cannot resolve: new URL/],
    ["\nconst dir = new URL('./', import.meta.url);", /load\/run\.ts:2 names a directory or a missing file/],
    ["const f = new URL('./gone.sql', import.meta.url);", /names a directory or a missing file/],
    ["const f = readFileSync(resolve(import.meta.dirname, 'x.sql'));", /may load a file the provenance walker cannot resolve: import\.meta\.dirname/],
    ["supervise(import.meta.url);", /may load a file .*: import\.meta\.url/],
    ["const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');", /may load a file .*: import\.meta\.url/],
    ["const f = readFileSync(new URL('./query.sql', import.meta['url']));", /load\/run\.ts:1 may load a file .*: import\.meta\['url'\]/],
    ["const f = readFileSync(new URL('./query.sql', (import.meta).url));", /may load a file .*: \(import\.meta\)/],
    ["const { url } = import.meta;", /may load a file .*: \{ url \} = import\.meta/],
  ];
  for (const [source, error] of cases) assert.throws(() => localImports('load/run.ts', tree({ 'load/run.ts': source })), error, source);
});

test('several entries are walked together and each entry must be listed', () => {
  const root = tree({ 'load/a.ts': "import './shared.ts';", 'load/b.ts': "import './only-b.ts';", 'load/shared.ts': '', 'load/only-b.ts': '' });
  assert.deepEqual(localImports(['load/a.ts', 'load/b.ts'], root), ['load/only-b.ts', 'load/shared.ts']);
  assert.deepEqual(missingFromProvenance(['load/a.ts', 'load/b.ts'], ['load/a.ts', 'load/shared.ts'], root), ['load/b.ts', 'load/only-b.ts']);
});

// The real `load/record.ts` provenance list, read from its source: the string array that
// `harness: Object.fromEntries([...].map(...))` hashes.
const checkout = resolve(import.meta.dirname, '../..');
function recordList(): string[] {
  const source = ts.createSourceFile('record.ts', readFileSync(join(checkout, 'load/record.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  let list: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'harness') {
      const array = node.initializer.getChildren(source).flatMap(function all(n): ts.Node[] { return [n, ...n.getChildren(source).flatMap(all)]; })
        .find(ts.isArrayLiteralExpression);
      list = array?.elements.map(e => { assert.ok(ts.isStringLiteral(e), e.getText(source)); return e.text; });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(list && list.length > 0, 'load/record.ts harness list not found');
  return list;
}

test('the real load/record.ts provenance list covers everything record.ts reaches, and dropping any reached entry is reported', () => {
  const list = recordList();
  assert.deepEqual(missingFromProvenance('load/record.ts', list, checkout), []);
  const reached = ['load/record.ts', ...localImports('load/record.ts', checkout)];
  assert.ok(reached.length > 5, reached.join(' '));
  for (const path of reached) assert.deepEqual(missingFromProvenance('load/record.ts', list.filter(p => p !== path), checkout), [path], path);
});

test('the k6 scripts record.ts runs are covered too, apart from the two gaps pinned here until record.ts next changes', () => {
  // record.ts runs LOAD_SCRIPT (load/scenario.ts by default, or load/throughput.ts) in k6; they import
  // load/scheduler.ts and more, which record.ts never imports itself. The pinned gaps are real: add
  // them to the list when record.ts next changes (#866 adoption rule) and empty this array.
  const entries = ['load/record.ts', 'load/scenario.ts', 'load/throughput.ts'];
  const gaps = ['load/events.ts', 'web/src/api-schema.d.ts'];
  const list = recordList();
  assert.deepEqual(missingFromProvenance(entries, list, checkout), gaps);
  for (const path of ['load/scheduler.ts', 'load/scenario.ts', 'load/seed.ts', 'web/src/reconnect.ts'])
    assert.deepEqual(missingFromProvenance(entries, list.filter(p => p !== path), checkout), [...gaps, path].sort(), path);
});
