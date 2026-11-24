import { mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { channel, fakeNetwork, ok, settle } from './adapter-test-helpers.svelte'
import { channelsAdapter } from './channels.svelte'
import CreateChannelForm from './CreateChannelForm.svelte'
import { createNavigation, type NavigationBrowser } from './navigation'
import { createSession } from './session'
import { syncAdapter } from './sync.svelte'
import { topicsAdapter } from './topics.svelte'
import Workspace from './Workspace.svelte'
import { buttonsByText, installMiniDom, MiniDomEvent, MiniElement } from './svelte-dom-test-helpers'

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
      const workspace = await mountCreation(allowed)
      try {
        expect(workspace.host.querySelectorAll('.create-channel-form')).toHaveLength(allowed ? 1 : 0)
        expect(workspace.host.querySelectorAll('input[type="radio"]')).toHaveLength(allowed ? 2 : 0)
      } finally { await workspace.close() }
    })
  }

  it('keeps the creation input attached during capability reconciliation and removes it on a confirmed denial', async () => {
    const { access, host, draft, button, close } = await mountCreation()
    try {
      const input = draft()
      for (let i = 0; i < 3; i++) {
        access.invalidate('access')
        await settle()
        expect(draft()).toBe(input)
        typeName(input, '入力中')
        await settle()
        expect(button().disabled).toBe(true)
        access.confirm(true)
        await settle()
        expect(button().disabled).toBe(false)
      }
      access.confirm(false)
      await settle()
      expect(host.querySelector('form.create-channel-form')).toBeNull()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('チャンネルを作成する権限がありません。')
      access.invalidate('reconcile')
      await settle()
      expect(host.querySelector('form.create-channel-form')).toBeNull()
      access.confirm(true)
      await settle()
      expect(draft().value).toBe('入力中')
    } finally { await close() }
  })

  it('keeps the submit button enabled during no-evidence revalidation, holds submission without POST until confirmed allowed, and sends the draft once', async () => {
    const { access, host, draft, button, net, close } = await mountCreation()
    try {
      typeName(draft(), '保留チャンネル')
      const privateRadio = host.querySelector('input[value="private"]')!
      privateRadio.checked = true
      privateRadio.dispatchEvent(new MiniDomEvent('change', { bubbles: true }))
      access.invalidate('reconcile')
      await settle()
      expect(button().disabled).toBe(false)

      button().click()
      await settle()
      expect(button().disabled).toBe(true)
      expect(net.creates).toHaveLength(0)
      host.querySelector('form.create-channel-form')!.dispatchEvent(new MiniDomEvent('submit', { bubbles: true, cancelable: true }))

      access.confirm(true)
      await settle()
      expect(net.creates).toHaveLength(1)
      expect(net.creates[0].name).toBe('保留チャンネル')
      typeName(draft(), '次の下書き')
      net.creates[0].resolve(ok({ ...channel('c-new', '保留チャンネル'), visibility: 'private' }))
      await settle()
      expect(draft().value).toBe('次の下書き')
      expect(host.querySelector('input[value="public"]')!.checked).toBe(true)
    } finally { await close() }
  })

  it.each(['denial', 'access notice', 'failed check'] as const)('settles a held submit on %s and retains the draft', async reason => {
    const { access, host, draft, button, net, close } = await mountCreation()
    try {
      typeName(draft(), '入力済み')
      access.invalidate('reconcile')
      await settle()
      button().click()
      expect(net.creates).toHaveLength(0)

      if (reason === 'denial') access.confirm(false)
      else if (reason === 'access notice') access.invalidate('access')
      else access.failed()
      await settle()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('権限')
      if (reason === 'denial') expect(host.querySelector('form.create-channel-form')).toBeNull()
      else expect(button().disabled).toBe(true)
      expect(net.creates).toHaveLength(0)

      access.confirm(true)
      await settle()
      expect(draft().value).toBe('入力済み')
      expect(button().disabled).toBe(false)
      expect(host.querySelector('[role="alert"]')).toBeNull()
      expect(net.creates).toHaveLength(0)

      access.invalidate('access')
      await settle()
      expect(host.querySelector('[role="alert"]')).toBeNull()
      expect(button().getAttribute('aria-describedby')).toBeTruthy()
    } finally { await close() }
  })

  it('cancels a held submit when the Workspace unmounts', async () => {
    const { access, draft, button, net, leave, close } = await mountCreation()
    try {
      typeName(draft(), '入力済み')
      access.invalidate('reconcile')
      await settle()
      button().click()
      await leave()
      access.confirm(true)
      await settle()
      expect(net.creates).toHaveLength(0)
    } finally { await close() }
  })

  it('places the creation form before the channel-list skeleton so initial list load does not shift it', async () => {
    const { host, net, close } = await mountCreation(true, false)
    try {
      const scroll = host.querySelector('.channel-column__scroll')!
      const form = scroll.querySelector('form.create-channel-form')!
      expect(scroll.querySelector('[aria-busy="true"]')).not.toBeNull()
      expect(scroll.children[0]).toBe(form)
      net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [channel('a', 'general')] }))
      await settle()
      expect(scroll.querySelector('[aria-busy="true"]')).toBeNull()
      expect(scroll.children[0]).toBe(form)
    } finally { await close() }
  })
})

function typeName(input: MiniElement, name: string) {
  input.value = name
  input.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
}

async function mountCreation(allowed = true, loaded = true) {
  const net = fakeNetwork()
  const raw = createSession({ selfId: 'me', onEnded: () => {}, ...net.options('me'), initialCanCreateChannels: allowed })
  if (loaded) net.lists[0].resolve(ok({ history_generation: '00000000-0000-4000-8000-000000000515', channels: [] }))
  const navigation = createNavigation({
    location: { href: 'http://localhost/' }, history: { state: null, pushState() {}, replaceState() {} },
    innerWidth: 1280, addEventListener() {}, removeEventListener() {},
  } as unknown as NavigationBrowser)
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const instance = mount(Workspace, { target: host as unknown as Element, props: {
    navigation, session: { channels: channelsAdapter(raw.channels, raw.channelCreation), sync: syncAdapter(raw.sync),
      topics: id => topicsAdapter(raw.topics, id), close: raw.close },
  } })
  await settle()
  let left = false
  async function leave() {
    if (left) return
    left = true
    await unmount(instance)
  }
  return {
    access: raw.channelCreation, host, net, leave,
    draft: () => host.querySelector('input[name="channel_name"]')!,
    button: () => buttonsByText(host, 'チャンネルを作成')[0]!,
    async close() { await leave(); navigation.destroy(); raw.close(); host.remove() },
  }
}
