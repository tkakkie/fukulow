// Decides whether the Playwright smoke suite provably runs unfiltered in PR CI (workflow, config and smoke sources).
// What is detected and refused is documented in check-invariants.ts.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import ts from 'typescript'

export function isPlaywrightImport(s: ts.Node): s is ts.ImportDeclaration {
  return ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === '@playwright/test'
}

/** Literal properties only: computed names, duplicates and spreads cannot prove discovery. */
function configProperties(node: ts.Node | undefined): Map<string, ts.Expression> | null {
  if (!node || !ts.isObjectLiteralExpression(node)) return null
  const props = new Map<string, ts.Expression>()
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p) || (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)) || props.has(p.name.text)) return null
    props.set(p.name.text, p.initializer)
  }
  return props
}

/** Deliberately recognizes the current smoke invocation, not arbitrary YAML or shell programs. */
export function playwrightCI(root: string): string | null {
  const workflow = join(root, '.github/workflows/e2e.yml')
  if (!existsSync(workflow)) return 'Playwright PR CI workflow e2e.yml is missing (not run in CI)'
  const src = readFileSync(workflow, 'utf8').replace(/^\s*#.*$/gm, '')
  const triggers = /^on:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(src)?.[1]
  if ([...src.matchAll(/^on:/gm)].length !== 1 || !triggers || !/^  pull_request:[ \t]*(?:\n[ \t]*)*$/.test(triggers))
    return 'Playwright workflow pull_request trigger is absent or filtered'
  const jobs = /^jobs:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(src)?.[1]
  const smoke = jobs && /^  smoke:\n([\s\S]*)$/.exec(jobs)?.[1]
  // Every nonblank line after the sole job key must belong to its indented body.
  if (!smoke || smoke.split('\n').some(line => line.trim() !== '' && !/^ {4}/.test(line))
    || [...src.matchAll(/^jobs:/gm)].length !== 1
    || /^(?:defaults|env):|^    (?:if|needs|strategy|defaults|continue-on-error):|[&*][\w-]+/m.test(src))
    return 'Playwright smoke job execution cannot be verified statically'
  const steps = smoke.split(/^      - /m).slice(1)
  const cliSteps = steps.filter(step => step.includes('node_modules/@playwright/test/cli.js'))
  // Match the complete Docker invocation, so extra CLI filters, config overrides, shell guards,
  // workdir overrides and Docker entrypoint/env changes cannot silently narrow discovery.
  const command = String.raw`docker run --pull never --rm --init --network host --ipc host \
  --user "$(id -u):$(id -g)" \
  --env CI --env DATABASE_URL --env FUKULOW_SEND_BURST --env FUKULOW_SEND_REFILL_PER_SECOND \
  --volume "$GITHUB_WORKSPACE:$GITHUB_WORKSPACE" \
  --volume "$RUNNER_TOOL_CACHE:$RUNNER_TOOL_CACHE:ro" \
  --workdir "$GITHUB_WORKSPACE/web" \
  --entrypoint "$(command -v node)" \
  "$PLAYWRIGHT_IMAGE" node_modules/@playwright/test/cli.js test`
  const step = cliSteps[0] ?? ''
  const run = /\n        shell: bash\n        run: \|\n([\s\S]*)$/.exec(step)?.[1]
  const body = run?.split('\n').map(line => line.replace(/^          /, '')).join('\n').trim()
  const prefix = String.raw`set -euo pipefail
if ! timeout 60s docker pull "$PLAYWRIGHT_IMAGE"; then
  echo '::error::Playwright image pull failed or exceeded 60 seconds'
  exit 1
fi`
  if (cliSteps.length !== 1 || !/^name: [^\n]+\n        shell: bash\n        run: \|\n/.test(step) || body !== `${prefix}\n${command}`)
    return 'Playwright smoke CLI must run unfiltered test from web (filters/overrides or command unverifiable)'
  const checks = steps.filter(step => step.includes('check-e2e-invariants.ts'))
  if (checks.length !== 1 || steps.indexOf(checks[0]) !== steps.indexOf(step) + 1
    || !/^name: [^\n]+\n        run: node web\/scripts\/check-e2e-invariants\.ts\s*$/.test(checks[0]))
    return 'Playwright runtime invariants check must run unconditionally after Playwright as the immediately next step and fail the job'
  return null
}

export function playwrightConfig(root: string): string | null {
  const file = join(root, 'web/playwright.config.ts')
  if (!existsSync(file)) return 'Playwright discovery config is missing'
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const exports = sf.statements.filter(ts.isExportAssignment)
  const exp = exports[0]?.expression
  const config = exp && ts.isCallExpression(exp) && exp.expression.getText(sf) === 'defineConfig' && exp.arguments.length === 1
    ? configProperties(exp.arguments[0]) : null
  const imported = sf.statements.some(s => isPlaywrightImport(s) && s.importClause?.namedBindings
    && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some(e => !e.propertyName && e.name.text === 'defineConfig'))
  if (exports.length !== 1 || !config || !imported) return 'Playwright discovery config must be a literal defineConfig object imported from @playwright/test'
  const dir = config.get('testDir')
  if (!dir || !ts.isStringLiteral(dir) || dir.text !== './e2e') return "Playwright testDir must be './e2e'"
  const allowed = new Set(['testDir', 'projects', 'forbidOnly', 'workers', 'timeout', 'preserveOutput', 'reporter', 'use', 'webServer'])
  for (const key of config.keys()) if (!allowed.has(key)) return `Playwright config ${key} discovery is unverifiable`
  if (config.has('forbidOnly') && config.get('forbidOnly')?.kind !== ts.SyntaxKind.TrueKeyword)
    return 'Playwright forbidOnly must not be false or computed'
  const reporter = config.get('reporter')
  const ciReporter = reporter && ts.isConditionalExpression(reporter) && reporter.condition.getText(sf) === 'process.env.CI'
    ? reporter.whenTrue : reporter
  if (!ciReporter || !ts.isArrayLiteralExpression(ciReporter)
    || !ciReporter.elements.some(entry => ts.isArrayLiteralExpression(entry) && entry.elements.length === 1
      && ts.isStringLiteral(entry.elements[0]) && entry.elements[0].text === './scripts/e2e-reporter.ts'))
    return 'Playwright CI reporter must include ./scripts/e2e-reporter.ts'
  const projects = config.get('projects')
  if (!projects || !ts.isArrayLiteralExpression(projects) || projects.elements.length !== 1)
    return 'Playwright config must have exactly one literal project'
  const project = configProperties(projects.elements[0])
  if (!project) return 'Playwright project must be a literal object'
  for (const key of project.keys()) if (!['name', 'use'].includes(key)) return `Playwright project ${key} discovery is unverifiable`
  return null
}

/** True when the declaration is erased at runtime (`import type`, or only `type` specifiers). */
function typeOnlyImport(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node))
    return node.isTypeOnly || (!!node.exportClause && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.length > 0 && node.exportClause.elements.every(e => e.isTypeOnly))
  const c = node.importClause
  if (!c) return false
  if (c.isTypeOnly) return true
  return !c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings)
    && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every(e => e.isTypeOnly)
}

/** Receiver-independent checks: helper effects and escaped test values cannot be confined to one spec. */
export function playwrightSafety(sf: ts.SourceFile, smokeDir?: string): { reason: string; suiteWide: boolean } | undefined {
  const modifiers = new Set(['skip', 'fixme', 'fail', 'only', 'configure', 'slow'])
  // Allowlist: any other member (info, extend, describe.serial, ...) could skip or filter at runtime.
  const testMembers = new Set(['describe', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'setTimeout', 'use', 'step'])
  const describeMembers = new Set<string>()
  const expectMembers = new Set(['poll', 'soft', 'not', 'any', 'anything', 'objectContaining', 'arrayContaining', 'stringContaining', 'stringMatching', 'closeTo'])
  const testInfoNames = new Set(['getState', 'currentTestInfo', 'expectedStatus', '_testInfo'])
  // node:module (createRequire), node:vm and similar can load or run unscanned code.
  const nodeModules = new Set(['node:crypto', 'node:fs', 'node:fs/promises', 'node:http', 'node:https', 'node:net', 'node:path', 'node:url', 'node:os', 'node:util', 'node:buffer', 'node:events', 'node:timers/promises'])
  const plainData = (e: ts.Expression): boolean =>
    ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)
    || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword
    || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand))
    || (ts.isArrayLiteralExpression(e) && e.elements.every(plainData))
    || (ts.isObjectLiteralExpression(e) && e.properties.every(p => ts.isPropertyAssignment(p)
      && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && plainData(p.initializer)))
  let refusal: { reason: string; suiteWide: boolean } | undefined
  const refuse = (reason: string, suiteWide: boolean) => {
    if (!refusal || suiteWide) refusal = { reason, suiteWide }
  }
  const nameOf = (node: ts.Node): string | undefined => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isComputedPropertyName(node)) return nameOf(node.expression)
  }
  const visit = (node: ts.Node) => {
    let name: string | undefined
    if (ts.isPropertyAccessExpression(node)) name = node.name.text
    else if (ts.isElementAccessExpression(node)) name = nameOf(node.argumentExpression)
    else if (ts.isBindingElement(node)) name = nameOf(node.propertyName ?? node.name)
    else if (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) name = nameOf(node.name)
    if (name && modifiers.has(name))
      refuse(`unsupported Playwright .${name} access or binding`, name === 'only')
    // Handles that reach the running TestInfo without test.info() (#440 review).
    if (name && testInfoNames.has(name)) refuse(`Playwright TestInfo handle .${name} cannot be verified`, true)
    // Runtime code outside web/e2e is not scanned, so a helper there could skip at runtime (#440).
    // Checked in the suite-wide scan (smokeDir given), which covers every smoke file.
    if (smokeDir && (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier) && !typeOnlyImport(node)) {
      const spec = node.moduleSpecifier.text
      const inside = spec.startsWith('.') && resolve(sf.fileName, '..', spec).startsWith(smokeDir + sep)
      if (spec !== '@playwright/test' && !nodeModules.has(spec) && !inside)
        refuse(`runtime import of ${spec} from outside web/e2e cannot be verified`, true)
    }
    if (smokeDir && ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')))
      refuse('dynamic import or require cannot be verified', true)
    if (isPlaywrightImport(node)) {
      const clause = node.importClause
      if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)
        || clause.namedBindings.elements.some(e => e.propertyName))
        refuse('Playwright imports must be plain unaliased named imports', true)
    }
    if (ts.isIdentifier(node) && node.text === 'eval')
      refuse('eval cannot be verified', true)
    if (isPlaywrightImport(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && !node.importClause.isTypeOnly)
      for (const e of node.importClause.namedBindings.elements)
        if (!e.isTypeOnly && !['test', 'expect'].includes(e.name.text))
          refuse(`Playwright value import ${e.name.text} cannot be verified`, true)
    if (ts.isIdentifier(node) && (node.text === 'test' || node.text === 'expect')) {
      const root = node.text
      const p = node.parent
      let target: ts.Node = node
      const members: string[] = []
      while ((ts.isPropertyAccessExpression(target.parent) || ts.isElementAccessExpression(target.parent)) && target.parent.expression === target) {
        const access = target.parent
        // A computed key can spell skip/only at runtime (#440): only literal, listed members pass.
        const member = ts.isPropertyAccessExpression(access) ? access.name.text
          : ts.isStringLiteral(access.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(access.argumentExpression)
            ? access.argumentExpression.text : undefined
        if (member === undefined) refuse(`dynamic property access on Playwright ${root} cannot be verified`, true)
        else if (!modifiers.has(member) && !(root === 'expect' ? expectMembers : target === node ? testMembers : describeMembers).has(member))
          refuse(`unsupported Playwright ${root} member ${member}`, true)
        else members.push(member)
        target = access
      }
      const direct = ts.isCallExpression(target.parent) && target.parent.expression === target
      const imported = ts.isImportSpecifier(p) && !p.propertyName && p.name === node
      if (!direct && !imported) refuse(`Playwright ${root} used as a value cannot be verified`, true)
      if (direct && root === 'test') {
        const call = target.parent as ts.CallExpression
        const member = members[0]
        // Hook, fixture and step callbacks receive TestInfo/TestStepInfo in later parameters.
        const maxParams = member === 'step' ? 0 : 1
        if (call.arguments.length > 2) refuse('Playwright test call with details or options cannot be verified', true)
        for (const a of call.arguments)
          if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters.length > maxParams)
            refuse(`Playwright ${member ?? 'test'} callback may receive TestInfo`, true)
        if (member === 'use' && !call.arguments.every(plainData))
          refuse('test.use accepts only literal option values (fixtures receive TestInfo)', true)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return refusal
}
