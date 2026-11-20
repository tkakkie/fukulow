export function sectionGeneration(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return
  const generation = BigInt(value)
  if (generation <= 9223372036854775807n) return generation
}
