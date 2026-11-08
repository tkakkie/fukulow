// Web boundary (docs: AGENTS.md Rules / #29): network access only in the API layer, and
// no web storage that could hold credentials. Found by parsing code, not by text search.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'svelte/compiler'
import ts from 'typescript'

/** The only files that may open connections (the API layer). */
export const NETWORK_FILES = ['src/api.ts', 'src/realtime.ts']
/** The only file that may touch web storage: a small helper for harmless UI settings. */
export const STORAGE_FILES = ['src/ui-settings.ts']

const NETWORK = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'])
const STORAGE = new Set(['localStorage', 'sessionStorage', 'indexedDB', 'cookieStore'])
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self'])

export type Violation = { file: string; line: number; message: string }

/** Classifies a reference to `name` (optionally as a member of `owner`). */
function classify(name: string, owner?: string): string | undefined {
  if (owner === 'document' && name === 'cookie') return 'document.cookie'
  if (owner !== undefined && !GLOBAL_OBJECTS.has(owner)) return undefined
  if (NETWORK.has(name) || STORAGE.has(name)) return name
  return undefined
}

/** Owner name of a member access: `window`, `document`, also `window.document`. */
function ownerOfMember(objectOwner: string | undefined, name: string | undefined): string | undefined {
  if (!objectOwner || !name || !GLOBAL_OBJECTS.has(objectOwner)) return undefined
  return GLOBAL_OBJECTS.has(name) || name === 'document' ? name : undefined
}

function allowed(use: string, file: string): boolean {
  if (NETWORK.has(use)) return NETWORK_FILES.includes(file)
  return STORAGE_FILES.includes(file)
}

function message(use: string): string {
  return NETWORK.has(use)
    ? `\`${use}\` is only allowed in ${NETWORK_FILES.join(' / ')} (network layer)`
    : `\`${use}\` is only allowed in ${STORAGE_FILES.join(', ')} (UI settings helper; never credentials)`
}

function lineAt(src: string, pos: number): number {
  return src.slice(0, pos).split('\n').length
}

/** Strips parentheses, `as` / `<T>` casts, `satisfies` and `!` so the real expression is checked. */
function unwrapTs(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isSatisfiesExpression(e)
  )
    e = e.expression
  return e
}

function ownerTs(e: ts.Expression): string | undefined {
  e = unwrapTs(e)
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return ownerOfMember(ownerTs(e.expression), e.name.text)
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
    return ownerOfMember(ownerTs(e.expression), e.argumentExpression.text)
  return undefined
}

function scanTs(src: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const out: Violation[] = []
  const report = (use: string, node: ts.Node) => {
    if (!allowed(use, file))
      out.push({ file, line: lineAt(src, node.getStart(sf)), message: message(use) })
  }
  const visit = (node: ts.Node) => {
    const parent = node.parent
    if (ts.isPropertyAccessExpression(node)) {
      const owner = ownerTs(node.expression)
      const use = classify(node.name.text, owner)
      if (use && owner) report(use, node)
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const owner = ownerTs(node.expression)
      const use = classify(node.argumentExpression.text, owner)
      if (use && owner) report(use, node)
    } else if (ts.isIdentifier(node)) {
      const isMemberName = parent && ts.isPropertyAccessExpression(parent) && parent.name === node
      const isTypeUse = parent && (ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent))
      const isDeclName =
        parent &&
        !ts.isShorthandPropertyAssignment(parent) &&
        'name' in parent &&
        (parent as { name?: ts.Node }).name === node &&
        !ts.isPropertyAccessExpression(parent)
      if (!isMemberName && !isTypeUse && !isDeclName) {
        const use = classify(node.text)
        if (use) report(use, node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const SKIP_TYPES = new Set([
  'TSTypeAnnotation',
  'TSTypeQuery',
  'TSTypeReference',
  'TSTypeParameterInstantiation',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
])

type Node = { type?: string; start?: number; [k: string]: unknown }

const SVELTE_WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'ParenthesizedExpression'])

function ownerSvelte(e: Node): string | undefined {
  while (e.type && SVELTE_WRAPPERS.has(e.type) && e.expression) e = e.expression as Node
  if (e.type === 'Identifier') return e.name as string
  if (e.type === 'MemberExpression') {
    const prop = e.property as Node
    const name = !e.computed && prop.type === 'Identifier' ? (prop.name as string) : prop.type === 'Literal' && typeof prop.value === 'string' ? prop.value : undefined
    return ownerOfMember(ownerSvelte(e.object as Node), name)
  }
  return undefined
}

function scanSvelte(src: string, file: string): Violation[] {
  const out: Violation[] = []
  const report = (use: string, node: Node) => {
    if (!allowed(use, file)) out.push({ file, line: lineAt(src, node.start ?? 0), message: message(use) })
  }
  const seen = new WeakSet<object>()
  const visit = (node: unknown, parent: Node | undefined, key: string) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const n of node) visit(n, parent, key)
      return
    }
    const n = node as Node
    if (n.type && SKIP_TYPES.has(n.type)) return
    if (n.type === 'MemberExpression') {
      const obj = n.object as Node
      const prop = n.property as Node
      const owner = ownerSvelte(obj)
      const name = !n.computed && prop.type === 'Identifier' ? (prop.name as string) : prop.type === 'Literal' && typeof prop.value === 'string' ? prop.value : undefined
      if (owner && name) {
        const use = classify(name, owner)
        if (use) report(use, n)
      }
      visit(obj, n, 'object')
      if (n.computed) visit(prop, n, 'property')
      return
    }
    if (n.type === 'Identifier') {
      const isDecl = key === 'id' || key === 'params' || (parent?.type === 'Property' && key === 'key' && !parent.computed)
      if (!isDecl) {
        const use = classify(n.name as string)
        if (use) report(use, n)
      }
      return
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'parent') visit(v, n, k)
  }
  visit(parse(src, { modern: true }), undefined, '')
  return out
}

/** Scans one source file (`file` is relative to web/, e.g. `src/App.svelte`). */
export function scanSource(src: string, file: string): Violation[] {
  if (file.endsWith('.svelte')) return scanSvelte(src, file)
  return scanTs(src, file)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Scans web/src (tests excluded: they are test code, not shipped). */
export function scanWeb(webDir: string): Violation[] {
  const out: Violation[] = []
  for (const p of walk(join(webDir, 'src'))) {
    const file = relative(webDir, p).split('\\').join('/')
    if (!/\.(ts|svelte|js)$/.test(file) || /\.(test|spec)\.ts$/.test(file) || file.endsWith('.d.ts')) continue
    out.push(...scanSource(readFileSync(p, 'utf8'), file))
  }
  return out
}
