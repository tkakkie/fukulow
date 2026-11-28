import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { installMiniDom, MiniDomEvent } from './svelte-dom-test-helpers'
import ChannelUnavailableBanner from './ui/ChannelUnavailableBanner.svelte'
import OrganizationUnavailableBanner from './ui/OrganizationUnavailableBanner.svelte'

const dom = installMiniDom()

describe('OrganizationUnavailableBanner (#835)', () => {
  it('renders fixed copy, danger alert role, and both actions when callbacks are provided', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const onrecheckmembership = vi.fn()
    const onswitchorganization = vi.fn()

    const instance = mount(OrganizationUnavailableBanner, {
      target: host as unknown as Element,
      props: { onrecheckmembership, onswitchorganization },
    })
    flushSync()

    const banner = host.querySelector('.ui-status-banner')
    expect(banner?.classList.contains('ui-status-banner--danger')).toBe(true)

    const message = host.querySelector('.ui-status-banner__message')
    expect(message?.getAttribute('role')).toBe('alert')
    expect(message?.textContent).toBe('この組織は利用できません。')

    const detail = host.querySelector('.ui-status-banner__detail')
    expect(detail?.textContent).toBe(
      'この組織へのアクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。',
    )

    const buttons = host.querySelectorAll('button')
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      'メンバー資格を再確認',
      '組織を切り替える',
    ])

    buttons[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
    expect(onrecheckmembership).toHaveBeenCalledTimes(1)
    expect(onswitchorganization).not.toHaveBeenCalled()
    buttons[1].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
    expect(onrecheckmembership).toHaveBeenCalledTimes(1)
    expect(onswitchorganization).toHaveBeenCalledTimes(1)

    await unmount(instance)
  })

  it('omits actions whose callbacks are not provided', async () => {
    const hostOne = dom.doc.createElement('div')
    dom.doc.body.appendChild(hostOne)
    const onrecheckmembership = vi.fn()
    const oneAction = mount(OrganizationUnavailableBanner, {
      target: hostOne as unknown as Element,
      props: { onrecheckmembership },
    })
    flushSync()
    expect(hostOne.querySelectorAll('button').map((b) => b.textContent?.trim())).toEqual([
      'メンバー資格を再確認',
    ])
    await unmount(oneAction)

    const hostNone = dom.doc.createElement('div')
    dom.doc.body.appendChild(hostNone)
    const noActions = mount(OrganizationUnavailableBanner, {
      target: hostNone as unknown as Element,
      props: {},
    })
    flushSync()
    expect(hostNone.querySelectorAll('button')).toHaveLength(0)
    await unmount(noActions)
  })
})

describe('ChannelUnavailableBanner (#835)', () => {
  it('renders fixed copy, danger alert role, and channel-list action when callback is provided', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const ongoToChannelList = vi.fn()

    const instance = mount(ChannelUnavailableBanner, {
      target: host as unknown as Element,
      props: { ongoToChannelList },
    })
    flushSync()

    const banner = host.querySelector('.ui-status-banner')
    expect(banner?.classList.contains('ui-status-banner--danger')).toBe(true)

    const message = host.querySelector('.ui-status-banner__message')
    expect(message?.getAttribute('role')).toBe('alert')
    expect(message?.textContent).toBe('このチャンネルは利用できません。')

    const detail = host.querySelector('.ui-status-banner__detail')
    expect(detail?.textContent).toBe('アクセス権がないか、削除された可能性があります。')

    const buttons = host.querySelectorAll('button')
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['チャンネル一覧へ'])

    buttons[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
    expect(ongoToChannelList).toHaveBeenCalledTimes(1)

    await unmount(instance)
  })

  it('omits the action button when ongoToChannelList is not provided', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)

    const instance = mount(ChannelUnavailableBanner, {
      target: host as unknown as Element,
      props: {},
    })
    flushSync()

    expect(host.querySelector('.ui-status-banner__message')?.getAttribute('role')).toBe('alert')
    expect(host.querySelectorAll('button')).toHaveLength(0)

    await unmount(instance)
  })

  it('keeps the reply panel detail copy unchanged', async () => {
    // The Reply Panel must keep passing the variant; the copy below is only reached through it.
    const replyPanelSrc = readFileSync(join(import.meta.dirname, 'ReplyPanel.svelte'), 'utf8')
    expect(replyPanelSrc).toMatch(/<TimelineFrame[\s\S]*?channelUnavailableVariant="replyPanel"/)
    const timelineFrameSrc = readFileSync(join(import.meta.dirname, 'TimelineFrame.svelte'), 'utf8')
    expect(timelineFrameSrc).toMatch(/<ChannelUnavailableBanner [^>]*variant=\{channelUnavailableVariant\}/)
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)

    const instance = mount(ChannelUnavailableBanner, {
      target: host as unknown as Element,
      props: { variant: 'replyPanel' },
    })
    flushSync()

    expect(host.querySelector('.ui-status-banner__message')?.textContent).toBe('このチャンネルは利用できません。')
    expect(host.querySelector('.ui-status-banner__detail')?.textContent).toBe(
      'チャンネルが削除されたか、アクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。',
    )

    await unmount(instance)
  })
})
