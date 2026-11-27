import { describe, expect, it } from 'vitest'
import { validateSchema } from './json-schema-subset.ts'

describe('validateSchema oneOf', () => {
  const numeric = { oneOf: [{ type: 'number' }, { type: 'integer' }] }

  it('rejects a value that matches more than one alternative', () => {
    expect(validateSchema(1, numeric, numeric)).toEqual([
      '$: matches more than one alternative',
    ])
  })

  it('reports the selected branch errors for a known discriminator', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'circle' } } },
        { type: 'object', properties: { kind: { const: 'rectangle' } }, required: ['width', 'height'] },
      ],
    }

    expect(validateSchema({ kind: 'rectangle' }, schema, schema)).toEqual([
      '$: missing required property "width"',
      '$: missing required property "height"',
    ])
  })

  it('summarizes the closest alternative when no alternative matches and there is no discriminator', () => {
    const schema = {
      oneOf: [
        { type: 'object', required: ['width', 'height'] },
        { type: 'object', required: ['radius'] },
      ],
    }

    expect(validateSchema({}, schema, schema)).toEqual([
      '$: matches no alternative (closest: $: missing required property "radius")',
    ])
  })

  it('accepts a value that matches exactly one alternative', () => {
    expect(validateSchema(1.5, numeric, numeric)).toEqual([])
  })
})
