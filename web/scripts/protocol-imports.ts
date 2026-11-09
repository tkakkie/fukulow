// Direct-import scan only: this does not prove transitive purity of arbitrary dependencies.
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function checkProtocolImports(source: string): string[] {
  const file = ts.createSourceFile('protocol.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const errors: string[] = []
  const check = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node) && (node.text === 'svelte' || node.text.startsWith('svelte/'))) {
      errors.push(`protocol.ts directly imports ${node.text}`)
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) check(node.moduleReference.expression)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) check(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(file)
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const errors = checkProtocolImports(readFileSync(resolve(import.meta.dirname, '../src/protocol.ts'), 'utf8'))
  if (errors.length) { errors.forEach(e => console.error(e)); process.exit(1) }
  console.log('protocol direct-import scan OK')
}
