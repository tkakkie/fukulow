import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { checkProtocolImports } from './protocol-imports.ts'

const generatedTypes = [{ path: './api-schema', typeOnly: true }]
function imports(source: string) {
  return ts.createSourceFile('protocol.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    .statements.filter(ts.isImportDeclaration).map(node => ({
      path: ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null,
      typeOnly: node.importClause?.isTypeOnly === true,
    }))
}

describe('protocol direct-import scan (not transitive purity)', () => {
  it('rejects svelte and every svelte subpath with negative controls', () => {
    for (const path of ['svelte', 'svelte/reactivity', 'svelte/store', 'svelte/internal/client']) {
      for (const source of [`import { x } from '${path}'`, `import '${path}'`, `export * from '${path}'`,
        `const x = import('${path}')`, `type X = import('${path}').X`, `const x = require('${path}')`,
        `import x = require('${path}')`]) expect(checkProtocolImports(source), source).toEqual([`protocol.ts directly imports ${path}`])
    }
  })
  it('allows generated types and ignores comments and unrelated string literals', () => {
    expect(checkProtocolImports(`import type { components } from './api-schema';
      // import 'svelte'
      const text = "import 'svelte/store'"`)).toEqual([])
  })
  it('the production protocol passes the direct-import scan and imports generated types only', () => {
    const source = readFileSync(new URL('../src/protocol.ts', import.meta.url), 'utf8')
    expect(checkProtocolImports(source)).toEqual([])
    expect(imports(source)).toEqual(generatedTypes)
    expect(source).not.toMatch(/\b(?:Date|performance|crypto|fetch|WebSocket|setTimeout|setInterval)\b|Math\.random/)
  })
  it('generated-types-only assertion rejects additional multiline imports with negative controls', () => {
    const allowed = `import type {
      components, ServerEvent,
    } from './api-schema'`
    expect(imports(allowed)).toEqual(generatedTypes)
    for (const extra of [`import {
      step,
    } from './other'`, `import type {
      Other,
    } from './other'`, `import './side-effect'`]) {
      expect(imports(`${allowed}\n${extra}`)).not.toEqual(generatedTypes)
    }
    expect(imports(`import {
      components,
    } from './api-schema'`)).not.toEqual(generatedTypes)
  })
})
