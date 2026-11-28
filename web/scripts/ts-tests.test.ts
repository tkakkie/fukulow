// Regression tests for TypeScript test declaration discovery and skip detection.
import { describe, expect, it } from 'vitest'
import { tsTests } from './ts-tests.ts'

describe('tsTests', () => {
  it('finds test( and it( titles and marks skipped ones', () => {
    const src = `
test('first', async () => {})
it("second", () => {})
test.skip(\`third\`, () => {})
it.todo('fourth')
test.fixme('fifth', () => {})
xit('sixth', () => {})
test.only('seventh', () => {})
`
    expect(tsTests(src)).toEqual([
      { title: 'first', skipped: false },
      { title: 'second', skipped: false },
      { title: 'third', skipped: true },
      { title: 'fourth', skipped: true },
      { title: 'fifth', skipped: true },
      { title: 'sixth', skipped: true },
      { title: 'seventh', skipped: false },
    ])
  })

  it('marks every test inside a skipped describe, nested too (negative)', () => {
    const src = `
describe.skip('a', () => { it('in skipped', () => {}); describe('inner', () => { it('deep', () => {}) }) })
test.describe.skip('b', () => { test('pw in skipped', () => {}) })
describe('c', () => { it('fine', () => {}) })
`
    expect(tsTests(src)).toEqual([
      { title: 'in skipped', skipped: true },
      { title: 'deep', skipped: true },
      { title: 'pw in skipped', skipped: true },
      { title: 'fine', skipped: false },
    ])
  })

  it('ignores titles in comments and strings (negative)', () => {
    const src = `
// test('in comment', () => {})
const s = "test('in string', () => {})"
const t = \`it('in template', () => {})\`
describe('only a group', () => {})
other('not a test', () => {})
`
    expect(tsTests(src)).toEqual([])
  })

  it('accepts only verifiable it.each/test.each with non-empty literal arrays and inline callbacks, failing closed otherwise', () => {
    const src = `
it.each([401, 404])('literal it %s', () => {})
test.each([1])('literal test %s', function () {})
test.concurrent.each([1])('concurrent %s', () => {})
it.skip.each([1])('skipped %s', () => {})
it.only.each([1])('only %s', () => {})
it.todo.each([1])('todo %s', () => {})
it.concurrent.skip.each([1])('concurrent skipped %s', () => {})
xit.each([1])('xskipped %s', () => {})
it.each([])('empty %s', () => {})
it.each([,])('sparse %s', () => {})
it.each([1, , 2])('hole %s', () => {})
it.each([...cases])('spread only %s', () => {})
it.each([1, ...cases])('mixed spread %s', () => {})
it.each(cases)('non-literal %s', () => {})
it.each([1])('options %s', { skip: true }, () => {})
it.each([1])('missing callback %s')
it['each']([1])('bracket it %s', () => {})
describe.each([1])('describe each %s', () => { it('inside describe each', () => {}) })
describe.each([])('empty suite %s', () => { it('inside empty each', () => {}) })
describe.skip.each([1])('skipped suite %s', () => { it('inside skipped each', () => {}) })
describe['each']([1])('bracket suite %s', () => { it('inside bracket each', () => {}) })
describe['each']([])('bracket empty suite %s', () => { it('inside bracket empty each', () => {}) })
`
    expect(tsTests(src)).toEqual([
      { title: 'literal it %s', skipped: false },
      { title: 'literal test %s', skipped: false },
      { title: 'concurrent %s', skipped: false },
      { title: 'skipped %s', skipped: true },
      { title: 'only %s', skipped: true },
      { title: 'todo %s', skipped: true },
      { title: 'concurrent skipped %s', skipped: true },
      { title: 'xskipped %s', skipped: true },
      { title: 'empty %s', skipped: true },
      { title: 'sparse %s', skipped: true },
      { title: 'hole %s', skipped: true },
      { title: 'spread only %s', skipped: true },
      { title: 'mixed spread %s', skipped: true },
      { title: 'non-literal %s', skipped: true },
      { title: 'options %s', skipped: true },
      { title: 'missing callback %s', skipped: true },
      { title: 'bracket it %s', skipped: true },
      { title: 'inside describe each', skipped: true },
      { title: 'inside empty each', skipped: true },
      { title: 'inside skipped each', skipped: true },
      { title: 'inside bracket each', skipped: true },
      { title: 'inside bracket empty each', skipped: true },
    ])
  })

  it('accepts .each callbacks that resolve in the file to a function declaration or a const function', () => {
    const src = `
function declared(n: number) { expect(n).toBeGreaterThan(0) }
const arrow = (n: number) => { expect(n).toBeGreaterThan(0) }
const expression = async function (n: number) { expect(n).toBeGreaterThan(0) }
it.each([1, 2])('it declared %s', declared)
test.each([1, 2])('test declared %s', declared)
it.each([1])('it arrow %s', arrow)
test.each([1])('test arrow %s', arrow)
test.concurrent.each([1])('concurrent expression %s', expression)
it.each([1])('hoisted %s', later)
function later() {}
describe('suite', () => {
  const nested = () => {}
  it.each([1])('nested const %s', nested)
})
`
    expect(tsTests(src)).toEqual([
      'it declared %s', 'test declared %s', 'it arrow %s', 'test arrow %s', 'concurrent expression %s', 'hoisted %s', 'nested const %s',
    ].map((title) => ({ title, skipped: false })))
  })

  it('fails closed on .each callbacks that do not statically resolve to a local, never-rebound function', () => {
    const src = `
import { imported } from './helpers'
import * as ns from './helpers'
let reassigned = () => {}
reassigned = () => {}
let unassigned = () => {}
var hoistedVar = function () {}
function rebound() {}
rebound = () => {}
function destructured() {}
;[destructured] = [() => {}]
const obj = { fn: () => {} }
const notFunction = 1
const { picked } = { picked: () => {} }
it.each([1])('imported %s', imported)
it.each([1])('namespace %s', ns.fn)
it.each([1])('reassigned let %s', reassigned)
it.each([1])('unassigned let %s', unassigned)
it.each([1])('var %s', hoistedVar)
it.each([1])('rebound function %s', rebound)
it.each([1])('destructured target %s', destructured)
it.each([1])('member %s', obj.fn)
it.each([1])('non-function const %s', notFunction)
it.each([1])('destructured const %s', picked)
it.each([1])('global %s', undeclared)
const table = [() => {}]
it.each([1])('computed %s', table[0])
function twice() {}
function twice() {}
it.each([1])('duplicate declarations %s', twice)
it.each([1])('const before init %s', arrowAfter)
const arrowAfter = () => {}
function wrapper(param: () => void) { it.each([1])('parameter %s', param) }
function shadow() { const declared = 1; it.each([1])('shadowed %s', declared) }
function declared() {}
it.each([1])('missing named callback %s')
it.each([1])('options then named %s', { skip: true }, declared)
it.each([])('empty with named %s', declared)
it.each([,])('sparse with named %s', declared)
it.each([...cases])('spread with named %s', declared)
it['each']([1])('bracket with named %s', declared)
it.skip.each([1])('skip with named %s', declared)
describe.each([1])('describe with named %s', declared)
`
    expect(tsTests(src).filter((t) => !t.skipped)).toEqual([])
    expect(tsTests(src).map((t) => t.title)).toEqual([
      'imported %s', 'namespace %s', 'reassigned let %s', 'unassigned let %s', 'var %s', 'rebound function %s', 'destructured target %s',
      'member %s', 'non-function const %s', 'destructured const %s', 'global %s', 'computed %s', 'duplicate declarations %s', 'const before init %s',
      'parameter %s', 'shadowed %s', 'missing named callback %s', 'options then named %s', 'empty with named %s',
      'sparse with named %s', 'spread with named %s', 'bracket with named %s', 'skip with named %s',
    ])
  })

  it('fails closed on same-named rebinding the symbol scan cannot see, ambient declarations and generators', () => {
    const cases: [string, string][] = [
      ['shorthand destructuring', 'function fn() {}\n;({ fn } = { fn: undefined as any })\nit.each([1])(\'t %s\', fn)'],
      ['shorthand default', 'function fn() {}\n;({ fn = undefined as any } = {})\nit.each([1])(\'t %s\', fn)'],
      ['shorthand for-of', 'function fn() {}\nfor ({ fn } of [{ fn: undefined as any }]) {}\nit.each([1])(\'t %s\', fn)'],
      ['nested shorthand', 'function fn() {}\n;([{ fn }] = [{ fn: undefined as any }])\nit.each([1])(\'t %s\', fn)'],
      ['var after function', "describe('s', () => {\n  function fn() {}\n  var fn: any = undefined\n  it.each([1])('t %s', fn)\n})"],
      ['var before function', "describe('s', () => {\n  var fn: any = undefined\n  function fn() {}\n  it.each([1])('t %s', fn)\n})"],
      ['var in block', "describe('s', () => {\n  function fn() {}\n  if (true) { var fn: any = undefined }\n  it.each([1])('t %s', fn)\n})"],
      ['var for-of', "describe('s', () => {\n  function fn() {}\n  for (var fn of [undefined as any]) {}\n  it.each([1])('t %s', fn)\n})"],
      ['var destructuring', "describe('s', () => {\n  function fn() {}\n  var { fn } = { fn: undefined as any }\n  it.each([1])('t %s', fn)\n})"],
      ['await using', 'await using fn = () => {}\nit.each([1])(\'t %s\', fn)'],
      ['declare const', 'declare const fn = () => {}\nit.each([1])(\'t %s\', fn)'],
      ['declare namespace', "declare namespace N { function fn() {}\n  it.each([1])('t %s', fn) }"],
      ['generator declaration', 'function* fn() {}\nit.each([1])(\'t %s\', fn)'],
      ['generator const', 'const fn = function* () {}\nit.each([1])(\'t %s\', fn)'],
      ['inline generator', "it.each([1])('t %s', function* () {})"],
    ]
    for (const [label, src] of cases) expect(tsTests(src).filter((t) => !t.skipped), label).toEqual([])
    expect(tsTests('function fn() {}\nconst o = { fn: 1 }\no.fn\nit.each([1])(\'t %s\', fn)\nfn()')).toEqual([{ title: 't %s', skipped: false }])
  })
})
