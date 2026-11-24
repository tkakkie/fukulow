import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
