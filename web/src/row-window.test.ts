import { afterEach, expect, it, vi } from 'vitest'
import { createRowWindow, rowRange } from './row-window'

afterEach(() => vi.unstubAllGlobals())

it('windows ten thousand variable-height rows with overscan at both ends', () => {
  const offsets = [0]
  for (let i = 0; i < 10000; i++) offsets.push(offsets.at(-1)! + (i % 2 ? 80 : 140))
  for (const top of [0, 10000, 500000, offsets.at(-1)! - 600]) {
    const range = rowRange(offsets, top, 600)
    expect(range.end - range.start).toBeLessThan(25)
    expect(range.top + range.bottom + offsets[range.end] - offsets[range.start]).toBe(offsets.at(-1))
    expect(offsets[range.start]).toBeLessThanOrEqual(top)
    expect(offsets[range.end]).toBeGreaterThanOrEqual(top + 600)
  }
})

it('keeps one observer with per-row attach detach and preserves an anchor across prepending and trimming', () => {
  const observe = vi.fn(), unobserve = vi.fn(), disconnect = vi.fn(), constructed = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor() { constructed() }
    observe = observe; unobserve = unobserve; disconnect = disconnect
  })
  vi.stubGlobal('document', { activeElement: null })
  const update = vi.fn(), lost = vi.fn(), root = { scrollTop: 0, clientHeight: 600, offsetTop: 0,
    addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement
  const controller = createRowWindow(update, vi.fn(), lost)
  const ids = Array.from({ length: 400 }, (_, i) => String(i + 100))
  controller.setRows(ids)
  const close = controller.connect(root, { offsetTop: 0 } as HTMLElement)
  const focus = new Map<string, () => void>()
  const node = { contains: () => false, addEventListener: (event: string, handler: () => void) => focus.set(event, handler),
    removeEventListener() {} } as unknown as HTMLElement
  const row = controller.attach(node, '200')
  controller.reveal('200')
  const top = root.scrollTop
  controller.setRows(['99', ...ids].slice(0, 400))
  expect(root.scrollTop).toBe(top + 116)
  controller.setRows(ids)
  expect(root.scrollTop).toBe(top)
  expect(constructed).toHaveBeenCalledTimes(1)
  expect(observe).toHaveBeenCalledWith(node)
  focus.get('focusin')!()
  row.destroy(); expect(unobserve).toHaveBeenCalledWith(node)
  expect(lost).toHaveBeenCalledTimes(1)
  close(); expect(disconnect).toHaveBeenCalledTimes(1)
})
