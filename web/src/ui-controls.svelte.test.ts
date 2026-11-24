import { flushSync, mount, unmount } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import Composer from './Composer.svelte'
import { installMiniDom, MiniDomEvent } from './svelte-dom-test-helpers'
import Input from './ui/Input.svelte'
import MessageRow from './ui/MessageRow.svelte'

const dom = installMiniDom()

describe('Input.svelte (#833)', () => {
  it.each([
    { withLabel: true, multiline: false },
    { withLabel: true, multiline: true },
    { withLabel: false, multiline: false },
    { withLabel: false, multiline: true },
  ])('forwards all attributes and accessible name (withLabel=$withLabel, multiline=$multiline)', async ({ withLabel, multiline }) => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)

    const oninput = vi.fn()
    const onkeydown = vi.fn()
    const onselect = vi.fn()
    const onblur = vi.fn()

    const instance = mount(Input, {
      target: host as unknown as Element,
      props: {
        label: withLabel ? '表示名' : undefined,
        ariaLabel: '代替ラベル',
        hint: withLabel ? 'ヒント文' : undefined,
        multiline,
        name: 'field_name',
        type: 'email',
        rows: 4,
        value: '初期値',
        placeholder: '入力してください',
        required: true,
        disabled: true,
        minlength: 2,
        maxlength: 80,
        autocomplete: 'email',
        ariaControls: 'list-1',
        ariaActiveDescendant: 'opt-2',
        oninput,
        onkeydown,
        onselect,
        onblur,
      },
    })
    flushSync()

    const selector = multiline ? 'textarea' : 'input'
    const control = host.querySelector(selector)!
    expect(control).not.toBeNull()
    expect(host.querySelector(multiline ? 'input' : 'textarea')).toBeNull()

    // Accessible name & label wrapper
    const labelEl = host.querySelector('label.ui-field')
    if (withLabel) {
      expect(labelEl).not.toBeNull()
      expect(labelEl?.querySelector('.ui-field__label')?.textContent).toBe('表示名')
      expect(labelEl?.querySelector('.ui-field__hint')?.textContent).toBe('ヒント文')
      expect(labelEl?.querySelector(selector)).toBe(control)
      expect(control.getAttribute('aria-label')).toBeNull()
    } else {
      expect(labelEl).toBeNull()
      expect(control.getAttribute('aria-label')).toBe('代替ラベル')
    }

    // Classes and element-specific attributes
    expect(control.classList.contains('ui-input')).toBe(true)
    if (multiline) {
      expect(control.classList.contains('ui-input--textarea')).toBe(true)
      expect(control.getAttribute('rows')).toBe('4')
      expect(control.getAttribute('type')).toBeNull()
      expect(control.getAttribute('autocomplete')).toBeNull()
    } else {
      expect(control.classList.contains('ui-input--textarea')).toBe(false)
      expect(control.getAttribute('type')).toBe('email')
      expect(control.getAttribute('autocomplete')).toBe('email')
      expect(control.getAttribute('rows')).toBeNull()
    }

    // Shared forwarded attributes
    expect(control.getAttribute('name')).toBe('field_name')
    expect(control.getAttribute('placeholder')).toBe('入力してください')
    expect(control.getAttribute('required')).not.toBeNull()
    expect(control.disabled).toBe(true)
    expect(control.getAttribute('minlength')).toBe('2')
    expect(control.getAttribute('maxlength')).toBe('80')
    expect(control.value).toBe('初期値')
    expect(control.getAttribute('aria-autocomplete')).toBe('list')
    expect(control.getAttribute('aria-controls')).toBe('list-1')
    expect(control.getAttribute('aria-activedescendant')).toBe('opt-2')

    // Forwarded event handlers
    control.value = '変更後'
    control.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    expect(oninput).toHaveBeenCalledTimes(1)
    expect(oninput.mock.calls[0][0]).toBe('変更後')

    control.dispatchEvent(new MiniDomEvent('keydown', { bubbles: true }))
    expect(onkeydown).toHaveBeenCalledTimes(1)

    control.dispatchEvent(new MiniDomEvent('select', { bubbles: true }))
    expect(onselect).toHaveBeenCalledTimes(1)

    control.dispatchEvent(new MiniDomEvent('blur', { bubbles: false }))
    expect(onblur).toHaveBeenCalledTimes(1)

    await unmount(instance)
  })

  it('omits aria-autocomplete when ariaControls is not provided', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const instance = mount(Input, {
      target: host as unknown as Element,
      props: { ariaLabel: '検索' },
    })
    flushSync()
    const input = host.querySelector('input')!
    expect(input.getAttribute('aria-autocomplete')).toBeNull()
    expect(input.getAttribute('aria-controls')).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    await unmount(instance)
  })

  it.each([
    { multiline: false },
    { multiline: true },
  ])('updates aria-activedescendant reactively and clears when closed (multiline=$multiline)', async ({ multiline }) => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const state = $state<{ ariaControls?: string; ariaActiveDescendant?: string }>({
      ariaControls: 'list-1',
      ariaActiveDescendant: 'opt-1',
    })

    const instance = mount(Input, {
      target: host as unknown as Element,
      props: {
        ariaLabel: '検索',
        multiline,
        get ariaControls() { return state.ariaControls },
        get ariaActiveDescendant() { return state.ariaActiveDescendant },
      },
    })
    flushSync()

    const control = host.querySelector(multiline ? 'textarea' : 'input')!
    expect(control.getAttribute('aria-activedescendant')).toBe('opt-1')

    state.ariaActiveDescendant = 'opt-2'
    flushSync()
    expect(control.getAttribute('aria-activedescendant')).toBe('opt-2')

    state.ariaControls = undefined
    state.ariaActiveDescendant = undefined
    flushSync()
    expect(control.getAttribute('aria-activedescendant')).toBeNull()
    expect(control.getAttribute('aria-controls')).toBeNull()
    expect(control.getAttribute('aria-autocomplete')).toBeNull()

    await unmount(instance)
  })
})

describe('Composer.svelte IME composition (#833)', () => {
  it('does not send on Enter while IME is composing (isComposing, keyCode 229, which 229) and sends on plain Enter', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const onsubmit = vi.fn(async () => true)
    const props = $state({ body: 'こんにちは' })

    const instance = mount(Composer, {
      target: host as unknown as Element,
      props: {
        get value() { return props.body },
        oninput: (body) => { props.body = body },
        onsubmit,
      },
    })
    flushSync()

    const textarea = host.querySelector('textarea')!
    expect(textarea).not.toBeNull()

    // 1. Enter with isComposing: true
    const e1 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    e1.key = 'Enter'
    e1.isComposing = true
    textarea.dispatchEvent(e1)
    expect(e1.defaultPrevented).toBe(false)
    expect(onsubmit).not.toHaveBeenCalled()

    // 2. Enter with keyCode: 229
    const e2 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    e2.key = 'Enter'
    e2.isComposing = false
    e2.keyCode = 229
    textarea.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(false)
    expect(onsubmit).not.toHaveBeenCalled()

    // 3. Enter with which: 229
    const e3 = Object.assign(new MiniDomEvent('keydown', { bubbles: true, cancelable: true }), {
      key: 'Enter',
      isComposing: false,
      which: 229,
    })
    textarea.dispatchEvent(e3)
    expect(e3.defaultPrevented).toBe(false)
    expect(onsubmit).not.toHaveBeenCalled()

    // 4. Plain Enter sends
    const e4 = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    e4.key = 'Enter'
    e4.isComposing = false
    e4.keyCode = 13
    textarea.dispatchEvent(e4)
    expect(e4.defaultPrevented).toBe(true)
    expect(onsubmit).toHaveBeenCalledTimes(1)

    await unmount(instance)
  })

  it('updates aria-activedescendant as Mention selection moves and clears when closed', async () => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const props = $state({
      body: '',
      members: [
        { id: '123e4567-e89b-12d3-a456-426614174000', name: '田中', role: 'member' as const },
        { id: '123e4567-e89b-12d3-a456-426614174001', name: '鈴木', role: 'member' as const },
      ],
    })

    const instance = mount(Composer, {
      target: host as unknown as Element,
      props: {
        get value() { return props.body },
        get members() { return props.members },
        oninput: (body) => { props.body = body },
        onsubmit: vi.fn(async () => true),
      },
    })
    flushSync()

    const textarea = host.querySelector('textarea')!
    textarea.value = '@'
    textarea.selectionStart = 1
    textarea.selectionEnd = 1
    textarea.dispatchEvent(new MiniDomEvent('input', { bubbles: true }))
    flushSync()

    const options = host.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(2)
    expect(textarea.getAttribute('aria-activedescendant')).toBe(options[0].id)

    const down = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    down.key = 'ArrowDown'
    textarea.dispatchEvent(down)
    flushSync()
    expect(options[1].getAttribute('aria-selected')).toBe('true')
    expect(textarea.getAttribute('aria-activedescendant')).toBe(options[1].id)

    const esc = new MiniDomEvent('keydown', { bubbles: true, cancelable: true })
    esc.key = 'Escape'
    textarea.dispatchEvent(esc)
    flushSync()
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(textarea.getAttribute('aria-activedescendant')).toBeNull()

    await unmount(instance)
  })
})

describe('MessageRow.svelte timestamp formatting (#833)', () => {
  it.each([
    '2026-01-02T03:04:05.000Z',
    '2026-11-24T13:19:21.000Z',
    '2025-12-31T23:59:59.000Z',
    '2024-02-29T00:00:00.000Z',
  ])('formats %s identically to Date.prototype.toLocaleString("ja-JP")', async (iso) => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)

    const instance = mount(MessageRow, {
      target: host as unknown as Element,
      props: {
        body: '本文',
        createdAt: iso,
      },
    })
    flushSync()

    const timeEl = host.querySelector('time.ui-message-row__time')!
    expect(timeEl).not.toBeNull()
    expect(timeEl.getAttribute('datetime')).toBe(iso)
    expect(timeEl.textContent).toBe(new Date(iso).toLocaleString('ja-JP'))

    await unmount(instance)
  })

  function renderedTime(createdAt: string): string | null | undefined {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const row = mount(MessageRow, { target: host as unknown as Element, props: { body: '本文', createdAt } })
    flushSync()
    const text = host.querySelector('time.ui-message-row__time')?.textContent
    void unmount(row)
    return text
  }

  it.each([
    ['America/Los_Angeles', '2026-03-08T09:59:59Z'],
    ['America/Los_Angeles', '2026-03-08T10:00:00Z'],
    ['America/Los_Angeles', '2026-11-01T08:30:00Z'],
    ['Asia/Tokyo', '1880-01-01T00:00:00Z'],
    ['Asia/Kolkata', '2026-06-15T18:29:30Z'],
    ['Pacific/Chatham', '2026-04-05T02:44:59Z'],
    ['America/Los_Angeles', '2026-11-01T09:30:00Z'],
    ['Asia/Tokyo', '0050-06-01T00:00:00Z'],
    ['Asia/Tokyo', '0099-12-31T23:00:00Z'],
    ['Asia/Tokyo', '-000500-03-01T00:00:00Z'],
    ['Asia/Tokyo', '+012345-07-08T09:10:11Z'],
    ['Asia/Tokyo', '+275760-09-13T00:00:00.000Z'],
    ['America/Los_Angeles', '-271821-04-20T00:00:00.000Z'],
  ])('matches toLocaleString("ja-JP") in %s at %s (DST edges, non-minute offsets)', (tz, iso) => {
    const prevTz = process.env.TZ
    try {
      process.env.TZ = tz
      expect(renderedTime(iso)).toBe(new Date(iso).toLocaleString('ja-JP'))
    } finally {
      if (prevTz === undefined) delete process.env.TZ
      else process.env.TZ = prevTz
    }
  })

  it('renders Invalid Date like toLocaleString for an unparsable time', () => {
    expect(renderedTime('not-a-date')).toBe(new Date('not-a-date').toLocaleString('ja-JP'))
  })

  it('formats rows with the shared formatter, not a per-row formatter', () => {
    const ctor = vi.spyOn(Intl, 'DateTimeFormat')
    const perRow = vi.spyOn(Date.prototype, 'toLocaleString')
    try {
      for (let i = 0; i < 5; i++) renderedTime('2026-01-02T03:04:05Z')
      expect(ctor).not.toHaveBeenCalled()
      expect(perRow).not.toHaveBeenCalled()
    } finally {
      ctor.mockRestore()
      perRow.mockRestore()
    }
  })

  it('uses the current time zone at render time when TZ changes between formats', async () => {
    const iso = '2026-01-02T03:04:05Z'
    const prevTz = process.env.TZ
    try {
      process.env.TZ = 'Asia/Tokyo'
      const hostTokyo = dom.doc.createElement('div')
      dom.doc.body.appendChild(hostTokyo)
      const tokyoRow = mount(MessageRow, {
        target: hostTokyo as unknown as Element,
        props: { body: '本文', createdAt: iso },
      })
      flushSync()
      expect(hostTokyo.querySelector('time.ui-message-row__time')?.textContent).toBe('2026/1/2 12:04:05')
      await unmount(tokyoRow)

      process.env.TZ = 'America/Los_Angeles'
      const hostLa = dom.doc.createElement('div')
      dom.doc.body.appendChild(hostLa)
      const laRow = mount(MessageRow, {
        target: hostLa as unknown as Element,
        props: { body: '本文', createdAt: iso },
      })
      flushSync()
      expect(hostLa.querySelector('time.ui-message-row__time')?.textContent).toBe('2026/1/1 19:04:05')
      await unmount(laRow)
    } finally {
      if (prevTz === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = prevTz
      }
    }
  })
})
