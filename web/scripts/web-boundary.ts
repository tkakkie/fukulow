// Web boundary (docs: AGENTS.md Rules / #29, #48): network access only in the API layer, and
// no web storage that could hold credentials. Found by parsing code, not by text search.
//
// Detected (per file, by name; no scope analysis):
//   - network: fetch, XMLHttpRequest, WebSocket, EventSource, Worker, SharedWorker, navigator.sendBeacon;
//     allowed only in NETWORK_FILES. Workers are forbidden elsewhere because they can hold
//     communication this scan cannot see; when a real need appears, allow it and scan the Worker script.
//   - storage: localStorage, sessionStorage, indexedDB, cookieStore, document.cookie; forbidden everywhere
//     until a ui-settings helper exists (its exemption must land with a typed key/value allow-list guard).
//   - forms: bare name (`const f = fetch`), member of window / globalThis / self (also chained, cast,
//     `!`, parenthesised), string-literal or constant-concatenation keys (`window['local' + 'Storage']`),
//     and aliases of those objects, document or navigator (`const w = window; w.fetch()`).
//   - files: .ts .mts .cts .tsx .js .mjs .cjs .jsx and .svelte (instance, module and template).
//     Out of scope: tests (*.test.* / *.spec.*), .d.ts, non-code files, files outside web/src.
// Known limits: no dynamic keys (`window[k]`), destructuring (`const { fetch } = window`), aliases through
// functions, properties, parameters or reassignment, `import()`/`eval`, `Reflect`, other APIs (e.g. service
// workers, form posts, <img>/<script> loads), and no scoping (an alias name counts for the whole file).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'svelte/compiler'
import ts from 'typescript'

/** The only files that may open connections (the API layer). */
export const NETWORK_FILES = ['src/api.ts', 'src/realtime.ts']

const NETWORK = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'navigator.sendBeacon'])
const STORAGE = new Set(['localStorage', 'sessionStorage', 'indexedDB', 'cookieStore'])
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self'])
/** Objects whose members matter, so aliases of them are tracked. */
const TRACKED = new Set([...GLOBAL_OBJECTS, 'document', 'navigator'])

export type Violation = { file: string; line: number; message: string }

/** Classifies a reference to `name` (optionally as a member of `owner`). */
function classify(name: string, owner?: string): string | undefined {
  if (owner === 'document' && name === 'cookie') return 'document.cookie'
  if (owner === 'navigator' && name === 'sendBeacon') return 'navigator.sendBeacon'
  if (owner !== undefined && !GLOBAL_OBJECTS.has(owner)) return undefined
  if (NETWORK.has(name) || STORAGE.has(name)) return name
  return undefined
}

/** Owner name of a member access: `window`, `document`, also `window.document`. */
function ownerOfMember(objectOwner: string | undefined, name: string | undefined): string | undefined {
  if (!objectOwner || !name || !GLOBAL_OBJECTS.has(objectOwner)) return undefined
  return TRACKED.has(name) ? name : undefined
}

function allowed(use: string, file: string): boolean {
  return NETWORK.has(use) && NETWORK_FILES.includes(file)
}

function message(use: string): string {
  return NETWORK.has(use)
    ? `\`${use}\` is only allowed in ${NETWORK_FILES.join(' / ')} (network layer)`
    : `\`${use}\` is forbidden: web storage is not allowed until the ui-settings helper exists (never credentials)`
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

/** Value of a string literal or a `+` concatenation of them; undefined when not statically known. */
function constStrTs(e: ts.Expression): string | undefined {
  e = unwrapTs(e)
  if (ts.isStringLiteralLike(e)) return e.text
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = constStrTs(e.left)
    const r = constStrTs(e.right)
    return l !== undefined && r !== undefined ? l + r : undefined
  }
  return undefined
}

type Aliases = Map<string, string>

function ownerTs(e: ts.Expression, aliases: Aliases): string | undefined {
  e = unwrapTs(e)
  if (ts.isIdentifier(e)) return aliases.get(e.text) ?? e.text
  if (ts.isPropertyAccessExpression(e)) return ownerOfMember(ownerTs(e.expression, aliases), e.name.text)
  if (ts.isElementAccessExpression(e))
    return ownerOfMember(ownerTs(e.expression, aliases), constStrTs(e.argumentExpression))
  return undefined
}

/** `const w = window` style aliases, resolved to a fixed point so declaration order does not matter. */
function aliasesTs(sf: ts.SourceFile): Aliases {
  const decls: ts.VariableDeclaration[] = []
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) decls.push(n)
    ts.forEachChild(n, collect)
  }
  collect(sf)
  const aliases: Aliases = new Map()
  for (let changed = true; changed; ) {
    changed = false
    for (const d of decls) {
      const name = (d.name as ts.Identifier).text
      const owner = ownerTs(d.initializer as ts.Expression, aliases)
      if (owner && TRACKED.has(owner) && aliases.get(name) !== owner) {
        aliases.set(name, owner)
        changed = true
      }
    }
  }
  return aliases
}

function scanTs(src: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const aliases = aliasesTs(sf)
  const out: Violation[] = []
  const report = (use: string, node: ts.Node) => {
    if (!allowed(use, file))
      out.push({ file, line: lineAt(src, node.getStart(sf)), message: message(use) })
  }
  const visit = (node: ts.Node) => {
    const parent = node.parent
    if (ts.isPropertyAccessExpression(node)) {
      const owner = ownerTs(node.expression, aliases)
      const use = classify(node.name.text, owner)
      if (use && owner) report(use, node)
    } else if (ts.isElementAccessExpression(node)) {
      const owner = ownerTs(node.expression, aliases)
      const key = constStrTs(node.argumentExpression)
      const use = key === undefined ? undefined : classify(key, owner)
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

function unwrapSvelte(e: Node): Node {
  while (e.type && SVELTE_WRAPPERS.has(e.type) && e.expression) e = e.expression as Node
  return e
}

function constStrSvelte(e: Node): string | undefined {
  e = unwrapSvelte(e)
  if (e.type === 'Literal') return typeof e.value === 'string' ? e.value : undefined
  if (e.type === 'TemplateLiteral' && (e.expressions as Node[]).length === 0)
    return ((e.quasis as { value: { cooked?: string } }[])[0]?.value.cooked) ?? undefined
  if (e.type === 'BinaryExpression' && e.operator === '+') {
    const l = constStrSvelte(e.left as Node)
    const r = constStrSvelte(e.right as Node)
    return l !== undefined && r !== undefined ? l + r : undefined
  }
  return undefined
}

function memberNameSvelte(e: Node): string | undefined {
  const prop = e.property as Node
  if (!e.computed) return prop.type === 'Identifier' ? (prop.name as string) : undefined
  return constStrSvelte(prop)
}

function ownerSvelte(e: Node, aliases: Aliases): string | undefined {
  e = unwrapSvelte(e)
  if (e.type === 'Identifier') return aliases.get(e.name as string) ?? (e.name as string)
  if (e.type === 'MemberExpression') return ownerOfMember(ownerSvelte(e.object as Node, aliases), memberNameSvelte(e))
  return undefined
}

function aliasesSvelte(ast: unknown): Aliases {
  const decls: Node[] = []
  const seen = new WeakSet<object>()
  const collect = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) return node.forEach(collect)
    const n = node as Node
    if (n.type === 'VariableDeclarator' && (n.id as Node).type === 'Identifier' && n.init) decls.push(n)
    for (const [k, v] of Object.entries(n)) if (k !== 'parent') collect(v)
  }
  collect(ast)
  const aliases: Aliases = new Map()
  for (let changed = true; changed; ) {
    changed = false
    for (const d of decls) {
      const name = (d.id as Node).name as string
      const owner = ownerSvelte(d.init as Node, aliases)
      if (owner && TRACKED.has(owner) && aliases.get(name) !== owner) {
        aliases.set(name, owner)
        changed = true
      }
    }
  }
  return aliases
}

function scanSvelte(src: string, file: string): Violation[] {
  const ast = parse(src, { modern: true })
  const aliases = aliasesSvelte(ast)
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
      const owner = ownerSvelte(obj, aliases)
      const name = memberNameSvelte(n)
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
  visit(ast, undefined, '')
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

const SCANNED = /\.([cm]?[jt]sx?|svelte)$/
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

/** Scans web/src (tests excluded: they are test code, not shipped). */
export function scanWeb(webDir: string): Violation[] {
  const out: Violation[] = []
  for (const p of walk(join(webDir, 'src'))) {
    const file = relative(webDir, p).split('\\').join('/')
    if (!SCANNED.test(file) || TEST_FILE.test(file) || DECLARATION_FILE.test(file)) continue
    out.push(...scanSource(readFileSync(p, 'utf8'), file))
  }
  return out
}
