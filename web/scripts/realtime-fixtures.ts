// Validates the shared real-time contract fixtures in contract/realtime/ and runs client scenarios.
//
//   node web/scripts/realtime-fixtures.ts [dir]     exit 1 and print every problem when a fixture is invalid
//
// Two parts:
// 1. checkFixtures(dir): validates every fixture file against contract/realtime/schema.json with a small
//    interpreter for the JSON Schema keywords the schema uses (no dependency), then checks cross-references
//    the schema cannot express (labels, sockets, Channels, respond_to pairing, seq lists).
// 2. runClientScenario(scenario, client): feeds a client scenario's inputs to a client and compares its
//    effects and observations with the fixture. It holds no sync logic; the client under test brings it.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const defaultDir = resolve(import.meta.dirname, '../../contract/realtime')

// ---------------------------------------------------------------------------------------------------------
// JSON Schema subset

type Json = unknown
type Schema = { [key: string]: Json }
const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)

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

// ---------------------------------------------------------------------------------------------------------
// Cross-reference checks (what the schema cannot say)

type SeqItem = number | { from: number; to: number }

/** Expands a SeqList; null when it is not strictly ascending (or a range is reversed). */
export function expandSeqs(list: SeqItem[]): number[] | null {
  const out: number[] = []
  for (const item of list) {
    const [from, to] = typeof item === 'number' ? [item, item] : [item.from, item.to]
    if (to < from) return null
    for (let n = from; n <= to; n++) out.push(n)
  }
  return out.every((n, i) => i === 0 || n > out[i - 1]) ? out : null
}

/** A stable key for a ChannelRef: object properties are sorted, so the key does not depend on JSON property order. */
const channelKey = (ref: Json): string =>
  isObject(ref) ? JSON.stringify(Object.keys(ref).sort().map((k) => [k, ref[k]])) : JSON.stringify(ref)

// Planned vocabulary (docs/spec.md 'Planned', P rules): allowed only in scenarios marked proposed.
const plannedTypes = new Set(['open_topic', 'load_main_timeline', 'main_timeline_result', 'fetch_main_timeline', 'main_timeline'])
const plannedKeys = new Set(['topic', 'topics', 'main_timeline', 'as_of_seq', 'before_position'])

/** The path of the first planned term in a scenario, or null. */
function plannedTerm(value: Json, path: string, delivery = false): string | null {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = plannedTerm(item, `${path}[${i}]`, delivery)
      if (found) return found
    }
    return null
  }
  if (!isObject(value)) return null
  for (const [key, item] of Object.entries(value)) {
    if (plannedKeys.has(key) && !(delivery && ['topic', 'as_of_seq', 'before_position'].includes(key))) return `${path}.${key}`
    if ((key === 'type' || key === 'do') && plannedTypes.has(item as string) && !(delivery && item === 'main_timeline')) return `${path}.${key} ${String(item)}`
    if (key === 'covers' && Array.isArray(item) && item.some((r) => String(r).startsWith('P') && !(delivery && ['P2', 'P5', 'P8'].includes(String(r))))) return `${path}.covers`
    const found = key === 'proposed' ? null : plannedTerm(item, `${path}.${key}`, delivery)
    if (found) return found
  }
  return null
}

/** Main-timeline lines: positions strictly ascending, each Topic at most once. */
function checkLines(list: Json, where: string, errors: string[]) {
  if (!Array.isArray(list)) return
  const lines = list as Record<string, Json>[]
  const at = lines.map((l) => (l.seq ?? l.position) as number)
  if (!at.every((n, i) => i === 0 || n > at[i - 1])) errors.push(`${where}: line positions must be strictly ascending`)
  const topics = lines.flatMap((l) => (typeof l.topic === 'string' ? [l.topic] : []))
  if (new Set(topics).size !== topics.length) errors.push(`${where}: a Topic appears more than once`)
}

/** API timeline items use nested Message/Topic records, unlike client display lines. */
function checkItems(list: Json, where: string, errors: string[]) {
  if (!Array.isArray(list)) return
  checkLines(list.map((item) => item.kind === 'message'
    ? { seq: item.message.seq }
    : { topic: item.topic.name, position: item.topic.last_seq }), where, errors)
}

function checkSeqList(list: Json, where: string, errors: string[]) {
  if (!Array.isArray(list)) return
  if (expandSeqs(list as SeqItem[]) === null) errors.push(`${where}: seq list must be strictly ascending (ranges from <= to)`)
}

function checkMessageSpec(m: Record<string, Json>, where: string, errors: string[], singular = false) {
  const single = 'seq' in m
  const range = 'from' in m && 'to' in m
  if (single === range) errors.push(`${where}: give seq, or from and to`)
  if (single && ('from' in m || 'to' in m)) errors.push(`${where}: seq cannot be combined with from/to`)
  if (singular && range) errors.push(`${where}: a single message cannot be a range (use seq, or messages for a range)`)
  if (range && (m.to as number) < (m.from as number)) errors.push(`${where}: from must be <= to`)
}

function checkDelivery(s: Record<string, Json>, where: string, errors: string[]) {
  const setup = s.setup as Record<string, Json[]>
  const orgs = new Set(setup.organizations as string[])
  const members = new Map<string, string>()
  for (const m of setup.members as { id: string; organization: string }[]) {
    if (members.has(m.id)) errors.push(`${where}: duplicate member ${m.id}`)
    if (!orgs.has(m.organization)) errors.push(`${where}: member ${m.id} uses undeclared organization ${m.organization}`)
    members.set(m.id, m.organization)
  }
  const channels = new Map<string, { organization: string; count?: number }>()
  for (const c of setup.channels as { id: string; organization: string; creator: string; visibility: string; members?: string[]; count?: number }[]) {
    if (channels.has(c.id)) errors.push(`${where}: duplicate channel ${c.id}`)
    channels.set(c.id, c)
    if (c.visibility === 'public' && c.members !== undefined) errors.push(`${where}: public channel ${c.id} cannot specify members`)
    if (!orgs.has(c.organization)) errors.push(`${where}: channel ${c.id} uses undeclared organization ${c.organization}`)
    for (const member of [c.creator, ...(c.members ?? [])]) {
      if (members.get(member) !== c.organization) errors.push(`${where}: channel ${c.id} member ${member} is not in organization ${c.organization}`)
    }
  }
  const unknown = new Set((setup.unknown_channels ?? []) as string[])
  for (const u of unknown) if (channels.has(u)) errors.push(`${where}: ${u} is both a channel and an unknown channel`)

  const checkChannel = (ref: Json, at: string, allowUnknown = true) => {
    const refs = isObject(ref) ? [{ name: ref.group as string, k: [ref.from as number, ref.to as number] }] : [parseRef(ref as string)]
    for (const r of refs) {
      if (r.name === undefined) continue
      const decl = channels.get(r.name)
      if (!decl) {
        if (!(allowUnknown && unknown.has(r.name) && r.k === undefined)) errors.push(`${at}: undeclared channel ${r.name}`)
        continue
      }
      if (r.k === undefined && decl.count !== undefined) errors.push(`${at}: ${r.name} is a counted group, use ${r.name}#k or a range`)
      if (r.k !== undefined && decl.count === undefined) errors.push(`${at}: ${r.name} is not a counted group`)
      if (r.k !== undefined && decl.count !== undefined && (r.k[0] > r.k[1] || r.k[0] < 1 || r.k[1] > decl.count)) errors.push(`${at}: range outside 1..${decl.count}`)
    }
  }
  const parseRef = (ref: string): { name: string; k?: [number, number] } => {
    const [name, k] = ref.split('#')
    return k === undefined ? { name } : { name, k: [Number(k), Number(k)] }
  }

  const sockets = new Set<string>()
  const postLabels = new Set<string>()
  const held = new Set<string>()
  const steps = s.steps as Record<string, Json>[]
  steps.forEach((step, i) => {
    const at = `${where}.steps[${i}]`
    const member = (name: Json) => {
      if (typeof name === 'string' && !members.has(name)) errors.push(`${at}: undeclared member ${name}`)
    }
    const socket = (name: Json) => {
      if (typeof name === 'string' && !sockets.has(name)) errors.push(`${at}: socket ${name} is not connected`)
    }
    switch (step.do) {
      case 'connect':
        member(step.as)
        if (step.expect_handshake === undefined) {
          if (sockets.has(step.socket as string)) errors.push(`${at}: socket ${step.socket} already connected`)
          sockets.add(step.socket as string)
        }
        break
      case 'close_socket':
        socket(step.socket)
        sockets.delete(step.socket as string)
        break
      case 'subscribe':
      case 'unsubscribe':
        socket(step.socket)
        checkChannel(step.channel, at)
        break
      case 'post':
        member(step.as)
        checkChannel(step.channel, at, false)
        if (typeof step.label === 'string') {
          if (postLabels.has(step.label)) errors.push(`${at}: duplicate post label ${step.label}`)
          postLabels.add(step.label)
        }
        break
      case 'hold_replay':
        checkChannel(step.channel, at, false)
        held.add(channelKey(step.channel))
        break
      case 'await_replay_held':
      case 'release_replay':
        checkChannel(step.channel, at, false)
        if (!held.has(channelKey(step.channel))) errors.push(`${at}: no hold_replay for this channel before`)
        if (step.do === 'release_replay') held.delete(channelKey(step.channel))
        break
      case 'remove_membership':
        member(step.member)
        checkChannel(step.channel, at, false)
        break
      case 'sign_out':
        member(step.member)
        break
      case 'mark_read':
      case 'unread':
        member(step.as)
        checkChannel(step.channel, at, false)
        break
      case 'history':
        member(step.as)
        checkChannel(step.channel, at)
        checkSeqList((step.expect as Record<string, Json>).seqs, `${at}.expect.seqs`, errors)
        break
      case 'main_timeline':
        member(step.as)
        checkChannel(step.channel, at, false)
        checkItems((step.expect as Record<string, Json>).items, `${at}.expect.items`, errors)
        break
      case 'expect': {
        socket(step.socket)
        const events = step.events as Record<string, Json>[]
        events.forEach((e, j) => {
          const ea = `${at}.events[${j}]`
          if (e.type === 'silent' && j !== events.length - 1) errors.push(`${ea}: silent must be the last event`)
          if (e.type === 'message') {
            if (e.seqs === undefined && e.from_post === undefined) errors.push(`${ea}: message needs seqs or from_post`)
            if (Array.isArray(e.seqs) && e.seqs.length === 0) errors.push(`${ea}.seqs: message needs at least one seq when seqs is specified`)
            if (typeof e.from_post === 'string' && !postLabels.has(e.from_post)) errors.push(`${ea}: from_post ${e.from_post} is not a label of an earlier post`)
            checkSeqList(e.seqs, `${ea}.seqs`, errors)
          }
          if (e.channel !== undefined) checkChannel(e.channel, ea)
          if (e.type === 'silent') checkChannel((e.barrier as Record<string, Json>).channel, `${ea}.barrier`, false)
          if (e.type === 'error' && e.code === 'channel_not_found' && e.channel === undefined) errors.push(`${ea}: channel_not_found needs a channel`)
        })
        break
      }
    }
  })
  for (const label of held) errors.push(`${where}: replay held for ${label} is never released`)
}

const respondsTo: Record<string, string> = {
  ack: 'send',
  send_failed: 'send',
  history_result: 'fetch_history',
  history_failed: 'fetch_history',
  subscribed: 'subscribe',
  timer_elapsed: 'wait',
  membership_check_result: 'membership_check',
  main_timeline_result: 'fetch_main_timeline',
}

function checkClient(s: Record<string, Json>, where: string, errors: string[]) {
  const labels = new Map<string, string>() // label -> effect type, for labels that are surely bound
  const declared = new Set<string>() // every label some pattern may bind (a label of one any_of alternative may stay unbound)
  const steps = s.steps as Record<string, Json>[]
  const patterns = (list: Json): Record<string, Json>[] =>
    ((list ?? []) as Record<string, Json>[]).flatMap((p) => (Array.isArray(p.any_of) ? (p.any_of as Record<string, Json>[]) : [p]))
  for (const [i, p] of patterns(s.never).entries()) {
    if (p.as !== undefined) errors.push(`${where}.never[${i}]: a never pattern cannot bind a label`)
  }
  steps.forEach((step, i) => {
    const at = `${where}.steps[${i}]`
    const input = step.input as Record<string, Json>
    const type = input.type as string
    if (type in respondsTo && input.respond_to !== undefined) {
      const bound = labels.get(input.respond_to as string)
      if (bound === undefined) errors.push(`${at}.input: respond_to ${input.respond_to} is not bound by an earlier step`)
      else if (bound !== respondsTo[type]) errors.push(`${at}.input: ${type} answers a ${respondsTo[type]} effect, but ${input.respond_to} is a ${bound} effect`)
    }
    if (isObject(input.message)) checkMessageSpec(input.message, `${at}.input.message`, errors, true)
    checkItems(input.items, `${at}.input.items`, errors)
    if (Array.isArray(input.messages)) {
      (input.messages as Record<string, Json>[]).forEach((m, j) => checkMessageSpec(m, `${at}.input.messages[${j}]`, errors))
      const flat = (input.messages as Record<string, Json>[]).flatMap((m) => ('seq' in m ? [m.seq as number] : 'to' in m ? [m.from as number, m.to as number] : []))
      if (!flat.every((n, j) => j === 0 || n > flat[j - 1])) errors.push(`${at}.input.messages: seqs must be ascending`)
    }
    const effects = (step.effects ?? {}) as Record<string, Json[]>
    for (const p of patterns(effects.forbidden)) if (p.as !== undefined) errors.push(`${at}.effects.forbidden: a forbidden pattern cannot bind a label`)
    const newlyBound = new Map<string, string>()
    for (const [r, requirement] of ((effects.required ?? []) as Record<string, Json>[]).entries()) {
      const alternatives = Array.isArray(requirement.any_of) ? (requirement.any_of as Record<string, Json>[]) : [requirement]
      if (Array.isArray(requirement.any_of) && alternatives.some((p) => p.times !== undefined)) {
        errors.push(`${at}.effects.required[${r}]: times is not allowed inside any_of (count the alternatives separately)`)
      }
      // Alternatives of one requirement may share a label (only one binds); duplicates are checked across requirements.
      const own = new Set(alternatives.flatMap((p) => (typeof p.as === 'string' ? [p.as] : [])))
      for (const label of own) {
        if (declared.has(label)) errors.push(`${at}.effects.required: duplicate label ${label}`)
        declared.add(label)
      }
      // Only the matched alternative binds at run time: a label is usable when every alternative binds it to the same effect type.
      const first = alternatives[0]
      if (typeof first.as === 'string' && first.times !== 0 && alternatives.every((p) => p.as === first.as && p.type === first.type)) newlyBound.set(first.as, first.type as string)
    }
    for (const [label, effectType] of newlyBound) labels.set(label, effectType)
    const channels = ((step.observe ?? {}) as { channels?: Record<string, Record<string, Json>> }).channels ?? {}
    for (const [name, observed] of Object.entries(channels)) {
      checkSeqList(observed.visible, `${at}.observe.channels.${name}.visible`, errors)
      checkLines(observed.main_timeline, `${at}.observe.channels.${name}.main_timeline`, errors)
      for (const [topic, view] of Object.entries((observed.topics ?? {}) as Record<string, Record<string, Json>>)) {
        checkSeqList(view.visible, `${at}.observe.channels.${name}.topics.${topic}.visible`, errors)
      }
      for (const r of (observed.records ?? []) as { seq: number }[]) {
        if (observed.visible !== undefined && !expandSeqs(observed.visible as SeqItem[])?.includes(r.seq)) errors.push(`${at}.observe.channels.${name}.records: seq ${r.seq} is not in visible`)
      }
    }
  })
}

export type Problems = string[]

/** All problems of the fixture directory; an empty list means every fixture is valid. */
export function checkFixtures(dir: string = defaultDir): Problems {
  const errors: string[] = []
  let schema: Schema
  try {
    schema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8')) as Schema
  } catch (e) {
    return [`schema.json: ${(e as Error).message}`]
  }
  const ids = new Map<string, string>()
  let files = 0
  for (const kind of ['delivery', 'client'] as const) {
    let names: string[] = []
    try {
      names = readdirSync(join(dir, kind)).filter((n) => !n.startsWith('.'))
    } catch {
      errors.push(`${kind}/: directory is missing`)
    }
    for (const name of names.sort()) {
      const file = `${kind}/${name}`
      if (!name.endsWith('.json')) {
        errors.push(`${file}: only .json files belong here`)
        continue
      }
      files++
      let data: Json
      try {
        data = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      } catch (e) {
        errors.push(`${file}: invalid JSON (${(e as Error).message})`)
        continue
      }
      const problems = validateSchema(data, schema, schema)
      errors.push(...problems.map((p) => `${file}: ${p}`))
      if (problems.length > 0 || !isObject(data)) continue
      if (data.kind !== kind) errors.push(`${file}: kind "${String(data.kind)}" does not match the directory ${kind}/`)
      ;(data.scenarios as Record<string, Json>[]).forEach((scenario, i) => {
        const where = `${file}: scenarios[${i}] (${String(scenario.id)})`
        const isDelivery = 'setup' in scenario
        if (isDelivery !== (kind === 'delivery')) errors.push(`${where}: shape is a ${isDelivery ? 'delivery' : 'client'} scenario, but the file is in ${kind}/`)
        const previous = ids.get(scenario.id as string)
        if (previous) errors.push(`${where}: id also used in ${previous}`)
        ids.set(scenario.id as string, file)
        if (isDelivery) checkDelivery(scenario, where, errors)
        else checkClient(scenario, where, errors)
        // Only the implemented delivery rules leave the planned vocabulary gate.
        // Client projection inputs, observations and even negative patterns stay gated.
        const planned = scenario.proposed === undefined
          ? plannedTerm(scenario, '$', isDelivery)
          : null
        if (planned) errors.push(`${where}: ${planned} is planned vocabulary; mark the scenario proposed (owner Issue) until it is implemented`)
      })
    }
  }
  if (files === 0) errors.push('no fixture files found')
  return errors
}

// ---------------------------------------------------------------------------------------------------------
// Client scenario runner

export type Effect = { type: string; [field: string]: unknown }
export type Message = { seq: number; id: string; sender: string; client_message_id: string; body: string; created_at: string }
/** The fixture input with respond_to replaced by the effect (as the client emitted it) it answers, and messages expanded. */
export type ResolvedInput = { type: string; respond_to?: Effect; message?: Message; messages?: Message[]; [field: string]: unknown }
export type ObservedChannel = {
  state?: string
  cursor: number | null
  messages: Message[]
  pending: { client_message_id: string; state: string }[]
}
export type Observed = { session?: string; organization?: string; channels: Record<string, ObservedChannel> }
/** What a client must provide to run fixtures. */
export type ClientUnderTest = { feed(input: ResolvedInput): Effect[]; observe(): Observed }

type Pattern = Record<string, Json>
type ClientStep = {
  input: Record<string, Json>
  only_if?: 'connect_pending' | 'socket_open'
  effects?: { required?: Pattern[]; forbidden?: Pattern[]; ordered?: boolean }
  observe?: { session?: string; organization?: string; channels?: Record<string, Record<string, Json>> }
}
export type Proposed = { owner: string[]; note?: string }
export type ClientScenario = { id: string; proposed?: Proposed; layer?: 'controller'; never?: Pattern[]; steps: ClientStep[] }

/** Scenarios to run, and proposed ones (validated, skipped by runners until their owner implements them). */
export function partitionScenarios<T extends { proposed?: Proposed }>(all: T[]): { running: T[]; proposed: T[] } {
  return { running: all.filter((s) => s.proposed === undefined), proposed: all.filter((s) => s.proposed !== undefined) }
}

export function expandMessage(spec: Record<string, Json>, channel?: string): Message[] {
  const seqs = 'seq' in spec ? [spec.seq as number] : Array.from({ length: (spec.to as number) - (spec.from as number) + 1 }, (_, i) => (spec.from as number) + i)
  return seqs.map((seq) => ({
    seq,
    id: (spec.id as string | undefined) ?? `id${seq}`,
    sender: (spec.sender as string | undefined) ?? 'other',
    client_message_id: (spec.client_message_id as string | undefined) ?? `auto-${channel ?? 'x'}-${seq}`,
    body: (spec.body as string | undefined) ?? `m${seq}`,
    created_at: (spec.created_at as string | undefined) ?? `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
  }))
}

const matches = (effect: Effect, pattern: Pattern) =>
  Object.entries(pattern).every(([k, v]) => k === 'as' || k === 'times' || effect[k] === v)

/** Runs a client scenario; returns the failures (empty = the client satisfies the scenario). */
export function runClientScenario(scenario: ClientScenario, client: ClientUnderTest): string[] {
  const inputs = scenarioInputs(scenario)
  let next = inputs.next()
  while (!next.done) {
    const effects = client.feed(next.value)
    next = inputs.next({ effects, observation: client.observe() })
  }
  return next.value
}

/** The same assertions, with real asynchronous controller completions between inputs. */
export async function runClientScenarioAsync(scenario: ClientScenario, client: {
  feed(input: ResolvedInput): Promise<Effect[]>; observe(): Observed
}): Promise<string[]> {
  const inputs = scenarioInputs(scenario)
  let next = inputs.next()
  while (!next.done) {
    const effects = await client.feed(next.value)
    next = inputs.next({ effects, observation: client.observe() })
  }
  return next.value
}

function* scenarioInputs(scenario: ClientScenario): Generator<ResolvedInput, string[], { effects: Effect[]; observation: Observed }> {
  const failures: string[] = []
  const bound = new Map<string, Effect>()
  let connectPending = false
  let socketOpen = false
  for (const [index, step] of scenario.steps.entries()) {
    const at = `${scenario.id} step ${index + 1} (${String(step.input.type)})`
    if (step.only_if === 'connect_pending' && !connectPending) continue
    if (step.only_if === 'socket_open' && !socketOpen) continue
    const input: ResolvedInput = { ...step.input, type: step.input.type as string }
    if (typeof step.input.respond_to === 'string') {
      const effect = bound.get(step.input.respond_to)
      if (!effect) {
        failures.push(`${at}: no effect was bound to ${step.input.respond_to}`)
        continue
      }
      input.respond_to = effect
    }
    const channelOf = (effect?: Effect) => (effect?.channel as string | undefined) ?? (step.input.channel as string | undefined)
    if (isObject(step.input.message)) {
      const expanded = expandMessage(step.input.message, channelOf(input.respond_to))
      if (expanded.length !== 1) {
        failures.push(`${at}: input.message must be one Message, not a range`)
        continue
      }
      input.message = expanded[0]
    }
    if (Array.isArray(step.input.messages)) {
      input.messages = (step.input.messages as Record<string, Json>[]).flatMap((m) => expandMessage(m, channelOf(input.respond_to)))
    }
    if (input.type === 'connection_ready') [connectPending, socketOpen] = [false, true]
    if (input.type === 'socket_closed') socketOpen = false
    const { effects: emitted, observation } = yield input
    if (emitted.some((e) => e.type === 'connect')) connectPending = true
    checkEffects(step, emitted, bound, at, failures)
    for (const p of scenario.never ?? []) {
      if (emitted.some((e) => matches(e, p))) failures.push(`${at}: emitted a never-effect ${JSON.stringify(p)}`)
    }
    if (step.observe) checkObservation(step.observe, observation, at, failures)
  }
  return failures
}

function checkEffects(step: ClientStep, emitted: Effect[], bound: Map<string, Effect>, at: string, failures: string[]) {
  const required = step.effects?.required ?? []
  const firstIndex: number[] = []
  for (const requirement of required) {
    const anyOf = Array.isArray(requirement.any_of)
    const options = anyOf ? (requirement.any_of as Pattern[]) : [requirement]
    const found = options.flatMap((p) => emitted.filter((e) => matches(e, p)).map((e) => ({ e, p })))
    if (!anyOf && requirement.times === 0) {
      if (found.length > 0) failures.push(`${at}: expected 0 of ${JSON.stringify(requirement)}, got ${found.length}`)
      continue
    }
    if (found.length === 0) {
      failures.push(`${at}: missing required effect ${JSON.stringify(requirement)}; emitted ${JSON.stringify(emitted)}`)
      continue
    }
    const { e, p } = found[0]
    if (!anyOf && typeof p.times === 'number' && found.length !== p.times) {
      failures.push(`${at}: expected ${p.times} of ${JSON.stringify(p)}, got ${found.length}`)
    }
    if (typeof p.as === 'string') bound.set(p.as, e)
    firstIndex.push(emitted.indexOf(e))
  }
  if (step.effects?.ordered && firstIndex.some((n, i) => i > 0 && n <= firstIndex[i - 1])) {
    failures.push(`${at}: required effects were not emitted in the listed order`)
  }
  for (const pattern of step.effects?.forbidden ?? []) {
    if (emitted.some((e) => matches(e, pattern))) failures.push(`${at}: emitted forbidden effect ${JSON.stringify(pattern)}`)
  }
}

function checkObservation(expected: NonNullable<ClientStep['observe']>, actual: Observed, at: string, failures: string[]) {
  if (expected.session !== undefined && actual.session !== expected.session) {
    failures.push(`${at}: session is ${String(actual.session)}, expected ${expected.session}`)
  }
  if (expected.organization !== undefined && actual.organization !== expected.organization) {
    failures.push(`${at}: organization is ${String(actual.organization)}, expected ${expected.organization}`)
  }
  for (const [name, want] of Object.entries(expected.channels ?? {})) {
    const got = actual.channels[name] ?? { cursor: null, messages: [], pending: [] }
    const where = `${at}: channel ${name}`
    if (want.state !== undefined && got.state !== want.state) failures.push(`${where} state is ${String(got.state)}, expected ${String(want.state)}`)
    if (want.cursor !== undefined && got.cursor !== want.cursor) failures.push(`${where} cursor is ${String(got.cursor)}, expected ${String(want.cursor)}`)
    if (want.visible !== undefined) {
      const wanted = expandSeqs(want.visible as SeqItem[]) ?? []
      const seen = got.messages.map((m) => m.seq)
      if (JSON.stringify(seen) !== JSON.stringify(wanted)) failures.push(`${where} visible is ${JSON.stringify(seen)}, expected ${JSON.stringify(wanted)}`)
    }
    if (want.pending !== undefined) {
      const key = (p: { client_message_id: unknown; state: unknown }) => `${String(p.client_message_id)}:${String(p.state)}`
      const seen = got.pending.map(key).sort()
      const wanted = (want.pending as { client_message_id: string; state: string }[]).map(key).sort()
      if (JSON.stringify(seen) !== JSON.stringify(wanted)) failures.push(`${where} pending is ${JSON.stringify(seen)}, expected ${JSON.stringify(wanted)}`)
    }
    for (const check of (want.records ?? []) as Record<string, Json>[]) {
      const message = got.messages.find((m) => m.seq === check.seq)
      if (!message) {
        failures.push(`${where} holds no Message ${String(check.seq)}`)
        continue
      }
      for (const [k, v] of Object.entries(check)) {
        if (k !== 'seq' && (message as Record<string, unknown>)[k] !== v) failures.push(`${where} Message ${String(check.seq)} ${k} is ${String((message as Record<string, unknown>)[k])}, expected ${String(v)}`)
      }
    }
  }
}

/** Loads one client scenario of the committed fixtures by id (for client runners). */
export function loadClientScenario(id: string, dir: string = defaultDir): ClientScenario {
  for (const name of readdirSync(join(dir, 'client'))) {
    const file = JSON.parse(readFileSync(join(dir, 'client', name), 'utf8')) as { scenarios: ClientScenario[] }
    const found = file.scenarios.find((s) => s.id === id)
    if (found) return found
  }
  throw new Error(`no client scenario ${id}`)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : defaultDir
  const problems = checkFixtures(dir)
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in ${dir}:`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`realtime fixtures OK (${dir})`)
  for (const kind of ['delivery', 'client']) {
    const all = readdirSync(join(dir, kind)).filter((n) => n.endsWith('.json'))
      .flatMap((n) => (JSON.parse(readFileSync(join(dir, kind, n), 'utf8')) as { scenarios: { id: string; proposed?: Proposed }[] }).scenarios)
    const { running, proposed } = partitionScenarios(all)
    console.log(`  ${kind}: ${running.length} running, ${proposed.length} proposed (skipped by runners)`)
    for (const s of proposed) console.log(`    proposed ${s.id} (owner ${s.proposed!.owner.join(', ')})`)
  }
}
