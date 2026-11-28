import { expect, it, vi } from 'vitest'
import { createChannelMembers } from './channel-members'
import { createMockSearchSource } from './search-test-helpers'
import { workspaceLifetimesAdapter } from './workspace-adapter.svelte'

it('keeps the current Search adapter when a retired mount cleans up', () => {
  const adapter = workspaceLifetimesAdapter()
  const scope = { organizationId: 'org', source: createMockSearchSource() }
  const callbacks = { onOpenResult: vi.fn(), onAnnounce: vi.fn(), onChannelRevoked: vi.fn() }
  const retire = adapter.mountSearch(scope, callbacks)
  const current = adapter.mountSearch(scope, callbacks)
  adapter.search(scope)?.setInput('current')
  retire()
  expect(adapter.search(scope)?.state.input).toBe('current')
  current()
  expect(adapter.search(scope)).toBeUndefined()
})

it('keeps the current Channel member adapter when a retired mount cleans up', () => {
  const adapter = workspaceLifetimesAdapter()
  const scope = { session: {}, organizationId: 'org', channelId: 'A' }
  const open = (id: string) => createChannelMembers('org', id, vi.fn())
  const retire = adapter.mountChannelMembers(scope, open, vi.fn())!
  const current = adapter.mountChannelMembers(scope, open, vi.fn())!
  retire()
  expect(adapter.channelMembers(scope)).toBeDefined()
  current()
  expect(adapter.channelMembers(scope)).toBeUndefined()
  expect(adapter.mountChannelMembers({ ...scope, channelId: null }, open, vi.fn())).toBeUndefined()
})
