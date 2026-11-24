import { describe, expect, it, vi } from 'vitest'
import { channelError, createChannels } from './channels'
import { createActivity } from './activity'
import type { Result } from './api'

const ch = (id: string, name = id) => ({ id, kind: 'channel' as const, archived: false, name, visibility: 'public' as const, capabilities: { can_add_members: { allowed: false }, can_remove_members: { allowed: false }, can_manage_managers: { allowed: false }, can_leave: { allowed: true }, can_rename: { allowed: false }, can_archive: { allowed: false } } })
const ok = <T>(data: T) => ({ ok: true as const, data })

describe('channels', () => {
  it.each([
    [{ ok: false, kind: 'http', status: 400, error: 'invalid channel name' }, 'チャンネル名の前後に空白を入れず、128文字以内にしてください。'],
    [{ ok: false, kind: 'http', status: 403, error: 'forbidden' }, 'このチャンネルを変更する権限がありません。'],
    [{ ok: false, kind: 'http', status: 409, error: 'channel_archived' }, 'このチャンネルはアーカイブされています。名前を変更するには復元してください。'],
    [{ ok: false, kind: 'http', status: 409, error: 'channel name already exists' }, '同じ名前のチャンネルがすでにあります。'],
    [{ ok: false, kind: 'http', status: 400, error: 'dm_channel_fixed' }, 'ダイレクトメッセージの名前やアーカイブ状態は変更できません。'],
    [{ ok: false, kind: 'http', status: 404, error: 'channel not found' }, 'このチャンネルは利用できません。チャンネル一覧に戻ってください。'],
    [{ ok: false, kind: 'network' }, 'サーバーに接続できません。しばらくしてからもう一度お試しください。'],
  ] as const)('returns Japanese copy for Channel update refusal %j without invalidating the lists', async (refusal, error) => {
    const activity = createActivity({ watched: () => false })
    const invalidate = vi.spyOn(activity, 'notice')
    const updateChannel = vi.fn(async (): Promise<Result<undefined>> => refusal)
    const c = createChannels({ listChannels: vi.fn(), createChannel: vi.fn(), updateChannel }, undefined, activity)
    try {
      await expect(c.rename('a', ' unchanged ')).resolves.toBe(error)
      if (refusal.kind === 'http' && refusal.status === 400 && refusal.error === 'invalid channel name') {
        expect(error).toBe(channelError(refusal))
      }
      expect(updateChannel).toHaveBeenCalledExactlyOnceWith('a', { name: ' unchanged ' })
      expect(invalidate).not.toHaveBeenCalled()
    } finally { c.close(); activity.close() }
  })
  it('does not duplicate a created Channel discovered by a notice before its POST response', async () => {
    const activity = createActivity({ watched: () => false })
    let resolve!: (value: ReturnType<typeof ok<ReturnType<typeof ch>>>) => void
    const c = createChannels({ listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('new')] }),
      createChannel: () => new Promise(r => { resolve = r }) }, undefined, activity)
    try {
      const created = c.create({ name: 'new', visibility: 'public' })
      await c.load()
      expect(c.get().channels.map(c => c.id)).toEqual(['new'])
      resolve(ok(ch('new'))); await created
      expect(c.get().channels.map(c => c.id)).toEqual(['new'])
      expect(c.get().selectedId).toBe('new')
    } finally { c.close(); activity.close() }
  })
  it('loads and selects the first channel', async () => {
    const c = createChannels({ listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('a'), ch('b')] }), createChannel: vi.fn() })
    await c.load()
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: 'a' })
  })
  it('keeps the selection on reload and ignores unknown ids', async () => {
    const c = createChannels({ listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('a'), ch('b')] }), createChannel: vi.fn() })
    await c.load()
    c.select('b')
    c.select('zzz')
    await c.load()
    expect(c.get().selectedId).toBe('b')
  })
  it('empty instance: no selection', async () => {
    const c = createChannels({ listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }), createChannel: vi.fn() })
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
    const c = createChannels({ listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('a')] }), createChannel })
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
      const c = createChannels({ listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }), createChannel })
      await c.create({ name, visibility: 'public' })
      expect(createChannel).toHaveBeenCalledTimes(1)
      expect(createChannel.mock.calls[0][0]).toEqual({ name, visibility: 'public' })
    })
  }
  it('a 400 shows the name error, adds no channel and allows a corrected retry', async () => {
    const createChannel = vi.fn(async (b: { name: string }) =>
      b.name === b.name.trim() ? ok(ch('n', b.name)) : ({ ok: false, kind: 'http', status: 400 } as const),
    )
    const c = createChannels({ listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }), createChannel })
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
      listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }),
      createChannel: async () => ({ ok: false, kind: 'http', status: 409 }),
    })
    await c.load()
    expect(await c.create({ name: 'x', visibility: 'public' })).toEqual({ error: '同じ名前のチャンネルがすでにあります。' })
    expect(c.get().channels).toEqual([])
  })
  it('a stale load response does not drop a channel created meanwhile', async () => {
    let release!: (r: ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>>) => void
    const listChannels = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    const c = createChannels({ listChannels, createChannel: async (b) => ok(ch('n', b.name)) })
    const loading = c.load()
    await c.create({ name: 'n', visibility: 'public' })
    release(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('a')] })) // list read before the create committed
    await loading
    expect(c.get().channels.map((x) => x.id)).toContain('n')
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: 'n' })
  })
  it('create during the initial load keeps pre-existing channels, once each', async () => {
    let release!: (r: ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>>) => void
    const listChannels = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    const c = createChannels({ listChannels, createChannel: async (b) => ok(ch('n', b.name)) })
    const loading = c.load()
    await c.create({ name: 'n', visibility: 'public' })
    release(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('a'), ch('b'), ch('n')] }))
    await loading
    expect(c.get().channels.map((x) => x.id)).toEqual(['a', 'b', 'n'])
    expect(c.get().selectedId).toBe('n')
    // a normal later load still replaces the list
    listChannels.mockResolvedValue(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('z')] }))
    await c.load()
    expect(c.get().channels.map((x) => x.id)).toEqual(['z'])
  })
  it('stale load without the new channel merges it in', async () => {
    let release!: (r: ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>>) => void
    const listChannels = vi.fn().mockReturnValue(new Promise((r) => (release = r)))
    const c = createChannels({ listChannels, createChannel: async (b) => ok(ch('n', b.name)) })
    const loading = c.load()
    await c.create({ name: 'n', visibility: 'public' })
    release(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('a'), ch('b')] }))
    await loading
    expect(c.get().channels.map((x) => x.id)).toEqual(['a', 'b', 'n'])
  })
  it('two overlapping loads where the first resolves last keep the second capabilities', async () => {
    const resolvers: ((r: ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>>) => void)[] = []
    const listChannels = vi.fn(() => new Promise<ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>>>((r) => resolvers.push(r)))
    const c = createChannels({ listChannels, createChannel: vi.fn() })
    const first = c.load()
    const second = c.load()
    const stale = ch('a')
    const fresh = { ...ch('a'), capabilities: { ...stale.capabilities, can_manage_managers: { allowed: true } } }
    resolvers[1](ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [fresh] }))
    await second
    expect(c.get().channels[0]?.capabilities.can_manage_managers.allowed).toBe(true)
    resolvers[0](ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [stale] }))
    await first
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: 'a' })
    expect(c.get().channels[0]?.capabilities.can_manage_managers.allowed).toBe(true)
  })
  it('a superseded load that fails does not set error over a newer success', async () => {
    const resolvers: ((r: ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>> | { ok: false; kind: 'network' }) => void)[] = []
    const listChannels = vi.fn(() => new Promise<ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>> | { ok: false; kind: 'network' }>((r) => resolvers.push(r)))
    const c = createChannels({ listChannels, createChannel: vi.fn() })
    const first = c.load()
    const second = c.load()
    resolvers[1](ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('a')] }))
    await second
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: 'a' })
    resolvers[0]({ ok: false, kind: 'network' })
    await first
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: 'a' })
    expect(c.get().channels.map((x) => x.id)).toEqual(['a'])
  })
  it('create-race merge still holds for the latest load when an earlier load is superseded', async () => {
    const resolvers: ((r: ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>>) => void)[] = []
    const listChannels = vi.fn(() => new Promise<ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>>>((r) => resolvers.push(r)))
    const c = createChannels({ listChannels, createChannel: async (b) => ok(ch('n', b.name)) })
    const first = c.load()
    const second = c.load()
    await c.create({ name: 'n', visibility: 'public' })
    resolvers[0](ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('old')] }))
    await first
    resolvers[1](ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('a')] }))
    await second
    expect(c.get().channels.map((x) => x.id)).toEqual(['a', 'n'])
    expect(c.get()).toMatchObject({ status: 'ready', selectedId: 'n' })
  })
  describe('close (the session ended)', () => {
    const held = <T>() => {
      let resolve!: (r: T) => void
      const promise = new Promise<T>((r) => (resolve = r))
      return { promise, resolve }
    }
    it('drops a list that finishes after close and notifies nobody', async () => {
      const list = held<ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>>>()
      const c = createChannels({ listChannels: () => list.promise, createChannel: vi.fn() })
      const listener = vi.fn()
      c.subscribe(listener)
      const loading = c.load()
      listener.mockClear()
      c.close()
      list.resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('old')] }))
      await loading
      expect(c.get()).toMatchObject({status: 'loading', channels: [], selectedId: null })
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
      const c = createChannels({ listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('a')] }), createChannel: () => created.promise })
      await c.load()
      const creating = c.create({ name: 'n', visibility: 'public' })
      c.close()
      created.resolve(ok(ch('n')))
      expect(await creating).toEqual({ error: 'セッションが終了しました。もう一度ログインしてください。' })
      expect(c.get().channels.map((x) => x.id)).toEqual(['a'])
      expect(c.get().selectedId).toBe('a')
    })
    it('a Channel update before or after close reports the full session-ended copy', async () => {
      const pending = held<Result<undefined>>()
      const updateChannel = vi.fn(() => pending.promise)
      const c = createChannels({ listChannels: vi.fn(), createChannel: vi.fn(), updateChannel })
      const renaming = c.rename('a', 'n')
      c.close()
      pending.resolve({ ok: true, data: undefined })
      expect(await renaming).toBe('セッションが終了しました。もう一度ログインしてください。')
      for (const update of [() => c.rename('a', 'n'), () => c.archive('a'), () => c.restore('a')])
        expect(await update()).toBe('セッションが終了しました。もう一度ログインしてください。')
      expect(updateChannel).toHaveBeenCalledOnce()
    })
    it('a new list is not affected by the closed one', async () => {
      const old = held<ReturnType<typeof ok<{ history_generation: string;  channels: ReturnType<typeof ch>[] }>>>()
      const first = createChannels({ listChannels: () => old.promise, createChannel: vi.fn() })
      const loading = first.load()
      first.close()
      const second = createChannels({ listChannels: async () => ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('new')] }), createChannel: vi.fn() })
      await second.load()
      old.resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [ch('old')] }))
      await loading
      expect(second.get().channels.map((x) => x.id)).toEqual(['new'])
    })
  })
})
