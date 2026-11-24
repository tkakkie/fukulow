// A small interpreter for the JSON Schema keywords contract/realtime/schema.json uses (no dependency).

export type Json = unknown
export type Schema = { [key: string]: Json }
export const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)

const typeOf = (v: Json): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v

/** Errors of `value` against `schema` (an empty list means valid). Supports the keywords listed in schema.json. */
export function validateSchema(value: Json, schema: Schema, root: Schema, path = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '')
    const target = (root.$defs as Record<string, Schema>)[name]
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`]
    return validateSchema(value, target, root, path)
  }
  const errors: string[] = []
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    if (!types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) {
      return [`${path}: expected ${types.join(' or ')}, got ${actual}`]
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path}: ${value} is below the minimum ${schema.minimum}`)
  }
  if (typeof schema.pattern === 'string' && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: needs at most ${schema.maxItems} items`)
    if (isObject(schema.items)) value.forEach((item, i) => errors.push(...validateSchema(item, schema.items as Schema, root, `${path}[${i}]`)))
  }
  if (isObject(value)) {
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`)
    }
    const properties = (schema.properties ?? {}) as Record<string, Schema>
    for (const [key, item] of Object.entries(value)) {
      const child = `${path}.${key}`
      if (key in properties) errors.push(...validateSchema(item, properties[key], root, child))
      else if (schema.additionalProperties === false) errors.push(`${child}: unknown property`)
      else if (isObject(schema.additionalProperties)) errors.push(...validateSchema(item, schema.additionalProperties, root, child))
    }
  }
  if (Array.isArray(schema.oneOf)) errors.push(...oneOf(value, schema.oneOf as Schema[], root, path))
  return errors
}

const discriminators = ['do', 'type', 'kind']

function oneOf(value: Json, branches: Schema[], root: Schema, path: string): string[] {
  const results = branches.map((branch) => validateSchema(value, branch, root, path))
  const matching = results.filter((r) => r.length === 0).length
  if (matching === 1) return []
  if (matching > 1) return [`${path}: matches more than one alternative`]
  // No branch matched: report the branch whose discriminator (do / type / kind) equals the value's, else the summary.
  if (isObject(value)) {
    for (const key of discriminators) {
      if (!(key in value)) continue
      const index = branches.findIndex((b) => resolve$(b, root).properties && (resolve$(b, root).properties as Record<string, Schema>)[key]?.const === value[key])
      if (index >= 0) return results[index]
    }
    for (const key of discriminators) {
      if (key in value) return [`${path}: unknown ${key} ${JSON.stringify(value[key])}`]
    }
  }
  const shortest = results.reduce((a, b) => (b.length < a.length ? b : a))
  return [`${path}: matches no alternative (closest: ${shortest[0]})`]
}

function resolve$(schema: Schema, root: Schema): Schema {
  if (typeof schema.$ref !== 'string') return schema
  return (root.$defs as Record<string, Schema>)[schema.$ref.replace('#/$defs/', '')] ?? schema
}

