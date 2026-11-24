import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import type { Channel } from './api'
import { channel, fakeNetwork, ok, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import CreateChannelForm from './CreateChannelForm.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import Workspace from './Workspace.svelte'
import { deferred } from './topic-test-helpers'
import { buttonsByText, installMiniDom, MiniDomEvent, MiniElement, queryAll } from './svelte-dom-test-helpers'

const dom = installMiniDom()

describe('Channel creation visibility', () => {
  it('blocks submit events while capabilities are pending, then permits the retained draft', async () => {
    const props = $state({ disabled: false })
    const oncreate = vi.fn(async () => null)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(CreateChannelForm, { target: host as unknown as Element, props: {
      oncreate, get disabled() { return props.disabled },
    } })
    try {
      await settle()
      const input = host.querySelector('input[name="channel_name"]')!
      input.value = '下書き'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      props.disabled = true
      await settle()
      host.querySelector('form')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      expect(oncreate).not.toHaveBeenCalled()
      expect(input.value).toBe('下書き')
      props.disabled = false
      await settle()
      buttonsByText(host, 'チャンネルを作成')[0]!.click()
      await settle()
      expect(oncreate).toHaveBeenCalledExactlyOnceWith('下書き', 'public')
    } finally { await unmount(instance) }
  })

  for (const visibility of ['public', 'private'] as const) {
    it(`submits ${visibility} from the form and resets to public after success`, async () => {
      const oncreate = vi.fn(async () => null)
      const host = dom.doc.createElement('div')
      dom.doc.body.appendChild(host)
      const instance = mount(CreateChannelForm, { target: host as unknown as Element, props: { oncreate } })
      await settle()
      expect(host.querySelector('legend')?.textContent).toBe('公開範囲')
      const publicRadio = host.querySelector('input[value="public"]')!
      const privateRadio = host.querySelector('input[value="private"]')!
      expect(publicRadio.checked).toBe(true)
      expect(privateRadio.checked).toBe(false)
      expect(publicRadio.closest('label')?.textContent).toContain('公開')
      expect(privateRadio.closest('label')?.textContent).toContain('非公開')
      const name = host.querySelector('input[name="channel_name"]')!
      name.value = '新しいチャンネル'
      name.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      if (visibility === 'private') {
        privateRadio.checked = true
        privateRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
      }
      await settle()
      buttonsByText(host, 'チャンネルを作成')[0]!.click()
      await settle()
      expect(oncreate).toHaveBeenCalledExactlyOnceWith('新しいチャンネル', visibility)
      expect(name.value).toBe('')
      expect(publicRadio.checked).toBe(true)
      expect(privateRadio.checked).toBe(false)
      await unmount(instance)
    })
  }

  for (const result of [null, '同じ名前のチャンネルがすでにあります。']) {
    it(`disables visibility choices while creation is pending and enables them after ${result === null ? 'success' : 'refusal'}`, async () => {
      let resolveCreate!: (result: string | null) => void
      const pending = new Promise<string | null>((resolve) => { resolveCreate = resolve })
      const oncreate = vi.fn(() => pending)
      const host = dom.doc.createElement('div')
      dom.doc.body.appendChild(host)
      const instance = mount(CreateChannelForm, { target: host as unknown as Element, props: { oncreate } })
      await settle()
      const fieldset = host.querySelector('fieldset')!
      const publicRadio = host.querySelector('input[value="public"]')!
      const privateRadio = host.querySelector('input[value="private"]')!
      expect(publicRadio.closest('fieldset')).toBe(fieldset)
      expect(privateRadio.closest('fieldset')).toBe(fieldset)
      // Mini DOM only models own disabled attributes; native radios also inherit from their fieldset.
      const isDisabled = (radio: MiniElement) => radio.disabled || Boolean(radio.closest('fieldset')?.disabled)
      expect(fieldset.disabled).toBe(false)
      expect(isDisabled(publicRadio)).toBe(false)
      expect(isDisabled(privateRadio)).toBe(false)
      const name = host.querySelector('input[name="channel_name"]')!
      name.value = '新しいチャンネル'
      name.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      await settle()
      buttonsByText(host, 'チャンネルを作成')[0]!.click()
      await settle()
      expect(oncreate).toHaveBeenCalledExactlyOnceWith('新しいチャンネル', 'public')
      expect(fieldset.disabled).toBe(true)
      expect(isDisabled(publicRadio)).toBe(true)
      expect(isDisabled(privateRadio)).toBe(true)
      resolveCreate(result)
      await settle()
      expect(fieldset.disabled).toBe(false)
      expect(isDisabled(publicRadio)).toBe(false)
      expect(isDisabled(privateRadio)).toBe(false)
      await unmount(instance)
    })
  }

  it('preserves the private selection and name after a refusal', async () => {
    const oncreate = vi.fn(async () => '同じ名前のチャンネルがすでにあります。')
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(CreateChannelForm, { target: host as unknown as Element, props: { oncreate } })
    await settle()
    const name = host.querySelector('input[name="channel_name"]')!
    name.value = '既存のチャンネル'
    name.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    const privateRadio = host.querySelector('input[value="private"]')!
    privateRadio.checked = true
    privateRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
    await settle()
    buttonsByText(host, 'チャンネルを作成')[0]!.click()
    await settle()
    expect(oncreate).toHaveBeenCalledExactlyOnceWith(name.value, 'private')
    expect(name.value).toBe('既存のチャンネル')
    expect(privateRadio.checked).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('同じ名前のチャンネルがすでにあります。')
    await unmount(instance)
  })

  for (const allowed of [true, false]) {
    it(`shows the creation form and visibility choices only when can_create_channels is ${allowed}`, async () => {
      const net = fakeNetwork()
      const raw = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
      net.lists[0]!.resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }))
      const navigation = createNavigation({
        location: { href: 'http://localhost/' },
        history: { state: null, pushState() {}, replaceState() {} },
        innerWidth: 1280,
        addEventListener() {},
        removeEventListener() {},
      } as unknown as NavigationBrowser)
      const host = dom.doc.createElement('div')
      dom.doc.body.appendChild(host)
      const instance = mount(Workspace, {
        target: host as unknown as Element,
        props: {
          navigation,
          canCreateChannels: allowed,
          session: {
            channels: channelsAdapter(raw.channels),
            sync: syncAdapter(raw.sync),
            topics: (id: string) => topicsAdapter(raw.topics, id),
            close: raw.close,
          },
        },
      })
      await settle()
      expect(host.querySelectorAll('.create-channel-form')).toHaveLength(allowed ? 1 : 0)
      expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(allowed ? 2 : 0)
      await unmount(instance)
      navigation.destroy()
      raw.close()
    })
  }

  it('keeps the creation input attached during capability reconciliation and removes it on a confirmed denial', async () => {
    const props = $state({ allowed: true as boolean | null })
    const net = fakeNetwork()
    const raw = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.lists[0]!.resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }))
    const navigation = createNavigation({
      location: { href: 'http://localhost/' }, history: { state: null, pushState() {}, replaceState() {} },
      innerWidth: 1280, addEventListener() {}, removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, { target: host as unknown as Element, props: {
      navigation, get canCreateChannels() { return props.allowed },
      session: { channels: channelsAdapter(raw.channels), sync: syncAdapter(raw.sync),
        topics: id => topicsAdapter(raw.topics, id), close: raw.close },
    } })
    try {
      await settle()
      const input = host.querySelector('input[name="channel_name"]')!
      for (let i = 0; i < 3; i++) {
        props.allowed = null
        await settle()
        expect(host.querySelector('input[name="channel_name"]')).toBe(input)
        input.value = '入力中'
        input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
        await settle()
        expect(buttonsByText(host, 'チャンネルを作成')[0]!.disabled).toBe(true)
        props.allowed = true
        await settle()
        expect(buttonsByText(host, 'チャンネルを作成')[0]!.disabled).toBe(false)
      }
      props.allowed = false
      await settle()
      expect(host.querySelector('form.create-channel-form')).toBeNull()
      props.allowed = null
      await settle()
      expect(host.querySelector('form.create-channel-form')).toBeNull()
      props.allowed = true
      await settle()
      expect(host.querySelector('input[name="channel_name"]')!.value).toBe('入力中')
    } finally { await unmount(instance); navigation.destroy(); raw.close() }
  })

  it('keeps the submit button enabled during no-evidence revalidation, holds submission without POST until confirmed allowed, and sends the draft once', async () => {
    const props = $state({ allowed: true as boolean | 'revalidating' | null })
    const net = fakeNetwork()
    const raw = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.lists[0]!.resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }))
    const navigation = createNavigation({
      location: { href: 'http://localhost/' }, history: { state: null, pushState() {}, replaceState() {} },
      innerWidth: 1280, addEventListener() {}, removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, { target: host as unknown as Element, props: {
      navigation, get canCreateChannels() { return props.allowed },
      session: { channels: channelsAdapter(raw.channels), sync: syncAdapter(raw.sync),
        topics: id => topicsAdapter(raw.topics, id), close: raw.close },
    } })
    try {
      await settle()
      const input = host.querySelector('input[name="channel_name"]')!
      input.value = '保留チャンネル'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      const privateRadio = host.querySelector('input[value="private"]')!
      privateRadio.checked = true
      privateRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
      await settle()

      // No-evidence revalidation keeps the button enabled.
      props.allowed = 'revalidating'
      await settle()
      const button = buttonsByText(host, 'チャンネルを作成')[0]!
      expect(button.disabled).toBe(false)

      // Submitting during revalidation makes the form busy and sends no POST yet.
      button.click()
      await settle()
      expect(button.disabled).toBe(true)
      expect(net.creates).toHaveLength(0)

      // Repeated submit events while held do not queue a second request.
      host.querySelector('form.create-channel-form')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))
      await settle()
      expect(net.creates).toHaveLength(0)

      // Once confirmed allowed, the held draft is sent exactly once.
      props.allowed = true
      await settle()
      expect(net.creates).toHaveLength(1)
      expect(net.creates[0]!.name).toBe('保留チャンネル')
      net.creates[0]!.resolve(ok({ ...channel('c-new', '保留チャンネル'), visibility: 'private' }))
      await settle()
      expect(input.value).toBe('')
    } finally { await unmount(instance); navigation.destroy(); raw.close() }
  })

  it('holds submission during no-evidence revalidation and removes the form without POST on a confirmed denial', async () => {
    const props = $state({ allowed: true as boolean | 'revalidating' | null })
    const net = fakeNetwork()
    const raw = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    net.lists[0]!.resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }))
    const navigation = createNavigation({
      location: { href: 'http://localhost/' }, history: { state: null, pushState() {}, replaceState() {} },
      innerWidth: 1280, addEventListener() {}, removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, { target: host as unknown as Element, props: {
      navigation, get canCreateChannels() { return props.allowed },
      session: { channels: channelsAdapter(raw.channels), sync: syncAdapter(raw.sync),
        topics: id => topicsAdapter(raw.topics, id), close: raw.close },
    } })
    try {
      await settle()
      const input = host.querySelector('input[name="channel_name"]')!
      input.value = '拒否されるチャンネル'
      input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
      await settle()

      props.allowed = 'revalidating'
      await settle()
      const button = buttonsByText(host, 'チャンネルを作成')[0]!
      expect(button.disabled).toBe(false)
      button.click()
      await settle()
      expect(net.creates).toHaveLength(0)

      // Confirmed denial removes the form and never sends POST /channels.
      props.allowed = false
      await settle()
      expect(host.querySelector('form.create-channel-form')).toBeNull()
      expect(net.creates).toHaveLength(0)

      // Re-allowing later preserves the unsent draft rather than wiping it.
      props.allowed = true
      await settle()
      expect(host.querySelector('input[name="channel_name"]')!.value).toBe('拒否されるチャンネル')
      expect(net.creates).toHaveLength(0)
    } finally { await unmount(instance); navigation.destroy(); raw.close() }
  })

  it('places the creation form before the channel-list skeleton so initial list load does not shift it', async () => {
    const net = fakeNetwork()
    const raw = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me') })
    const navigation = createNavigation({
      location: { href: 'http://localhost/' }, history: { state: null, pushState() {}, replaceState() {} },
      innerWidth: 1280, addEventListener() {}, removeEventListener() {},
    } as unknown as NavigationBrowser)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Workspace, { target: host as unknown as Element, props: {
      navigation, canCreateChannels: true,
      session: { channels: channelsAdapter(raw.channels), sync: syncAdapter(raw.sync),
        topics: id => topicsAdapter(raw.topics, id), close: raw.close },
    } })
    try {
      await settle()
      const scroll = host.querySelector('.channel-column__scroll')!
      const form = scroll.querySelector('form.create-channel-form')!
      const skeleton = scroll.querySelector('[aria-busy="true"]')!
      expect(form).not.toBeNull()
      expect(skeleton).not.toBeNull()
      const childrenBefore = scroll.children
      expect(childrenBefore.indexOf(form)).toBe(0)
      expect(childrenBefore.indexOf(form)).toBeLessThan(childrenBefore.indexOf(skeleton))

      net.lists[0]!.resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('a', 'general')] }))
      await settle()
      expect(scroll.querySelector('[aria-busy="true"]')).toBeNull()
      expect(scroll.children.indexOf(form)).toBe(0)
    } finally { await unmount(instance); navigation.destroy(); raw.close() }
  })
})

