import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkFixtures,
  defaultDir,
  expandSeqs,
  loadClientScenario,
  runClientScenario,
  type ClientScenario,
  type ClientUnderTest,
  type Effect,
  type Message,
  type ResolvedInput,
} from './realtime-fixtures.ts'

const script = join(import.meta.dirname, 'realtime-fixtures.ts')

// A minimal valid delivery fixture and client fixture, written to a temp directory with the real schema.
const delivery = {
  kind: 'delivery',
  scenarios: [
    {
      id: 'valid-delivery',
      title: 'valid',
      covers: ['S2'],
      rust: { existing_tests: [] },
      setup: {
        organizations: ['o1'],
        members: [{ id: 'alice', organization: 'o1' }],
        channels: [{ id: 'general', organization: 'o1', visibility: 'public', creator: 'alice', messages: 2 }],
      },
      steps: [
        { do: 'connect', socket: 's1', as: 'alice' },
        { do: 'subscribe', socket: 's1', channel: 'general', after_seq: 0 },
        { do: 'expect', socket: 's1', events: [{ type: 'message', channel: 'general', seqs: [{ from: 1, to: 2 }] }, { type: 'subscribed', channel: 'general', caught_up_seq: 2 }] },
      ],
    },
  ],
}
const client = {
  kind: 'client',
  scenarios: [
    {
      id: 'valid-client',
      title: 'valid',
      covers: ['C2'],
      steps: [
        { input: { type: 'watch', channel: 'A' }, effects: { required: [{ type: 'fetch_history', channel: 'A', page: 'latest', as: 'f0' }] } },
        { input: { type: 'history_result', respond_to: 'f0', messages: [{ from: 1, to: 3 }], has_more: false }, observe: { channels: { A: { cursor: 3, visible: [{ from: 1, to: 3 }] } } } },
      ],
    },
  ],
}

type Mutate = (files: { delivery: any; client: any }) => void
/** Writes the minimal fixtures (after `mutate`) next to the real schema; `raw` replaces a file's text. */
function fixtureDir(mutate: Mutate = () => {}, raw?: { file: string; text: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'realtime-fixtures-'))
  mkdirSync(join(dir, 'delivery'))
  mkdirSync(join(dir, 'client'))
  cpSync(join(defaultDir, 'schema.json'), join(dir, 'schema.json'))
  const files = { delivery: structuredClone(delivery), client: structuredClone(client) }
  mutate(files)
  writeFileSync(join(dir, 'delivery/valid.json'), JSON.stringify(files.delivery))
  writeFileSync(join(dir, 'client/valid.json'), JSON.stringify(files.client))
  if (raw) writeFileSync(join(dir, raw.file), raw.text)
  return dir
}
const problemsOf = (mutate: Mutate, raw?: { file: string; text: string }) => checkFixtures(fixtureDir(mutate, raw)).join('\n')

describe('realtime fixtures: the committed contract/realtime/', () => {
  it('is valid (this is the CI gate: a broken fixture fails npm test)', () => {
    expect(checkFixtures(defaultDir)).toEqual([])
  })

  it('has delivery and client scenarios with unique ids', () => {
    const ids = (kind: string) => readFileSync(join(defaultDir, kind, kind === 'client' ? 'order-and-gaps.json' : 'history.json'), 'utf8')
    expect(ids('client')).toContain('out-of-order-ack-and-websocket')
    expect(ids('delivery')).toContain('"kind": "delivery"')
  })
})

describe('realtime fixtures: validation', () => {
  it('accepts the minimal valid fixtures (positive control)', () => {
    expect(checkFixtures(fixtureDir())).toEqual([])
  })

  it('rejects malformed JSON', () => {
    expect(problemsOf(() => {}, { file: 'client/broken.json', text: '{ "kind": "client", ' })).toContain('client/broken.json: invalid JSON')
  })

  it('rejects a schema-invalid file: missing required, unknown property, bad enum, bad pattern', () => {
    expect(problemsOf((f) => delete f.client.scenarios[0].steps)).toContain('missing required property "steps"')
    expect(problemsOf((f) => (f.client.scenarios[0].extra = 1))).toContain('unknown property')
    expect(problemsOf((f) => (f.client.scenarios[0].covers = ['C42']))).toContain('expected one of')
    expect(problemsOf((f) => (f.client.scenarios[0].id = 'Not Kebab'))).toContain('does not match')
    expect(problemsOf((f) => (f.delivery.scenarios[0].steps[1].do = 'subscribe_all'))).toContain('unknown do "subscribe_all"')
    expect(problemsOf((f) => (f.client.scenarios[0].steps[1].input.has_more = 'no'))).toContain('expected boolean')
  })

  it('rejects a non-fixture file and a kind that does not match its directory', () => {
    expect(problemsOf(() => {}, { file: 'client/notes.txt', text: 'x' })).toContain('only .json files')
    expect(problemsOf((f) => (f.client.kind = 'delivery'))).toContain('does not match the directory')
  })

  it('rejects a delivery scenario in the client directory (and the reverse)', () => {
    const dir = fixtureDir()
    writeFileSync(join(dir, 'client/wrong.json'), JSON.stringify(delivery).replace('valid-delivery', 'other-delivery'))
    expect(checkFixtures(dir).join('\n')).toMatch(/client\/wrong\.json/)
  })

  it('rejects duplicate scenario ids across files', () => {
    expect(problemsOf((f) => (f.client.scenarios[0].id = 'valid-delivery'))).toContain('id also used in')
  })

  it('only treats an any_of label as bound when every alternative binds it to the same effect type', () => {
    const respond = (f: any) => (f.client.scenarios[0].steps[1].input = { type: 'ack', respond_to: 'x', message: { seq: 1 } })
    const withAnyOf = (alternatives: unknown[]) => (f: any) => {
      f.client.scenarios[0].steps[0].effects.required = [{ any_of: alternatives }]
      respond(f)
    }
    expect(problemsOf(withAnyOf([{ type: 'send', as: 'x' }, { type: 'wait' }]))).toContain('respond_to x is not bound')
    expect(problemsOf(withAnyOf([{ type: 'send', as: 'x' }, { type: 'wait', as: 'x' }]))).toContain('respond_to x is not bound')
    expect(problemsOf(withAnyOf([{ type: 'send', as: 'x', channel: 'A' }, { type: 'send', as: 'x', channel: 'B' }]))).toBe('')
    expect(problemsOf((f: any) => {
      f.client.scenarios[0].steps[0].effects.required = [{ type: 'send', times: 0, as: 'x' }]
      respond(f)
    })).toContain('respond_to x is not bound')
  })

  it('rejects times inside any_of and a range for the singular message', () => {
    expect(problemsOf((f) => (f.client.scenarios[0].steps[0].effects.required = [{ any_of: [{ type: 'send', times: 1 }, { type: 'wait' }] }]))).toContain('times is not allowed inside any_of')
    expect(problemsOf((f) => (f.client.scenarios[0].steps[1].input = { type: 'message', channel: 'A', message: { from: 1, to: 2 } }))).toContain('a single message cannot be a range')
  })

  it('compares replay gate channels independent of JSON property order', () => {
    const ref = (order: 'a' | 'b') => (order === 'a' ? { group: 'g', from: 1, to: 2 } : { to: 2, group: 'g', from: 1 })
    const gate = (f: any) => {
      const d = f.delivery.scenarios[0]
      d.setup.channels.push({ id: 'g', organization: 'o1', visibility: 'public', creator: 'alice', count: 2, messages: 1 })
      d.steps.push({ do: 'hold_replay', channel: ref('a') }, { do: 'release_replay', channel: ref('b') })
    }
    expect(problemsOf(gate)).not.toContain('no hold_replay')
  })

  it('names the channel_not_found rule correctly', () => {
    expect(problemsOf((f) => f.delivery.scenarios[0].steps[2].events.push({ type: 'error', code: 'channel_not_found' }))).toContain('channel_not_found needs a channel')
  })

  it('rejects dangling references in client scenarios', () => {
    expect(problemsOf((f) => (f.client.scenarios[0].steps[1].input.respond_to = 'nope'))).toContain('not bound by an earlier step')
    expect(problemsOf((f) => (f.client.scenarios[0].steps[1].input = { type: 'ack', respond_to: 'f0', message: { seq: 1 } }))).toContain('answers a send effect')
    expect(problemsOf((f) => f.client.scenarios[0].steps[1].input.messages.push({ seq: 2, from: 2, to: 3 }))).toContain('seq cannot be combined')
    expect(problemsOf((f) => (f.client.scenarios[0].steps[1].observe.channels.A.visible = [3, 2]))).toContain('strictly ascending')
    expect(problemsOf((f) => (f.client.scenarios[0].never = [{ type: 'send', as: 'x' }]))).toContain('cannot bind a label')
  })

  it('rejects dangling references in delivery scenarios', () => {
    expect(problemsOf((f) => (f.delivery.scenarios[0].steps[1].socket = 'ghost'))).toContain('socket ghost is not connected')
    expect(problemsOf((f) => (f.delivery.scenarios[0].steps[1].channel = 'nowhere'))).toContain('undeclared channel nowhere')
    expect(problemsOf((f) => (f.delivery.scenarios[0].steps[0].as = 'mallory'))).toContain('undeclared member mallory')
    expect(problemsOf((f) => (f.delivery.scenarios[0].steps[2].events[0].seqs = [2, 1]))).toContain('strictly ascending')
    expect(problemsOf((f) => (f.delivery.scenarios[0].steps[2].events.unshift({ type: 'silent' })))).toContain('silent must be the last')
    expect(problemsOf((f) => (f.delivery.scenarios[0].steps[2].events[0] = { type: 'message', channel: 'general', from_post: 'p9' }))).toContain('from_post p9')
    expect(problemsOf((f) => f.delivery.scenarios[0].steps.splice(1, 0, { do: 'hold_replay', channel: 'general' }))).toContain('never released')
  })

  it('expands seq lists and rejects descending ones', () => {
    expect(expandSeqs([{ from: 1, to: 3 }, 7])).toEqual([1, 2, 3, 7])
    expect(expandSeqs([])).toEqual([])
    expect(expandSeqs([3, 3])).toBeNull()
    expect(expandSeqs([{ from: 5, to: 4 }])).toBeNull()
  })
})

describe('realtime fixtures: the CI entry point fails on an invalid fixture', () => {
  const run = (dir?: string) => spawnSync(process.execPath, dir ? [script, dir] : [script], { encoding: 'utf8' })

  it('exits 0 for the committed fixtures', () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('realtime fixtures OK')
  })

  it('exits 1 and names the file for a malformed, a schema-invalid and a dangling fixture', () => {
    for (const [mutate, raw, expected] of [
      [() => {}, { file: 'delivery/broken.json', text: '[' }, 'delivery/broken.json: invalid JSON'],
      [(f: { client: any }) => delete f.client.scenarios[0].title, undefined, 'missing required property "title"'],
      [(f: { client: any }) => (f.client.scenarios[0].steps[1].input.respond_to = 'nope'), undefined, 'not bound by an earlier step'],
    ] as const) {
      const result = run(fixtureDir(mutate as Mutate, raw))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(expected)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------
// Client pilot: proves a client scenario is executable. This file holds no sync protocol.

/**
 * THROWAWAY stand-in for the pilot only (removed when #96 lands). It understands exactly the inputs of the
 * out-of-order trace and keeps just enough state to answer them; it is not the sync protocol. The options
 * break it on purpose so the tests show the runner fails a client that violates the fixture.
 */
function pilotStandIn(bug: 'fills-at-once' | 'cursor-jumps-on-ack' | 'stale-timer-fills' | null = null): ClientUnderTest {
  const held = new Map<number, Message>()
  let cursor: number | null = null
  let pending: { client_message_id: string; state: string }[] = []
  let requests = 0
  const advance = () => {
    while (cursor !== null && held.has(cursor + 1)) cursor++
  }
  const fill = (): Effect[] => [{ type: 'fetch_history', channel: 'A', page: 'after', seq: cursor, request: ++requests }]
  return {
    feed(input: ResolvedInput) {
      switch (input.type) {
        case 'session_start':
          return [{ type: 'connect' }]
        case 'watch':
          return [{ type: 'fetch_history', channel: 'A', page: 'latest', request: ++requests }]
        case 'history_result':
          for (const m of input.messages ?? []) held.set(m.seq, m)
          cursor = Math.max(...held.keys())
          return [{ type: 'subscribe', channel: 'A', after_seq: cursor }]
        case 'user_send':
          pending = [{ client_message_id: input.client_message_id as string, state: 'sending' }]
          return [{ type: 'send', channel: 'A', client_message_id: input.client_message_id }]
        case 'ack': {
          const m = input.message as Message
          pending = []
          held.set(m.seq, m)
          if (bug === 'cursor-jumps-on-ack') cursor = m.seq
          if (bug === 'fills-at-once') return fill()
          return cursor !== null && m.seq > cursor + 1 ? [{ type: 'wait', purpose: 'reorder_grace', channel: 'A' }] : []
        }
        case 'message':
          held.set((input.message as Message).seq, input.message as Message)
          advance()
          return []
        case 'timer_elapsed': {
          const gap = [...held.keys()].some((s) => cursor !== null && s > cursor + 1)
          return gap || bug === 'stale-timer-fills' ? fill() : []
        }
        default:
          return []
      }
    },
    observe() {
      return { channels: { A: { state: 'ready', cursor, messages: [...held.values()].sort((a, b) => a.seq - b.seq), pending } } }
    },
  }
}

describe('realtime fixtures: client pilot (out-of-order 100, 102, 101 via ack and WebSocket)', () => {
  const pilot = loadClientScenario('out-of-order-ack-and-websocket')

  it('a client that satisfies the fixture passes: effects, observations and label binding are executable', () => {
    expect(runClientScenario(pilot, pilotStandIn())).toEqual([])
  })

  it('fails a client that fills inside the grace period (forbidden effect)', () => {
    expect(runClientScenario(pilot, pilotStandIn('fills-at-once')).join('\n')).toContain('forbidden effect')
  })

  it('fails a client that moves the cursor over the gap (observation)', () => {
    expect(runClientScenario(pilot, pilotStandIn('cursor-jumps-on-ack')).join('\n')).toContain('cursor is 102, expected 100')
  })

  it('fails a client that fills on a stale timer (forbidden effect after the gap closed)', () => {
    expect(runClientScenario(pilot, pilotStandIn('stale-timer-fills')).join('\n')).toContain('forbidden effect')
  })
})

describe('realtime fixtures: runner semantics', () => {
  const scripted = (emit: (input: ResolvedInput) => Effect[]): ClientUnderTest => ({
    feed: emit,
    observe: () => ({ channels: {} }),
  })
  const scenario = (steps: unknown[], never: unknown[] = []) => ({ id: 't', steps, never }) as unknown as ClientScenario

  it('needs required effects, supports any_of, times and ordered, and ignores extra effect fields', () => {
    const steps = [
      { input: { type: 'watch', channel: 'A' }, effects: { required: [{ any_of: [{ type: 'connect' }, { type: 'wait' }] }, { type: 'fetch_history', times: 2 }], ordered: true } },
    ]
    const ok = scripted(() => [{ type: 'wait', extra: 1 }, { type: 'fetch_history' }, { type: 'fetch_history' }])
    expect(runClientScenario(scenario(steps), ok)).toEqual([])
    expect(runClientScenario(scenario(steps), scripted(() => [{ type: 'fetch_history' }])).join()).toContain('missing required effect')
    expect(runClientScenario(scenario(steps), scripted(() => [{ type: 'wait' }, { type: 'fetch_history' }])).join()).toContain('expected 2')
    expect(runClientScenario(scenario(steps), scripted(() => [{ type: 'fetch_history' }, { type: 'fetch_history' }, { type: 'wait' }])).join()).toContain('listed order')
  })

  it('accepts times: 0 when nothing is emitted and fails when something is', () => {
    const steps = [{ input: { type: 'watch', channel: 'A' }, effects: { required: [{ type: 'fetch_history', times: 0 }] } }]
    expect(runClientScenario(scenario(steps), scripted(() => []))).toEqual([])
    expect(runClientScenario(scenario(steps), scripted(() => [{ type: 'fetch_history' }])).join()).toContain('expected 0')
  })

  it('does not truncate a range given as the singular message', () => {
    const steps = [{ input: { type: 'message', channel: 'A', message: { from: 1, to: 3 } } }]
    let fed = false
    expect(runClientScenario(scenario(steps), scripted(() => ((fed = true), []))).join()).toContain('not a range')
    expect(fed).toBe(false)
  })

  it('checks never-effects in every step and respond_to binding', () => {
    const steps = [
      { input: { type: 'watch', channel: 'A' }, effects: { required: [{ type: 'send', as: 'x' }] } },
      { input: { type: 'timer_elapsed', respond_to: 'x' } },
    ]
    const seen: unknown[] = []
    const client = scripted((input) => {
      seen.push(input.respond_to)
      return input.type === 'watch' ? [{ type: 'send', request: 7 }] : [{ type: 'connect' }]
    })
    expect(runClientScenario(scenario(steps, [{ type: 'connect' }]), client).join()).toContain('never-effect')
    expect(seen[1]).toEqual({ type: 'send', request: 7 }) // the client gets its own effect back
  })

  it('skips only_if steps whose condition does not hold', () => {
    const steps = [
      { input: { type: 'socket_closed', code: 4008 }, only_if: 'socket_open', effects: { forbidden: [{ type: 'connect' }] } },
      { input: { type: 'session_start' } },
      { input: { type: 'connection_ready' }, only_if: 'connect_pending' },
      { input: { type: 'socket_closed', code: 4008 }, only_if: 'socket_open', effects: { forbidden: [{ type: 'connect' }] } },
    ]
    const log: string[] = []
    const client = scripted((input) => {
      log.push(input.type)
      return input.type === 'session_start' || input.type === 'socket_closed' ? [{ type: 'connect' }] : []
    })
    // 1st closed: skipped (no socket yet). session_start emits connect, ready delivered, 2nd closed runs and fails.
    expect(runClientScenario(scenario(steps), client).join()).toContain('forbidden effect')
    expect(log).toEqual(['session_start', 'connection_ready', 'socket_closed'])
  })
})
