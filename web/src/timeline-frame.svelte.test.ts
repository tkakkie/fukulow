import { createRawSnippet, flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { buttonsByText, installMiniDom, MiniDomEvent } from './svelte-dom-test-helpers'
import TimelineFrame from './TimelineFrame.svelte'

const dom = installMiniDom()

function textSnippet(tag: string, text: string) {
  return createRawSnippet(() => ({
    render: () => `<${tag}>${text}</${tag}>`,
  }))
}

function nonSvelteClasses(el: { getAttribute(name: string): string | null } | null): string[] {
  const raw = el?.getAttribute('class') ?? ''
  return raw
    .split(/\s+/)
    .filter((cls) => cls.length > 0 && !cls.startsWith('svelte-'))
}

describe('TimelineFrame (#842)', () => {
  it('renders shared banners with C10 > C9 > load-error precedence and non-live reconnecting notice', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const onretry = vi.fn()
    const ongoToChannelList = vi.fn()
    const onrecheckmembership = vi.fn()

    // 1. Reconnecting + load error
    const inst1 = mount(TimelineFrame, {
      target: host as unknown as Element,
      props: {
        ariaLabel: 'タイムライン',
        classes: { root: 'timeline-section', banner: 'timeline-section__banner', scroll: 'timeline-scroll' },
        reconnecting: true,
        loadErrorMessage: '読み込みに失敗しました。',
        onretry,
        onconfirmreplace: () => {},
        oncancelreplace: () => {},
        composer: textSnippet('div', 'composer'),
      },
    })
    flushSync()
    expect(host.querySelector('section.timeline-section')?.getAttribute('aria-label')).toBe('タイムライン')
    expect(host.textContent).toContain('再接続しています…')
    expect(host.textContent).toContain('読み込みに失敗しました。')
    const reconnectingEl = host.querySelector('.ui-status-banner--info .ui-status-banner__message')
    expect(reconnectingEl?.getAttribute('role')).toBeNull()
    buttonsByText(host, '再試行')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
    expect(onretry).toHaveBeenCalledTimes(1)
    await unmount(inst1)

    // 2. Organization unavailable (C10) wins over Channel unavailable (C9) and load error
    const inst2 = mount(TimelineFrame, {
      target: host as unknown as Element,
      props: {
        organizationUnavailable: true,
        channelUnavailable: true,
        loadErrorMessage: '読み込みに失敗しました。',
        onrecheckmembership,
        ongoToChannelList,
        onconfirmreplace: () => {},
        oncancelreplace: () => {},
        composer: textSnippet('div', 'composer'),
      },
    })
    flushSync()
    expect(host.textContent).toContain('この組織は利用できません。')
    expect(host.textContent).not.toContain('このチャンネルは利用できません。')
    expect(host.textContent).not.toContain('読み込みに失敗しました。')
    await unmount(inst2)

    // 3. Channel unavailable with replyPanel variant keeps reply-panel detail copy
    const inst3 = mount(TimelineFrame, {
      target: host as unknown as Element,
      props: {
        variant: 'panel',
        rootTag: 'div',
        classes: { root: 'reply-panel', header: 'reply-panel__header', scroll: 'reply-panel__scroll' },
        channelUnavailable: true,
        channelUnavailableVariant: 'replyPanel',
        loadErrorMessage: '読み込みに失敗しました。',
        ongoToChannelList,
        onconfirmreplace: () => {},
        oncancelreplace: () => {},
        headerExtra: textSnippet('div', 'header-actions'),
        composer: textSnippet('div', 'composer'),
      },
    })
    flushSync()
    expect(host.querySelector('div.reply-panel')).not.toBeNull()
    expect(host.querySelector('.reply-panel__header')?.textContent).toContain('header-actions')
    expect(host.textContent).toContain('このチャンネルは利用できません。')
    expect(host.textContent).toContain(
      'チャンネルが削除されたか、アクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。',
    )
    expect(host.textContent).not.toContain('読み込みに失敗しました。')
    await unmount(inst3)
  })

  it('renders positioning overlay, load-older controls, newer button, snippets and ReplaceDraftDialog', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const onloadolder = vi.fn()
    const onjumptobottom = vi.fn()
    const onconfirmreplace = vi.fn()
    const oncancelreplace = vi.fn()

    const inst = mount(TimelineFrame, {
      target: host as unknown as Element,
      props: {
        classes: {
          positioning: 'topic-view__positioning',
          scroll: 'topic-view__scroll',
          scrollPositioning: 'topic-view__scroll--positioning',
          older: 'topic-view__older',
          newBelow: 'topic-view__new-below',
          composer: 'topic-view__composer',
        },
        positioning: true,
        positioningLabel: 'トピックを読み込み中',
        showOlder: true,
        olderLabel: '以前のメッセージを読み込む',
        olderError: true,
        onloadolder,
        pinned: false,
        newerCount: 3,
        onjumptobottom,
        confirmReplaceId: 'c-1',
        replaceDraftDescription: '下書きを上書きします。',
        onconfirmreplace,
        oncancelreplace,
        beforeOlder: textSnippet('p', 'before-older'),
        children: textSnippet('p', 'body-rows'),
        composer: textSnippet('p', 'composer-box'),
        extraDialogs: textSnippet('p', 'extra-dialog'),
      },
    })
    flushSync()

    // Positioning overlay and inert/aria-busy scroll container
    const overlay = host.querySelector('.topic-view__positioning [aria-label="トピックを読み込み中"]')
    expect(overlay).not.toBeNull()
    const scrollEl = host.querySelector('.topic-view__scroll')!
    expect(scrollEl.classList.contains('topic-view__scroll--positioning')).toBe(true)
    expect(scrollEl.getAttribute('aria-busy')).toBe('true')
    expect(scrollEl.hasAttribute('inert')).toBe(true)

    // Load-older button and error retry
    const olderBtn = buttonsByText(host, '以前のメッセージを読み込む')[0]
    expect(olderBtn).toBeDefined()
    olderBtn.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
    const retryBtn = buttonsByText(host, '再試行')[0]
    expect(retryBtn).toBeDefined()
    retryBtn.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
    expect(onloadolder).toHaveBeenCalledTimes(2)

    // Newer count control
    const newerBtn = buttonsByText(host, '新着 3件 ↓')[0]
    expect(newerBtn).toBeDefined()
    newerBtn.dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
    expect(onjumptobottom).toHaveBeenCalledTimes(1)

    // Snippets rendered in their regions
    expect(scrollEl.textContent).toContain('before-older')
    expect(scrollEl.textContent).toContain('body-rows')
    expect(host.querySelector('.topic-view__composer')?.textContent).toContain('composer-box')
    expect(host.textContent).toContain('extra-dialog')

    // ReplaceDraftDialog open with custom description and callbacks
    expect(host.textContent).toContain('入力中の下書きを置き換えますか？')
    expect(host.textContent).toContain('下書きを上書きします。')
    buttonsByText(host, '置き換える')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
    expect(onconfirmreplace).toHaveBeenCalledTimes(1)
    buttonsByText(host, 'キャンセル')[0].dispatchEvent(new MiniDomEvent('click', { bubbles: true }))
    expect(oncancelreplace).toHaveBeenCalledTimes(1)

    await unmount(inst)

    // Pinned hides the newer button even when newerCount > 0
    const instPinned = mount(TimelineFrame, {
      target: host as unknown as Element,
      props: {
        pinned: true,
        newerCount: 5,
        onjumptobottom,
        onconfirmreplace: () => {},
        oncancelreplace: () => {},
        composer: textSnippet('p', 'composer-box'),
      },
    })
    flushSync()
    expect(buttonsByText(host, '新着 5件 ↓')).toHaveLength(0)
    await unmount(instPinned)
  })

  it('preserves exact frame class lists and older-button DOM nesting per view', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)

    // 1. Timeline: main view with wrapped older controls and exact timeline-* classes
    const timelineInst = mount(TimelineFrame, {
      target: host as unknown as Element,
      props: {
        ariaLabel: 'タイムライン',
        classes: {
          root: 'timeline-section',
          banner: 'timeline-section__banner',
          positioning: 'timeline-positioning',
          scroll: 'timeline-scroll',
          scrollPositioning: 'timeline-scroll--positioning',
          older: 'timeline-older',
          newBelow: 'timeline-new-below',
          composer: 'timeline-composer',
        },
        reconnecting: true,
        loadErrorMessage: '読み込みエラー',
        positioning: true,
        showOlder: true,
        pinned: false,
        newerCount: 2,
        onconfirmreplace: () => {},
        oncancelreplace: () => {},
        composer: textSnippet('div', 'composer'),
      },
    })
    flushSync()
    const timelineRoot = host.children[0]
    expect(timelineRoot.tagName).toBe('SECTION')
    expect(nonSvelteClasses(timelineRoot)).toEqual(['timeline-section'])
    const timelineBanners = host.querySelectorAll('.timeline-section__banner')
    expect(timelineBanners).toHaveLength(2)
    for (const banner of timelineBanners) {
      expect(nonSvelteClasses(banner)).toEqual(['timeline-section__banner'])
      expect(banner.parentElement).toBe(timelineRoot)
    }
    const timelinePositioning = host.querySelector('.timeline-positioning')
    expect(nonSvelteClasses(timelinePositioning)).toEqual(['timeline-positioning'])
    expect(timelinePositioning?.parentElement).toBe(timelineRoot)
    const timelineScroll = host.querySelector('.timeline-scroll')
    expect(nonSvelteClasses(timelineScroll)).toEqual(['timeline-scroll', 'timeline-scroll--positioning'])
    expect(timelineScroll?.parentElement).toBe(timelineRoot)
    const timelineOlder = host.querySelector('.timeline-older')
    expect(nonSvelteClasses(timelineOlder)).toEqual(['timeline-older'])
    expect(timelineOlder?.parentElement).toBe(timelineScroll)
    expect(buttonsByText(host, '以前のメッセージを読み込む')[0]?.parentElement).toBe(timelineOlder)
    const timelineNewBelow = host.querySelector('.timeline-new-below')
    expect(nonSvelteClasses(timelineNewBelow)).toEqual(['timeline-new-below'])
    expect(timelineNewBelow?.parentElement).toBe(timelineRoot)
    const timelineComposer = host.querySelector('.timeline-composer')
    expect(nonSvelteClasses(timelineComposer)).toEqual(['timeline-composer'])
    expect(timelineComposer?.parentElement).toBe(timelineRoot)
    await unmount(timelineInst)

    // 2. TopicView: main view with wrapped older controls and exact topic-view* classes
    const topicInst = mount(TimelineFrame, {
      target: host as unknown as Element,
      props: {
        ariaLabel: 'トピックタイムライン',
        classes: {
          root: 'topic-view',
          banner: 'topic-view__banner',
          positioning: 'topic-view__positioning',
          scroll: 'topic-view__scroll',
          scrollPositioning: 'topic-view__scroll--positioning',
          older: 'topic-view__older',
          newBelow: 'topic-view__new-below',
          composer: 'topic-view__composer',
        },
        reconnecting: true,
        loadErrorMessage: '読み込みエラー',
        positioning: true,
        showOlder: true,
        pinned: false,
        newerCount: 1,
        onconfirmreplace: () => {},
        oncancelreplace: () => {},
        composer: textSnippet('div', 'composer'),
      },
    })
    flushSync()
    const topicRoot = host.children[0]
    expect(topicRoot.tagName).toBe('SECTION')
    expect(nonSvelteClasses(topicRoot)).toEqual(['topic-view'])
    const topicBanners = host.querySelectorAll('.topic-view__banner')
    expect(topicBanners).toHaveLength(2)
    for (const banner of topicBanners) {
      expect(nonSvelteClasses(banner)).toEqual(['topic-view__banner'])
      expect(banner.parentElement).toBe(topicRoot)
    }
    const topicPositioning = host.querySelector('.topic-view__positioning')
    expect(nonSvelteClasses(topicPositioning)).toEqual(['topic-view__positioning'])
    expect(topicPositioning?.parentElement).toBe(topicRoot)
    const topicScroll = host.querySelector('.topic-view__scroll')
    expect(nonSvelteClasses(topicScroll)).toEqual(['topic-view__scroll', 'topic-view__scroll--positioning'])
    expect(topicScroll?.parentElement).toBe(topicRoot)
    const topicOlder = host.querySelector('.topic-view__older')
    expect(nonSvelteClasses(topicOlder)).toEqual(['topic-view__older'])
    expect(topicOlder?.parentElement).toBe(topicScroll)
    expect(buttonsByText(host, '以前のメッセージを読み込む')[0]?.parentElement).toBe(topicOlder)
    const topicNewBelow = host.querySelector('.topic-view__new-below')
    expect(nonSvelteClasses(topicNewBelow)).toEqual(['topic-view__new-below'])
    expect(topicNewBelow?.parentElement).toBe(topicRoot)
    const topicComposer = host.querySelector('.topic-view__composer')
    expect(nonSvelteClasses(topicComposer)).toEqual(['topic-view__composer'])
    expect(topicComposer?.parentElement).toBe(topicRoot)
    await unmount(topicInst)

    // 3. ReplyPanel: panel view with direct-child older button and exact reply-panel* classes
    const replyInst = mount(TimelineFrame, {
      target: host as unknown as Element,
      props: {
        variant: 'panel',
        rootTag: 'div',
        classes: {
          root: 'reply-panel',
          header: 'reply-panel__header',
          banner: 'reply-panel__banner',
          scroll: 'reply-panel__scroll',
          newBelow: 'reply-panel__new-below',
          composer: 'reply-panel__composer',
        },
        loadErrorMessage: '読み込みエラー',
        showOlder: true,
        olderLabel: '以前の返信を読み込む',
        pinned: false,
        newerCount: 1,
        onconfirmreplace: () => {},
        oncancelreplace: () => {},
        headerExtra: textSnippet('div', 'actions'),
        composer: textSnippet('div', 'composer'),
      },
    })
    flushSync()
    const replyRoot = host.children[0]
    expect(replyRoot.tagName).toBe('DIV')
    expect(nonSvelteClasses(replyRoot)).toEqual(['reply-panel'])
    const replyHeader = host.querySelector('.reply-panel__header')
    expect(nonSvelteClasses(replyHeader)).toEqual(['reply-panel__header'])
    expect(replyHeader?.parentElement).toBe(replyRoot)
    const replyBanner = host.querySelector('.reply-panel__banner')
    expect(nonSvelteClasses(replyBanner)).toEqual(['reply-panel__banner'])
    expect(replyBanner?.parentElement).toBe(replyHeader)
    const replyScroll = host.querySelector('.reply-panel__scroll')
    expect(nonSvelteClasses(replyScroll)).toEqual(['reply-panel__scroll'])
    expect(replyScroll?.parentElement).toBe(replyRoot)
    const replyOlderBtn = buttonsByText(host, '以前の返信を読み込む')[0]
    expect(replyOlderBtn).toBeDefined()
    expect(replyOlderBtn.parentElement).toBe(replyScroll)
    const replyNewBelow = host.querySelector('.reply-panel__new-below')
    expect(nonSvelteClasses(replyNewBelow)).toEqual(['reply-panel__new-below'])
    expect(replyNewBelow?.parentElement).toBe(replyRoot)
    const replyComposer = host.querySelector('.reply-panel__composer')
    expect(nonSvelteClasses(replyComposer)).toEqual(['reply-panel__composer'])
    expect(replyComposer?.parentElement).toBe(replyRoot)
    await unmount(replyInst)
  })
})
