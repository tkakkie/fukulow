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
  it('create adds and selects the channel', async () => {
    const createChannel = vi.fn(async (b) => ok(ch('n', b.name)))
    const c = createChannels({ listChannels: async () => ok({ channels: [ch('a')] }), createChannel })
    await c.load()
    const r = await c.create({ name: 'general', visibility: 'public' })
    expect(createChannel).toHaveBeenCalledWith({ name: 'general', visibility: 'public' })
    expect('channel' in r).toBe(true)
    expect(c.get()).toMatchObject({ selectedId: 'n' })
    expect(c.get().channels).toHaveLength(2)
  })
  const names = [
    ' general', 'general ', '  general ', '\tgeneral\n', '　general', 'general　', ' general ',
    ' general ', '﻿general', 'general\u0085', ' ', 'gen eral', 'gen　eral',
  ]
  for (const name of names) {
    it(`create sends ${JSON.stringify(name)} unchanged (the server validates)`, async () => {
      const createChannel = vi.fn(async (b) => ok(ch('n', b.name)))
      const c = createChannels({ listChannels: async () => ok({ channels: [] }), createChannel })
      await c.create({ name, visibility: 'public' })
      expect(createChannel).toHaveBeenCalledTimes(1)
      expect(createChannel.mock.calls[0][0]).toEqual({ name, visibility: 'public' })
    })
  }
  it('a 400 shows the name error, adds no channel and allows a corrected retry', async () => {
    const createChannel = vi.fn(async (b: { name: string }) =>
      b.name === b.name.trim() ? ok(ch('n', b.name)) : ({ ok: false, kind: 'http', status: 400 } as const),
    )
    const c = createChannels({ listChannels: async () => ok({ channels: [] }), createChannel })
    await c.load()
    const bad = await c.create({ name: ' general', visibility: 'public' })
    expect(bad).toEqual({ error: 'チャンネル名の前後に空白を入れず、128文字以内にしてください。' })
    expect(c.get().channels).toEqual([])
    expect(c.get().selectedId).toBeNull()
    const good = await c.create({ name: 'general', visibility: 'public' })
    expect('channel' in good).toBe(true)
    expect(c.get().channels).toHaveLength(1)
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
    expect(c.get().channels.map((x) => x.id)).toContain('n')
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: 'n' })
  })
  it('create during the initial load keeps pre-existing channels, once each', async () => {
    let release!: (r: ReturnType<typeof ok<{ channels: ReturnType<typeof ch>[] }>>) => void
    const listChannels = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    const c = createChannels({ listChannels, createChannel: async (b) => ok(ch('n', b.name)) })
    const loading = c.load()
    await c.create({ name: 'n', visibility: 'public' })
    release(ok({ channels: [ch('a'), ch('b'), ch('n')] }))
    await loading
    expect(c.get().channels.map((x) => x.id)).toEqual(['a', 'b', 'n'])
    expect(c.get().selectedId).toBe('n')
    // a normal later load still replaces the list
    listChannels.mockResolvedValue(ok({ channels: [ch('z')] }))
    await c.load()
    expect(c.get().channels.map((x) => x.id)).toEqual(['z'])
  })
  it('stale load without the new channel merges it in', async () => {
    let release!: (r: ReturnType<typeof ok<{ channels: ReturnType<typeof ch>[] }>>) => void
    const listChannels = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    const c = createChannels({ listChannels, createChannel: async (b) => ok(ch('n', b.name)) })
    const loading = c.load()
    await c.create({ name: 'n', visibility: 'public' })
    release(ok({ channels: [ch('a'), ch('b')] }))
    await loading
    expect(c.get().channels.map((x) => x.id)).toEqual(['a', 'b', 'n'])
  })
})
