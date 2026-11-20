import { flushSync, mount, tick, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import * as api from './api'
import type { Member, Result } from './api'
import { createChannelMembers } from './channel-members'
import { channelMembersAdapter } from './channel-members.svelte'
import ChannelMembers from './ChannelMembers.svelte'
import { createMembers } from './members'
import { membersAdapter } from './members.svelte'
import MemberList from './MemberList.svelte'
import { createSession } from './session'
import { channel, fakeNetwork, ok, settle } from './adapter-test-helpers.svelte'
import { deferred } from './topic-test-helpers'
import { buttonsByText, installMiniDom, MiniElement, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

describe('Member confirmation Dialogs', () => {
  const self: Member = { id: 'me', name: '本人', role: 'admin' }
  const peer: Member = { id: 'peer', name: '佐藤', role: 'member' }
  const admin: api.Identity = { member: self, organization: {
    organization_id: 'org-1', name: '組織', capabilities: {
      can_create_channels: { allowed: false }, can_invite: { allowed: false },
      can_deactivate_members: { allowed: true }, can_manage_roles: { allowed: false },
    },
  } }

  it('keeps the Owner Channel Member row and Dialog mounted through members_changed', () => checkOwnerDialogRefresh('members_changed'))
  it('keeps the Owner Channel Member row and Dialog mounted through activity_ready', () => checkOwnerDialogRefresh('activity_ready'))

  async function checkOwnerDialogRefresh(notice: 'members_changed' | 'activity_ready') {
    vi.useFakeTimers()
    const owner: Member = { ...self, role: 'owner' }
    const selected = channel('A')
    selected.capabilities.can_remove_members = { allowed: true }
    const rows = [owner, peer].map(member => ({ ...member, manager: false }))
    let resolveIdentity!: (result: Result<api.Identity>) => void
    const identity = vi.spyOn(api, 'getOrganizationMe')
      .mockImplementation(() => new Promise(resolve => { resolveIdentity = resolve }))
    let resolveList!: (result: Result<api.ChannelMemberList>) => void
    const list = vi.spyOn(api, 'listChannelMembers')
      .mockResolvedValueOnce(ok({ members: rows }))
      .mockImplementation(() => new Promise(resolve => { resolveList = resolve }))
    const net = fakeNetwork()
    const options = net.options()
    const session = createSession({ ...options, sync: { ...options.sync, random: () => 0.5 },
      selfId: owner.id, initialRole: owner.role, onEnded: vi.fn(),
    })
    net.socket.onReady()
    const controller = session.channelMembers(selected.id)
    await settle()
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(ChannelMembers, { target: host as unknown as Element, props: {
      model: channelMembersAdapter(controller), channel: selected, self: owner.id, candidates: [],
    } })
    try {
      const selector = 'button[aria-label="佐藤をチャンネルから外す"]'
      const opener = host.querySelector(selector)!
      const row = opener.closest('li')!
      opener.click()
      await settle()
      const dialog = host.querySelector('[role="dialog"]')!
      expect(dialog.textContent).toContain(peer.name)
      const focused = dom.doc.activeElement
      expect(focused?.textContent.trim()).toBe('キャンセル')
      const expectMounted = (stage: string) => {
        expect(host.querySelector(selector) === opener, stage).toBe(true)
        expect(row.isConnected && opener.closest('li') === row, stage).toBe(true)
        expect(host.querySelector('[role="dialog"]') === dialog, stage).toBe(true)
        expect(dom.doc.activeElement === focused, stage).toBe(true)
      }

      net.socket.onEvent({ type: notice })
      await vi.advanceTimersByTimeAsync(200)
      expect(identity).toHaveBeenCalledTimes(1)
      expectMounted('while /me is pending')
      resolveIdentity(ok({ ...admin, member: owner }))
      await vi.advanceTimersByTimeAsync(200)
      expect(list).toHaveBeenCalledTimes(2)
      expectMounted('while the Channel Member list is refetching')
      const refreshed = rows.map(member => ({ ...member, manager: member.id === peer.id }))
      resolveList(ok({ members: refreshed }))
      await settle()
      expect(controller.get().members).toEqual(refreshed)
      expectMounted('after the refreshed list arrives')
    } finally {
      await unmount(instance)
      session.close(); list.mockRestore(); identity.mockRestore()
    }
  }

  it('dismisses the Member deactivation Dialog on demotion', () => checkDeactivationDialog('demotion'))
  it('dismisses the Member deactivation Dialog on target removal', () => checkDeactivationDialog('target removal'))

  async function checkDeactivationDialog(change: 'demotion' | 'target removal') {
    let identity = $state.raw(admin)
    const listMembers = vi.fn(async () => ok({ members: [self, peer] }))
    const deactivateMember = vi.fn()
    const controller = createMembers('org-1', vi.fn(), vi.fn(), {
      listMembers, deactivateMember, changeRole: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    })
    await controller.load()
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(MemberList, { target: host as unknown as Element, props: {
      model: membersAdapter(controller), get identity() { return identity }, onchanged: vi.fn(),
    } })
    try {
      const details = host.querySelector('details') as MiniElement & { open: boolean }
      details.open = true
      queryAll(host, 'button').find(button => button.textContent.trim() === '佐藤を無効化')!.click()
      await settle()
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain(peer.name)
      if (change === 'demotion') {
        identity = { member: { ...self, role: 'guest' }, organization: { ...admin.organization, capabilities: {
          ...admin.organization.capabilities, can_deactivate_members: { allowed: false },
        } } }
      } else {
        listMembers.mockResolvedValueOnce(ok({ members: [self] }))
        await controller.load()
      }
      await settle()
      expect(host.querySelector('[role="dialog"]')?.textContent).toBeUndefined()
      expect(dom.doc.activeElement?.localName).toBe('summary')
      expect(deactivateMember).not.toHaveBeenCalled()
      identity = admin
      await controller.load()
      await settle()
      expect(host.querySelector('[role="dialog"]')?.textContent).toBeUndefined()
    } finally { await unmount(instance); controller.close() }
  }

  it('dismisses the Channel removal Dialog on target removal', () => checkChannelDialog('removal', 'target removal'))
  it('dismisses the Channel removal Dialog on permission loss', () => checkChannelDialog('removal', 'permission loss'))
  it('dismisses the Channel manager grant Dialog on target removal', () => checkChannelDialog('manager grant', 'target removal'))
  it('dismisses the Channel manager grant Dialog on permission loss', () => checkChannelDialog('manager grant', 'permission loss'))

  async function checkChannelDialog(action: 'removal' | 'manager grant', change: 'target removal' | 'permission loss') {
    const adminChannel = channel('A')
    adminChannel.capabilities.can_manage_managers = { allowed: true }
    adminChannel.capabilities.can_remove_members = { allowed: true }
    let currentChannel = $state.raw(adminChannel)
    const rows = [self, peer].map(m => ({ ...m, manager: false }))
    const listChannelMembers = vi.fn(async () => ok({ members: rows }))
    const removeChannelMember = vi.fn(), changeChannelManager = vi.fn()
    const controller = createChannelMembers('org-1', 'A', vi.fn(), {
      ...api, listChannelMembers, removeChannelMember, changeChannelManager,
    })
    await controller.load()
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(ChannelMembers, { target: host as unknown as Element, props: {
      model: channelMembersAdapter(controller), get channel() { return currentChannel }, self: self.id, candidates: [],
    } })
    try {
      const opener = action === 'removal' ? '佐藤をチャンネルから外す' : '佐藤のチャンネル管理者を付与する'
      host.querySelector(`button[aria-label="${opener}"]`)!.click()
      await settle()
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain(peer.name)
      if (change === 'permission loss') {
        currentChannel = channel('A')
      } else {
        listChannelMembers.mockResolvedValueOnce(ok({ members: [rows[0]] }))
        await controller.load()
      }
      await settle()
      expect(host.querySelector('[role="dialog"]')?.textContent).toBeUndefined()
      expect(dom.doc.activeElement?.localName).toBe('section')
      expect(removeChannelMember).not.toHaveBeenCalled()
      expect(changeChannelManager).not.toHaveBeenCalled()
      currentChannel = adminChannel
      await controller.load()
      await settle()
      expect(host.querySelector('[role="dialog"]')?.textContent).toBeUndefined()
    } finally { await unmount(instance); controller.close() }
  }

  it('clears the directory on a failed refetch and renders a working Retry action', async () => {
    vi.useFakeTimers()
    const listMembers = vi.fn<typeof api.listMembers>()
      .mockResolvedValueOnce(ok({ members: [self, peer] }))
      .mockResolvedValueOnce({ ok: false, kind: 'http', status: 503, retryAfterMs: 1_000 })
      .mockResolvedValueOnce(ok({ members: [self] }))
    const controller = createMembers('org-1', vi.fn(), vi.fn(), {
      listMembers, deactivateMember: vi.fn(), changeRole: vi.fn(), createInvite: vi.fn(), baseUrl: () => '',
    }, () => self.role)
    controller.activityTarget.held()
    await controller.load()
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(MemberList, { target: host as unknown as Element, props: {
      model: membersAdapter(controller), identity: admin, onchanged: vi.fn(),
    } })
    try {
      expect(host.textContent).toContain(peer.name)
      await controller.load()
      await settle()
      expect(host.textContent).not.toContain(peer.name)
      expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy()
      const retry = queryAll(host, 'button').find(button => button.textContent.trim() === '再試行')
      expect(Boolean(retry)).toBe(true)
      retry!.click()
      await settle()
      expect(listMembers).toHaveBeenCalledTimes(3)
      expect(host.textContent).toContain(self.name)
      expect(host.textContent).not.toContain(peer.name)
      expect(host.querySelector('[role="alert"]')?.textContent).toBeUndefined()
    } finally { await unmount(instance); controller.close() }
  })
})

