import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// Test-side check that a harness's provenance list hashes every local module it imports. It uses
// the TypeScript preprocessor and parser (already a load/ devDependency) so commented-out imports do
// not count, and it stays out of provenance.ts so a harness at run time never loads the compiler.

const local = (specifier: string) => specifier.startsWith('./') || specifier.startsWith('../');
const toRepo = (root: string, full: string) => relative(root, full).split(sep).join(posix.sep);
const script = (full: string) => /\.[cm]?[jt]sx?$/.test(full);
const isFile = (full: string) => existsSync(full) && statSync(full).isFile();

// An `import.meta` use that loads no file: `import.meta.main`, `createRequire(import.meta.url)` (its
// require calls are imports), and an entry-point comparison such as
// `process.argv[1] === import.meta.filename` or `=== fileURLToPath(import.meta.url)`.
function loadsNothing(access: ts.PropertyAccessExpression) {
  if (access.name.text === 'main') return true;
  let use: ts.Node = access;
  if (ts.isCallExpression(use.parent) && ts.isIdentifier(use.parent.expression)) {
    if (use.parent.expression.text === 'createRequire') return true;
    if (use.parent.expression.text === 'fileURLToPath') use = use.parent;
  }
  const parent = use.parent;
  return ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind);
}

// Files `file` loads through `new URL('<literal>', import.meta.url)`. Any other `import.meta` use that
// could name a file (a non-literal URL, `import.meta.dirname`, `import.meta.url` passed on) throws, and
// so does a URL that names a directory or nothing: the walker cannot see what such a form loads, so
// the harness must use the literal form or the walker must learn the new one.
function metaFileLoads(file: string, source: string, root: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const fail = (node: ts.Node, why: string): never => {
    const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
    throw new Error(`${toRepo(root, file)}:${line} ${why}: ${node.getText(parsed)}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && ts.isPropertyAccessExpression(node.parent)) {
      const access = node.parent, use = access.parent;
      if (access.name.text === 'url' && ts.isNewExpression(use) && ts.isIdentifier(use.expression) && use.expression.text === 'URL'
        && use.arguments?.length === 2 && use.arguments[1] === access) {
        const target = use.arguments[0]!;
        if (!ts.isStringLiteral(target) && !ts.isNoSubstitutionTemplateLiteral(target)) return fail(use, 'loads a file the provenance walker cannot resolve');
        const full = fileURLToPath(new URL(target.text, pathToFileURL(file)));
        if (!isFile(full)) fail(use, 'names a directory or a missing file, which the provenance walker cannot hash');
        found.push(full);
      } else if (!loadsNothing(access)) fail(access, 'may load a file the provenance walker cannot resolve');
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

// Every local file `entries` reach, transitively, as sorted repository-relative paths: modules through
// static, type-only, re-export, literal dynamic or require imports, and files through
// `new URL('<literal>', import.meta.url)`. Script files are walked in turn. The entries themselves are
// not included. An import that does not resolve to a file throws,
// and so does an `import.meta` form the walker cannot resolve (see metaFileLoads). Files a harness
// reads through a working-directory path (for example `readFileSync('compose.yml')`) are not seen.
export function localImports(entries: string | readonly string[], root = process.cwd()): string[] {
  const starts = (typeof entries === 'string' ? [entries] : entries).map(entry => resolve(root, entry));
  const seen = new Set<string>();
  const pending = [...starts];
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    const targets: string[] = [];
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!local(fileName)) continue;
      const target = resolve(dirname(file), fileName);
      if (!isFile(target)) throw new Error(`${toRepo(root, file)} imports a missing module: ${fileName}`);
      targets.push(target);
    }
    if (script(file)) targets.push(...metaFileLoads(file, source, root));
    for (const target of targets) {
      if (!starts.includes(target)) seen.add(target);
      if (script(target)) pending.push(target);
    }
  }
  return [...seen].map(full => toRepo(root, full)).sort();
}

// The entries and the local files they reach that `list` does not contain, sorted.
export function missingFromProvenance(entries: string | readonly string[], list: readonly string[], root = process.cwd()): string[] {
  const listed = new Set(list);
  const all = new Set([...(typeof entries === 'string' ? [entries] : entries), ...localImports(entries, root)]);
  return [...all].filter(path => !listed.has(path)).sort();
}
