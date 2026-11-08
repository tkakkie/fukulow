import { describe, expect, it, vi } from 'vitest'
import { createChannels } from './channels'

const ch = (id: string, name = id) => ({ id, name, visibility: 'public' as const })
const ok = <T>(data: T) => ({ ok: true as const, data })

describe('channels', () => {
  it('loads and selects the first channel', async () => {
    const c = createChannels({ listChannels: async () => ok({ channels: [ch('a'), ch('b')] }), createChannel: vi.fn() })
    await c.load()
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: 'a' })
  })
  it('keeps the selection on reload and ignores unknown ids', async () => {
    const c = createChannels({ listChannels: async () => ok({ channels: [ch('a'), ch('b')] }), createChannel: vi.fn() })
    await c.load()
    c.select('b')
    c.select('zzz')
    await c.load()
    expect(c.get().selectedId).toBe('b')
  })
  it('empty instance: no selection', async () => {
    const c = createChannels({ listChannels: async () => ok({ channels: [] }), createChannel: vi.fn() })
    await c.load()
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: null })
  })
  it('load failure -> error', async () => {
    const c = createChannels({ listChannels: async () => ({ ok: false, kind: 'network' }), createChannel: vi.fn() })
    await c.load()
    expect(c.get().status).toBe('error')
  })
  it('create trims the name, adds and selects the channel', async () => {
    const createChannel = vi.fn(async (b) => ok(ch('n', b.name)))
    const c = createChannels({ listChannels: async () => ok({ channels: [ch('a')] }), createChannel })
    await c.load()
    const r = await c.create({ name: '  general ', visibility: 'public' })
    expect(createChannel).toHaveBeenCalledWith({ name: 'general', visibility: 'public' })
    expect('channel' in r).toBe(true)
    expect(c.get()).toMatchObject({ selectedId: 'n' })
    expect(c.get().channels).toHaveLength(2)
  })
  it('create failure returns a Japanese error and changes nothing', async () => {
    const c = createChannels({
      listChannels: async () => ok({ channels: [] }),
      createChannel: async () => ({ ok: false, kind: 'http', status: 409 }),
    })
    await c.load()
    expect(await c.create({ name: 'x', visibility: 'public' })).toEqual({ error: '同じ名前のチャンネルがすでにあります。' })
    expect(c.get().channels).toEqual([])
  })
  it('a stale load response does not drop a channel created meanwhile', async () => {
    let release!: (r: ReturnType<typeof ok<{ channels: ReturnType<typeof ch>[] }>>) => void
    const listChannels = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    const c = createChannels({ listChannels, createChannel: async (b) => ok(ch('n', b.name)) })
    const loading = c.load()
    await c.create({ name: 'n', visibility: 'public' })
    release(ok({ channels: [ch('a')] })) // list read before the create committed
    await loading
    expect(c.get().channels.map((x) => x.id)).toEqual(['n'])
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: 'n' })
  })
})
