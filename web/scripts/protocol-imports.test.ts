import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkProtocolImports } from './protocol-imports.ts'

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
    expect(source.match(/^import .* from .+$/gm)).toEqual(["import type { components, ServerEvent } from './api-schema'"])
    expect(source).not.toMatch(/\b(?:Date|performance|crypto|fetch|WebSocket|setTimeout|setInterval)\b|Math\.random/)
  })
})
