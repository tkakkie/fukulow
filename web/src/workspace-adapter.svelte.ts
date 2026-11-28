import { createSubscriber } from 'svelte/reactivity'
import type { Message } from './api'
import { channelMembersAdapter } from './channel-members.svelte'
import { searchAdapter } from './search.svelte'
import { createWorkspaceAnnouncements } from './workspace-announcements'
import { openWorkspaceChannelMembers, openWorkspaceSearch } from './workspace-lifetimes'
import { createWorkspaceReplies } from './workspace-replies'

export function workspaceLifetimesAdapter() {
  let search = $state.raw<ReturnType<typeof openWorkspaceSearch> | undefined>(undefined)
  let members = $state.raw<ReturnType<typeof openWorkspaceChannelMembers>>(undefined)
  return {
    mountSearch(...args: Parameters<typeof openWorkspaceSearch>) {
      const entry = openWorkspaceSearch(...args)
      search = entry
      return () => {
        entry.dispose()
        if (search === entry) search = undefined
      }
    },
    search(scope: Parameters<typeof openWorkspaceSearch>[0]) {
      const controller = search?.read(scope)
      return controller && searchAdapter(controller)
    },
    mountChannelMembers(...args: Parameters<typeof openWorkspaceChannelMembers>) {
      const entry = openWorkspaceChannelMembers(...args)
      members = entry
      if (!entry) return
      return () => {
        entry.dispose()
        if (members === entry) members = undefined
      }
    },
    channelMembers(scope: Parameters<typeof openWorkspaceChannelMembers>[0]) {
      const controller = members?.read(scope)
      return controller && channelMembersAdapter(controller)
    },
  }
}

export function workspaceRepliesAdapter() {
  let anchor = $state<Message | null>(null)
  return createWorkspaceReplies({ get: () => anchor, set: message => { anchor = message } })
}

export function workspaceAnnouncementsAdapter(options: Parameters<typeof createWorkspaceAnnouncements>[0]) {
  let viewId = $state('')
  const controller = createWorkspaceAnnouncements(options, { get: () => viewId, set: id => { viewId = id } })
  const subscribe = createSubscriber(controller.subscribe)
  return {
    ...controller,
    get state() { subscribe(); return controller.get() },
  }
}
