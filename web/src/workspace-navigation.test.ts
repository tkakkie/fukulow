import { readFileSync } from 'node:fs'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter, type ChannelsAdapter } from './channels.svelte'
import { createNavigation, type Navigation, type NavigationBrowser } from './navigation'
import { createSession } from './session'

// Exercise the component's actual handler with real controllers without requiring a browser DOM.
const workspace = readFileSync(new URL('./Workspace.svelte', import.meta.url), 'utf8')
const script = workspace.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? ''
const source = createSourceFile('Workspace.ts', script, ScriptTarget.Latest, true)
const handler = source.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'handleSelectChannel')
if (!handler) throw new Error('Workspace Channel selection handler not found')
const handlerCode = transpileModule(handler.getText(source), { compilerOptions: { target: ScriptTarget.ESNext } }).outputText

function selectionHandler(nav: Navigation, channels: ChannelsAdapter) {
  return new Function('nav', 'channels', 'currentOrganizationId', `
    return id => {
      const s = channels.state;
      let drawerOpen = true;
      ${handlerCode}
      handleSelectChannel(id);
    };
  `)(nav, channels, 'org') as (id: string) => void
}

function navigation(topicId: string | null) {
  let href = `/o/org/c/A${topicId ? `/t/${topicId}` : ''}`
  const pushState = vi.fn((_state: unknown, _title: string, url: string) => { href = url })
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => { href = url })
  const nav = createNavigation({
    location: { get href() { return href } },
    history: { state: null, pushState, replaceState },
    innerWidth: 1280,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as NavigationBrowser)
  return { nav, pushState, replaceState }
}

it.each([null, 'topic'])('explicitly selecting the current C9 Channel from view %s leaves the Topic and retries once without a loop', async topicId => {
  vi.useFakeTimers()
  const net = fakeNetwork()
  const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
  const watch = vi.spyOn(session.sync, 'watch')
  const { nav, pushState, replaceState } = navigation(topicId)
  try {
    net.socket.onReady()
    net.pages.A = { ok: false, kind: 'http', status: 404, error: 'channel_not_found' }
    net.lists[0].resolve(ok({ channels: [channel('A')] }))
    await settle()
    expect(session.channels.get().selectedId).toBe('A')
    expect(nav.get().target?.topicId).toBe(topicId)
    expect(session.sync.get().channels.A.state).toBe('unavailable')
    expect(watch).toHaveBeenCalledTimes(1)
    expect(net.history).toHaveLength(1)

    selectionHandler(nav, channelsAdapter(session.channels))('A')
    await settle()
    expect(pushState).toHaveBeenCalledTimes(topicId ? 1 : 0)
    expect(replaceState).not.toHaveBeenCalled()
    expect(nav.get().target).toMatchObject({ channelId: 'A', topicId: null })
    expect(watch).toHaveBeenCalledTimes(2)
    expect(net.history).toHaveLength(2)
    expect(session.sync.get().channels.A.state).toBe('unavailable')

    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(watch).toHaveBeenCalledTimes(2)
    expect(net.history).toHaveLength(2)
    expect(pushState).toHaveBeenCalledTimes(topicId ? 1 : 0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    nav.destroy()
    session.close()
    vi.useRealTimers()
  }
})

it.each([null, 'topic'])('explicitly selecting the current ready Channel from view %s leaves the Topic without retrying', async topicId => {
  const net = fakeNetwork()
  const session = createSession({ selfId: 'me', onEnded: vi.fn(), ...net.options() })
  const watch = vi.spyOn(session.sync, 'watch')
  const { nav, pushState, replaceState } = navigation(topicId)
  try {
    net.socket.onReady()
    net.lists[0].resolve(ok({ channels: [channel('A')] }))
    await settle()
    net.subscribed('A', 0)
    await settle()
    expect(session.sync.get().channels.A.state).toBe('ready')

    selectionHandler(nav, channelsAdapter(session.channels))('A')
    await settle()
    expect(nav.get().target).toMatchObject({ channelId: 'A', topicId: null })
    expect(pushState).toHaveBeenCalledTimes(topicId ? 1 : 0)
    expect(replaceState).not.toHaveBeenCalled()
    expect(watch).toHaveBeenCalledTimes(1)
    expect(net.history).toHaveLength(1)
    expect(net.subscribeCount('A')).toBe(1)
  } finally {
    nav.destroy()
    session.close()
  }
})
