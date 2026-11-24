// Finds Vitest, node:test and Playwright test declarations in TypeScript sources and whether each is skipped.
// What is detected and refused is documented in check-invariants.ts.
import ts from 'typescript'
import { isPlaywrightImport, playwrightSafety } from './playwright-ci.ts'

const SKIP_WORDS = new Set(['skip', 'fixme', 'todo'])
const MODIFIERS = new Set(['only', 'fail', 'fails', 'concurrent', 'sequential', 'describe', 'serial', 'parallel', ...SKIP_WORDS])

type Callee = { root: string; words: string[] } | null

/** `test.describe.skip` -> { root: 'test', words: ['describe', 'skip'] }; null if not a test/describe call. */
function calleeOf(e: ts.Expression): Callee {
  const words: string[] = []
  let cur = e
  while (ts.isPropertyAccessExpression(cur) && MODIFIERS.has(cur.name.text)) {
    words.unshift(cur.name.text)
    cur = cur.expression
  }
  if (!ts.isIdentifier(cur)) return null
  const root = cur.text
  if (!['test', 'it', 'describe', 'suite', 'xit', 'xtest', 'xdescribe'].includes(root)) return null
  return { root, words }
}

/** Vitest `it.each([a, b])('title', fn)` / `test.each([a, b])('title', fn)` with a non-empty literal array; fails closed on all other `.each` shapes.
 * The caller also requires an inline callback or a local function (`isLocalFunction`). */
function vitestEachCallee(e: ts.Expression): { callee: NonNullable<Callee>; valid: boolean } | null {
  if (!ts.isCallExpression(e)) return null
  let dotEach = false
  let target: ts.Expression
  if (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'each') {
    dotEach = true
    target = e.expression.expression
  } else if (ts.isElementAccessExpression(e.expression)) {
    target = e.expression.expression
  } else {
    return null
  }
  const callee = calleeOf(target)
  if (!callee) return null
  const isTestRoot = callee.root === 'it' || callee.root === 'test'
  const allowedWords = callee.words.every((w) => w === 'concurrent' || w === 'sequential')
  const cases = e.arguments.length === 1 ? e.arguments[0] : undefined
  const validCases = !!cases
    && ts.isArrayLiteralExpression(cases)
    && cases.elements.length > 0
    && cases.elements.every((el) => !ts.isSpreadElement(el) && !ts.isOmittedExpression(el))
  return { callee, valid: dotEach && isTestRoot && allowedWords && validCases }
}

// Generators return an iterator without running their body, so they never count as a callback.
const isInlineFunction = (n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression =>
  !!n && (ts.isArrowFunction(n) || (ts.isFunctionExpression(n) && !n.asteriskToken))

/** Symbol lookup for one file without libs or imports, so imported or global names never resolve to a local function. */
function fileChecker(sf: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name) => (name === sf.fileName ? sf : undefined)
  host.fileExists = (name) => name === sf.fileName
  return ts.createProgram([sf.fileName], options, host).getTypeChecker()
}

/** A reference that cannot rebind the name: a call's callee or argument, or the object of a property access. */
function isReadOnlyUse(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isCallExpression(p)) return p.expression === id || p.arguments.some((a) => a === id)
  return ts.isPropertyAccessExpression(p) && p.expression === id
}

/** A property name that is not a binding or a reference: `a.name` or `{ name: value }`. */
function isPropertyName(id: ts.Identifier): boolean {
  const p = id.parent
  return (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) && p.name === id
}

/** Inside a `declare` declaration (e.g. `declare const`, `declare namespace`), which emits no runtime code. */
function inAmbientContext(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n; p; p = p.parent)
    if (ts.canHaveModifiers(p) && ts.getModifiers(p)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true
  return false
}

/** True when a `.each` callback identifier resolves, in this file, to a non-ambient function declaration or `const`
 * function (not a generator) initialised before the call. Every other identifier with that text anywhere in the file
 * must be a property name or a read-only use of the same symbol. Any other same-named binding or reference
 * (`var` redeclarations, shorthand or nested destructuring, `++`, `for...of` targets, shadowing) fails closed. */
function isLocalFunction(id: ts.Identifier, call: ts.Node, checker: () => ts.TypeChecker): boolean {
  const symbol = checker().getSymbolAtLocation(id)
  const d = symbol?.declarations?.[0]
  if (!symbol || !d || inAmbientContext(d) || inAmbientContext(call)) return false
  const fn = ts.isFunctionDeclaration(d) && !!d.body && !d.asteriskToken
  const constFn = ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && isInlineFunction(d.initializer)
    && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const && d.end <= call.getStart()
  if (!fn && !constFn) return false
  const name = (d as ts.FunctionDeclaration | ts.VariableDeclaration).name
  let rebindable = false
  const visit = (n: ts.Node) => {
    if (rebindable) return
    if (ts.isIdentifier(n) && n !== name && n.text === id.text && !isPropertyName(n)
      && !(isReadOnlyUse(n) && checker().getSymbolAtLocation(n) === symbol)) rebindable = true
    ts.forEachChild(n, visit)
  }
  visit(id.getSourceFile())
  return !rebindable
}

export type TsTest = { title: string; skipped: boolean; reason?: string }

/** Titles of test(...) / it(...) calls (vitest, Playwright) in the AST; skipped if the call or a parent describe is skipped. */
export function tsTests(src: string, fileName = 'x.ts', nodeTests = false, playwright = false): TsTest[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true)
  const out: TsTest[] = []
  let unverifiable: string | undefined
  let typeChecker: ts.TypeChecker | undefined
  const checker = () => (typeChecker ??= fileChecker(sf))
  const visit = (node: ts.Node, parentSkipped: boolean) => {
    let skipped = parentSkipped
    if (ts.isCallExpression(node)) {
      const each = !nodeTests && !playwright ? vitestEachCallee(node.expression) : null
      const c = each ? each.callee : calleeOf(node.expression)
      if (playwright) {
        let root = node.expression
        while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression
        if (ts.isIdentifier(root) && root.text === 'test' && !c)
          unverifiable ??= 'unsupported Playwright test API (including describe.configure mode changes)'
      }
      if (c) {
        const options = node.arguments[1]
        // Fail closed on node:test options (skip/todo may be computed or spread).
        const nodeOptions = nodeTests && options && !ts.isArrowFunction(options) && !ts.isFunctionExpression(options)
        const a = node.arguments[0]
        const literal = a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))
        const invalidEach = each !== null && (!each.valid || node.arguments.length !== 2 || !literal
          || !(isInlineFunction(options) || (!!options && ts.isIdentifier(options) && isLocalFunction(options, node, checker))))
        const own = invalidEach || nodeOptions || c.root.startsWith('x') || c.words.some((w) => SKIP_WORDS.has(w) || (playwright && w === 'fail'))
        const isSuite = c.root === 'describe' || c.root === 'suite' || c.root === 'xdescribe' || c.words.includes('describe')
        if (playwright) {
          if (c.words.some(w => !['describe', 'skip', 'fixme', 'fail', 'only'].includes(w)))
            unverifiable ??= 'unsupported Playwright modifier or suite mode'
          const callback = node.arguments[1]
          const inline = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          const declaration = node.arguments.length === 2 && literal && inline
          if (inline && callback.parameters.length > 1)
            unverifiable ??= 'Playwright inline callback must have at most one parameter (no testInfo)'
          if (c.words.includes('only')) unverifiable = 'Playwright .only cannot be verified'
          if (c.words.some(w => w === 'skip' || w === 'fixme' || w === 'fail') && !declaration)
            unverifiable ??= 'runtime/conditional Playwright skip/fixme/fail makes the file unverifiable'
          if (!declaration || c.root !== 'test') unverifiable ??= 'Playwright declaration is not a literal title and inline callback'
          if (declaration) {
            // Only direct source/suite declarations count; control flow, helper functions and test bodies may not register tests.
            let p = node.parent
            while (p && !ts.isSourceFile(p)) {
              if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
                const call = p.parent
                const parent = ts.isCallExpression(call) ? calleeOf(call.expression) : null
                if (!parent?.words.includes('describe')) unverifiable ??= 'conditional/nested Playwright declaration cannot be verified'
              } else if (!ts.isExpressionStatement(p) && !ts.isBlock(p) && !ts.isCallExpression(p))
                unverifiable ??= 'conditional/nested Playwright declaration cannot be verified'
              p = p.parent
            }
          }
        }
        if (literal && !isSuite) out.push({ title: a.text, skipped: parentSkipped || own,
          ...(playwright && own ? { reason: `Playwright ${c.words.find(w => SKIP_WORDS.has(w) || w === 'fail') ?? 'skipped'} declaration` } : {}),
        })
        if (isSuite) skipped = parentSkipped || own
      }
    }
    ts.forEachChild(node, (child) => visit(child, skipped))
  }
  visit(sf, false)
  if (playwright && !sf.statements.some(s => isPlaywrightImport(s) && s.importClause?.namedBindings
    && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some(e => !e.propertyName && e.name.text === 'test')))
    unverifiable ??= 'Playwright test must be imported directly without an alias from @playwright/test'
  if (playwright) unverifiable ??= playwrightSafety(sf)?.reason
  if (playwright && unverifiable) return out.map(t => ({ ...t, skipped: true, reason: unverifiable }))
  return out
}
