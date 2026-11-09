import { describe, expect, it, vi } from 'vitest'
import { createChannels } from './channels'
import { channelsAdapter } from './channels.svelte'
import { channel, mount, ok, settle, type Deferred } from './adapter-test-helpers.svelte'
import type { Channel, Result } from './api'

/** A Channel list controller whose HTTP calls are answered by the test. */
function setup() {
  const lists: Deferred<Result<{ channels: Channel[] }>>[] = []
  const creates: ({ name: string } & Deferred<Result<Channel>>)[] = []
  const controller = createChannels({
    listChannels: () => new Promise((resolve) => lists.push({ resolve })),
    createChannel: (body) => new Promise((resolve) => creates.push({ name: body.name, resolve })),
  })
  // Count the controller listeners the adapter holds.
  const count = { active: 0 }
  const subscribe = controller.subscribe
  vi.spyOn(controller, 'subscribe').mockImplementation((listener) => {
    count.active++
    const release = subscribe(listener)
    return () => { count.active--; return release() }
  })
  return { controller, adapter: channelsAdapter(controller), lists, creates, count }
}

describe('channels adapter', () => {
  it('shows list loading, selection and creation as they happen', async () => {
    const { adapter, lists, creates } = setup()
    const view = await mount(() => adapter.state)
    expect(view.last).toMatchObject({ status: 'loading', channels: [], selectedId: null })

    void adapter.load()
    lists[0].resolve(ok({ channels: [channel('a'), channel('b')] }))
    await settle()
    expect(view.last).toMatchObject({ status: 'ready', selectedId: 'a' })

    adapter.select('b')
    await settle()
    expect(view.last.selectedId).toBe('b')

    const created = adapter.create('general', 'public')
    creates[0].resolve(ok(channel('n', 'general')))
    expect(await created).toBeNull()
    await settle()
    expect(view.last.channels.map((c) => c.id)).toEqual(['a', 'b', 'n'])
    expect(view.last.selectedId).toBe('n')
    await view.unmount()
  })

  it('shows a load failure, and an explicit retry loads again', async () => {
    const { adapter, lists } = setup()
    const view = await mount(() => adapter.state)
    void adapter.load()
    lists[0].resolve({ ok: false, kind: 'network' })
    await settle()
    expect(view.last.status).toBe('error')
    expect(lists).toHaveLength(1) // no automatic reload
    void adapter.load()
    lists[1].resolve(ok({ channels: [channel('a')] }))
    await settle()
    expect(view.last).toMatchObject({ status: 'ready', selectedId: 'a' })
    await view.unmount()
  })

  it('create returns the error message and leaves the list unchanged', async () => {
    const { adapter, creates } = setup()
    const view = await mount(() => adapter.state)
    const created = adapter.create(' padded', 'public')
    creates[0].resolve({ ok: false, kind: 'http', status: 400 })
    expect(await created).toBe('チャンネル名の前後に空白を入れず、128文字以内にしてください。')
    expect(creates[0].name).toBe(' padded') // sent unchanged
    expect(view.last.channels).toEqual([])
    await view.unmount()
  })

  it('releases its controller listener with the last observer', async () => {
    const { adapter, count } = setup()
    const first = await mount(() => adapter.state)
    const second = await mount(() => adapter.state.selectedId)
    expect(count.active).toBe(1)
    await first.unmount()
    expect(count.active).toBe(1)
    await second.unmount()
    expect(count.active).toBe(0)
  })

  it('remount shows the list as it is now, including changes made while nothing observed', async () => {
    const { adapter, lists, count } = setup()
    const first = await mount(() => adapter.state)
    void adapter.load()
    lists[0].resolve(ok({ channels: [channel('a')] }))
    await settle()
    await first.unmount()
    expect(count.active).toBe(0)

    adapter.select('a')
    void adapter.load()
    lists[1].resolve(ok({ channels: [channel('a'), channel('b')] }))
    await settle()
    const again = await mount(() => adapter.state)
    expect(again.last.channels.map((c) => c.id)).toEqual(['a', 'b'])
    expect(count.active).toBe(1)
    await again.unmount()
  })

  it('a closed list stays as it was: late results of the ended session are not shown', async () => {
    const { controller, adapter, lists, creates } = setup()
    const view = await mount(() => adapter.state)
    void adapter.load()
    lists[0].resolve(ok({ channels: [channel('a')] }))
    await settle()
    void adapter.load()
    const created = adapter.create('late', 'public')
    controller.close()
    lists[1].resolve(ok({ channels: [channel('old')] }))
    creates[0].resolve(ok(channel('late')))
    expect(await created).toBe('セッションが終了しました。')
    await settle()
    expect(adapter.state.channels.map((c) => c.id)).toEqual(['a'])
    expect(view.last.channels.map((c) => c.id)).toEqual(['a'])
    await view.unmount()
  })
})
