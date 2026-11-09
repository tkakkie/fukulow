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
  describe('close (the session ended)', () => {
    const held = <T>() => {
      let resolve!: (r: T) => void
      const promise = new Promise<T>((r) => (resolve = r))
      return { promise, resolve }
    }
    it('drops a list that finishes after close and notifies nobody', async () => {
      const list = held<ReturnType<typeof ok<{ channels: ReturnType<typeof ch>[] }>>>()
      const c = createChannels({ listChannels: () => list.promise, createChannel: vi.fn() })
      const listener = vi.fn()
      c.subscribe(listener)
      const loading = c.load()
      listener.mockClear()
      c.close()
      list.resolve(ok({ channels: [ch('old')] }))
      await loading
      expect(c.get()).toMatchObject({ status: 'loading', channels: [], selectedId: null })
      expect(listener).not.toHaveBeenCalled()
    })
    it('drops a failed list too', async () => {
      const list = held<{ ok: false; kind: 'network' }>()
      const c = createChannels({ listChannels: () => list.promise, createChannel: vi.fn() })
      const loading = c.load()
      c.close()
      list.resolve({ ok: false, kind: 'network' })
      await loading
      expect(c.get().status).toBe('loading')
    })
    it('a create that finishes after close reports an error and does not add or select the Channel', async () => {
      const created = held<ReturnType<typeof ok<ReturnType<typeof ch>>>>()
      const c = createChannels({ listChannels: async () => ok({ channels: [ch('a')] }), createChannel: () => created.promise })
      await c.load()
      const creating = c.create({ name: 'n', visibility: 'public' })
      c.close()
      created.resolve(ok(ch('n')))
      expect(await creating).toEqual({ error: 'セッションが終了しました。' })
      expect(c.get().channels.map((x) => x.id)).toEqual(['a'])
      expect(c.get().selectedId).toBe('a')
    })
    it('a new list is not affected by the closed one', async () => {
      const old = held<ReturnType<typeof ok<{ channels: ReturnType<typeof ch>[] }>>>()
      const first = createChannels({ listChannels: () => old.promise, createChannel: vi.fn() })
      const loading = first.load()
      first.close()
      const second = createChannels({ listChannels: async () => ok({ channels: [ch('new')] }), createChannel: vi.fn() })
      await second.load()
      old.resolve(ok({ channels: [ch('old')] }))
      await loading
      expect(second.get().channels.map((x) => x.id)).toEqual(['new'])
    })
  })
})
