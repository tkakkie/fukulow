// Web boundary (docs: AGENTS.md Rules / #29, #48): network access only in the API layer, and
// no web storage that could hold credentials. Found by parsing code, not by text search.
//
// Detected (per file, by name; no scope analysis):
//   - network: fetch, XMLHttpRequest, WebSocket, WebTransport, EventSource, BroadcastChannel, Worker, SharedWorker,
//     navigator.sendBeacon; allowed only in NETWORK_FILES. Workers are forbidden elsewhere because they can hold
//     communication this scan cannot see; when a real need appears, allow it and scan the Worker script.
//   - storage: localStorage, sessionStorage, indexedDB, caches, cookieStore, document.cookie; forbidden everywhere
//     until a ui-settings helper exists (its exemption must land with a typed key/value allow-list guard).
//   - forms: bare name (`const f = fetch`), member of window / globalThis / self (also chained, cast,
//     `!`, parenthesised), string-literal or constant-concatenation keys (`window['local' + 'Storage']`),
//     and aliases of those objects, document or navigator (`const w = window; w.fetch()`).
//   - files: .ts .mts .cts .tsx .js .mjs .cjs .jsx and .svelte (instance, module and template).
//     Out of scope: tests (*.test.* / *.spec.*), .d.ts, non-code files, files outside web/src.
//   - workers: static and dynamic imports / re-exports whose specifier carries the Vite `?worker` or `?sharedworker`
//     query (also with `&inline`, `&url`, any order) are network uses, allowed only in NETWORK_FILES.
//   - destructuring (same in .ts and .svelte): `const { fetch } = window`, `const { fetch: f } = globalThis`,
//     nested `const { document: { cookie } } = window` and assignment `({ fetch } = window)` are checked against the
//     source object, and a bound name (`const { document: d } = window`) becomes an alias. Destructuring from
//     other objects is not flagged.
//   - global roots: window, globalThis, self, top and parent (also as members: `window.parent.fetch`).
// Known limits (fail closed where noted): no dynamic keys (`window[k]`); `frames[n]`, `opener` and
// `iframe.contentWindow` roots; aliases through functions, properties, parameters or reassignment;
// `import()`/`eval` of non-literal specifiers, `Reflect`; other APIs (e.g. service workers, form posts, <img>/<script>
// loads). No scope analysis (#60): an alias name counts for the whole file, so a function parameter that shadows an
// alias name is a false positive (pinned by a test), and one name bound to different tracked objects is checked against all of them.
// Not handled (#60): object rest (`const { ...rest } = window`), array destructuring, destructuring in for-of heads and in
// function parameter defaults. Worker import detection (`?worker`) is separate from checking the worker script itself: a
// worker file is only scanned by the normal per-file scan, so being importable from the API layer does not allow network
// operations inside the worker.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'svelte/compiler'
import ts from 'typescript'

/** The only files that may open connections (the API layer). */
export const NETWORK_FILES = ['src/api.ts', 'src/realtime.ts']

const NETWORK = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebTransport',
  'EventSource',
  'BroadcastChannel',
  'Worker',
  'SharedWorker',
  'navigator.sendBeacon',
])
const STORAGE = new Set(['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore'])
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'top', 'parent'])
/** Vite worker import queries (`./w?worker&inline`), reported as `?worker` / `?sharedworker`. */
const WORKER_QUERIES = ['worker', 'sharedworker']
/** Objects whose members matter, so aliases of them are tracked. */
const TRACKED = new Set([...GLOBAL_OBJECTS, 'document', 'navigator', '*'])
/** A name bound to different tracked objects in different scopes: checked against all of them (fails closed). */
const AMBIGUOUS = '*'

export type Violation = { file: string; line: number; message: string }

/** Classifies a reference to `name` (optionally as a member of `owner`). */
function classify(name: string, owner?: string): string | undefined {
  if (owner === AMBIGUOUS) return classify(name, 'document') ?? classify(name, 'navigator') ?? classify(name, 'window')
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

function isNetworkUse(use: string): boolean {
  return NETWORK.has(use) || WORKER_QUERIES.some((q) => use === '?' + q)
}

/** The Vite worker query of an import specifier, as `?worker` / `?sharedworker`. */
function workerImport(specifier: string | undefined): string | undefined {
  const query = specifier?.split('#')[0]?.split('?').slice(1).join('?')
  if (query === undefined) return undefined
  const q = WORKER_QUERIES.find((w) => query.split('&').includes(w))
  return q && '?' + q
}

function allowed(use: string, file: string): boolean {
  return isNetworkUse(use) && NETWORK_FILES.includes(file)
}

function message(use: string): string {
  return isNetworkUse(use)
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

/**
 * One name taken from an object: `path` is the property chain from the source object, `alias` the identifier it is
 * bound to (when there is one). A plain `const w = window` is `{ path: [], alias: 'w' }`.
 */
type Binding<N> = { path: string[]; alias?: string; node: N }
type Source<N> = { base: (aliases: Aliases) => string | undefined; bindings: Binding<N>[] }

function follow(owner: string | undefined, path: string[]): string | undefined {
  for (const key of path) owner = ownerOfMember(owner, key)
  return owner
}

/** Alias names reachable from the sources, to a fixed point so declaration order does not matter. */
function resolveAliases<N>(sources: Source<N>[]): Aliases {
  const aliases: Aliases = new Map()
  for (let changed = true; changed; ) {
    changed = false
    for (const { base, bindings } of sources) {
      const root = base(aliases)
      for (const b of bindings) {
        const owner = b.alias === undefined ? undefined : follow(root, b.path)
        if (b.alias !== undefined && owner && TRACKED.has(owner) && bind(aliases, b.alias, owner)) changed = true
      }
    }
  }
  return aliases
}

/** Uses read by destructuring: `const { fetch } = window` (not for plain aliases, whose uses are member accesses). */
function destructuredUses<N>(sources: Source<N>[], aliases: Aliases, report: (use: string, node: N) => void) {
  for (const { base, bindings } of sources) {
    const root = base(aliases)
    for (const b of bindings) {
      if (b.path.length === 0) continue
      const owner = follow(root, b.path.slice(0, -1))
      const use = owner === undefined ? undefined : classify(b.path[b.path.length - 1] as string, owner)
      if (use) report(use, b.node)
    }
  }
}

/**
 * Records `name -> owner`. A second, different owner for the same name (same name in another scope) turns it
 * AMBIGUOUS. Values only move unbound -> owner -> AMBIGUOUS, so the fixed point always terminates.
 */
function bind(aliases: Aliases, name: string, owner: string): boolean {
  const current = aliases.get(name)
  const next = current === undefined || current === owner ? owner : AMBIGUOUS
  if (current === next) return false
  aliases.set(name, next)
  return true
}

function ownerTs(e: ts.Expression, aliases: Aliases): string | undefined {
  e = unwrapTs(e)
  if (ts.isIdentifier(e)) return aliases.get(e.text) ?? e.text
  if (ts.isPropertyAccessExpression(e)) return ownerOfMember(ownerTs(e.expression, aliases), e.name.text)
  if (ts.isElementAccessExpression(e))
    return ownerOfMember(ownerTs(e.expression, aliases), constStrTs(e.argumentExpression))
  return undefined
}

function propKeyTs(name: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(name)) return constStrTs(name.expression)
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

/** Names taken by an object binding pattern (`const { a: { b } } = x`) or an assignment pattern (`({ a } = x)`). */
function patternTs(p: ts.Node, prefix: string[], out: Binding<ts.Node>[]) {
  p = ts.isExpression(p) ? unwrapTs(p) : p
  const target = (t: ts.Node, path: string[], node: ts.Node) => {
    if (ts.isBinaryExpression(t) && t.operatorToken.kind === ts.SyntaxKind.EqualsToken) t = t.left
    if (ts.isIdentifier(t)) out.push({ path, alias: t.text, node })
    else {
      out.push({ path, node })
      if (ts.isObjectBindingPattern(t) || ts.isObjectLiteralExpression(t)) patternTs(t, path, out)
    }
  }
  if (ts.isObjectBindingPattern(p)) {
    for (const el of p.elements) {
      const key = el.dotDotDotToken ? undefined : el.propertyName ? propKeyTs(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : undefined
      if (key !== undefined) target(el.name, [...prefix, key], el)
    }
  } else if (ts.isObjectLiteralExpression(p)) {
    for (const el of p.properties) {
      if (ts.isShorthandPropertyAssignment(el)) target(el.name, [...prefix, el.name.text], el)
      else if (ts.isPropertyAssignment(el)) {
        const key = propKeyTs(el.name)
        if (key !== undefined) target(el.initializer, [...prefix, key], el)
      }
    }
  }
}

function sourcesTs(sf: ts.SourceFile): Source<ts.Node>[] {
  const sources: Source<ts.Node>[] = []
  const add = (pattern: ts.Node, init: ts.Expression) => {
    const bindings: Binding<ts.Node>[] = []
    patternTs(pattern, [], bindings)
    sources.push({ base: (aliases) => ownerTs(init, aliases), bindings })
  }
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name)) sources.push({ base: (al) => ownerTs(n.initializer as ts.Expression, al), bindings: [{ path: [], alias: n.name.text, node: n }] })
      else if (ts.isObjectBindingPattern(n.name)) add(n.name, n.initializer)
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(unwrapTs(n.left))) {
      add(n.left, n.right)
    }
    ts.forEachChild(n, collect)
  }
  collect(sf)
  return sources
}

function scanTs(src: string, file: string): Violation[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const sources = sourcesTs(sf)
  const aliases = resolveAliases(sources)
  const out: Violation[] = []
  const reported = new Set<string>()
  const report = (use: string, node: ts.Node) => {
    const at = node.getStart(sf)
    if (allowed(use, file) || reported.has(at + use)) return
    reported.add(at + use)
    out.push({ file, line: lineAt(src, at), message: message(use) })
  }
  destructuredUses(sources, aliases, report)
  const specifier = (e: ts.Expression | undefined, node: ts.Node) => {
    const use = e && workerImport(constStrTs(e))
    if (use) report(use, node)
  }
  const visit = (node: ts.Node) => {
    const parent = node.parent
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier(node.moduleSpecifier, node)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier(node.arguments[0], node)
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
      const isPatternKey = parent && ts.isBindingElement(parent) && parent.propertyName === node
      const isDeclName =
        parent &&
        !ts.isShorthandPropertyAssignment(parent) &&
        'name' in parent &&
        (parent as { name?: ts.Node }).name === node &&
        !ts.isPropertyAccessExpression(parent)
      if (!isMemberName && !isTypeUse && !isDeclName && !isPatternKey) {
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

function propKeySvelte(p: Node): string | undefined {
  const key = p.key as Node
  if (p.computed) return constStrSvelte(key)
  return key.type === 'Identifier' ? (key.name as string) : key.type === 'Literal' ? String(key.value) : undefined
}

/** Names taken by an object pattern, in a declaration or an assignment (the same shape in both). */
function patternSvelte(p: Node, prefix: string[], out: Binding<Node>[]) {
  for (const el of (p.properties as Node[]) ?? []) {
    const key = el.type === 'Property' ? propKeySvelte(el) : undefined
    if (key === undefined) continue
    let t = el.value as Node
    if (t.type === 'AssignmentPattern') t = t.left as Node
    const path = [...prefix, key]
    if (t.type === 'Identifier') out.push({ path, alias: t.name as string, node: el })
    else {
      out.push({ path, node: el })
      if (t.type === 'ObjectPattern') patternSvelte(t, path, out)
    }
  }
}

function sourcesSvelte(ast: unknown): Source<Node>[] {
  const sources: Source<Node>[] = []
  const seen = new WeakSet<object>()
  const add = (pattern: Node, init: Node) => {
    const bindings: Binding<Node>[] = []
    patternSvelte(pattern, [], bindings)
    sources.push({ base: (aliases) => ownerSvelte(init, aliases), bindings })
  }
  const collect = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) return node.forEach(collect)
    const n = node as Node
    if (n.type === 'VariableDeclarator' && n.init) {
      const id = n.id as Node
      if (id.type === 'Identifier') sources.push({ base: (al) => ownerSvelte(n.init as Node, al), bindings: [{ path: [], alias: id.name as string, node: n }] })
      else if (id.type === 'ObjectPattern') add(id, n.init as Node)
    } else if (n.type === 'AssignmentExpression' && n.operator === '=' && (n.left as Node).type === 'ObjectPattern') {
      add(n.left as Node, n.right as Node)
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'parent') collect(v)
  }
  collect(ast)
  return sources
}

function scanSvelte(src: string, file: string): Violation[] {
  const ast = parse(src, { modern: true })
  const sources = sourcesSvelte(ast)
  const aliases = resolveAliases(sources)
  const out: Violation[] = []
  const reported = new Set<string>()
  const report = (use: string, node: Node) => {
    const at = node.start ?? 0
    if (allowed(use, file) || reported.has(at + use)) return
    reported.add(at + use)
    out.push({ file, line: lineAt(src, at), message: message(use) })
  }
  destructuredUses(sources, aliases, report)
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
    if (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ImportExpression') {
      const source = n.source as Node | null | undefined
      const use = source && workerImport(constStrSvelte(source))
      if (use) report(use, n)
    }
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
    // `{ fetch }` / `{ a: fetch }` / `{ fetch = 1 }` in an object pattern declares (or assigns) a variable; only
    // the default value of such an element is an expression. Object expressions are Property under ObjectExpression.
    if (n.type === 'Property' && parent?.type === 'ObjectPattern') {
      if (n.computed) visit(n.key, n, 'key')
      const value = n.value as Node
      if (value.type === 'AssignmentPattern') {
        visit(value.right, value, 'right')
        const left = value.left as Node
        if (left.type !== 'Identifier') visit(left, value, 'left')
      } else if (value.type !== 'Identifier') visit(value, n, 'value')
      return
    }
    if (n.type === 'Identifier') {
      const isDecl = key === 'id' || key === 'params' || (parent?.type === 'Property' && key === 'key' && !parent.computed) ||
        (parent?.type === 'AssignmentPattern' && key === 'left')
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
