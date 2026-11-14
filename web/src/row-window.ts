export const ROW_ESTIMATE = 112
export const ROW_OVERSCAN = 560
export type RowRange = { start: number; end: number; top: number; bottom: number }

export function rowRange(offsets: readonly number[], top: number, height: number): RowRange {
  const count = offsets.length - 1
  let start = 0, end = count
  while (start < count && offsets[start + 1] < top - ROW_OVERSCAN) start++
  end = start
  while (end < count && offsets[end] <= top + height + ROW_OVERSCAN) end++
  return { start, end, top: offsets[start] ?? 0, bottom: (offsets[count] ?? 0) - (offsets[end] ?? 0) }
}

/** DOM observation is per attached row; a list update never measures the complete history. */
export function createRowWindow(update: (range: RowRange) => void, visible: () => void, focusLost: () => void, laidOut = () => {}) {
  let ids: string[] = [], offsets = [0]
  let root: HTMLElement | null = null, list: HTMLElement | null = null
  let resize: ResizeObserver | undefined, intersection: IntersectionObserver | undefined
  const heights = new Map<string, number>(), nodes = new Map<string, HTMLElement>()
  let focused: HTMLElement | null = null
  let range: RowRange = { start: 0, end: 0, top: 0, bottom: 0 }
  const listTop = () => root && list ? (list.offsetTop ?? 0) - (root.offsetTop ?? 0) : 0
  const relativeTop = () => Math.max(0, (root?.scrollTop ?? 0) - listTop())
  const anchor = () => {
    const top = relativeTop()
    let index = 0
    while (index + 1 < offsets.length && offsets[index + 1] <= top) index++
    return { id: ids[index], offset: top - offsets[index] }
  }
  const refresh = () => {
    const next = rowRange(offsets, relativeTop(), root?.clientHeight || 640)
    if (Object.keys(next).some(key => next[key as keyof RowRange] !== range[key as keyof RowRange])) {
      range = next; update(range)
    }
  }
  const layout = (saved?: ReturnType<typeof anchor>) => {
    offsets = [0]
    for (const id of ids) offsets.push(offsets.at(-1)! + (heights.get(id) ?? ROW_ESTIMATE) + 4)
    if (root && saved?.id) {
      const index = ids.indexOf(saved.id)
      if (index >= 0) root.scrollTop = listTop() + offsets[index] + saved.offset
    }
    refresh()
    laidOut()
  }
  return {
    setRows(next: string[]) {
      if (ids.length === next.length && ids.every((id, i) => id === next[i])) return
      const saved = anchor()
      ids = next
      const kept = new Set(ids)
      for (const id of heights.keys()) if (!kept.has(id)) heights.delete(id)
      layout(saved)
    },
    connect(container: HTMLElement, element: HTMLElement) {
      root = container; list = element
      root.addEventListener('scroll', refresh, { passive: true })
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(entries => {
          const saved = anchor()
          let changed = false
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.windowId
            const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
            if (id && height > 0 && heights.get(id) !== height) { heights.set(id, height); changed = true }
          }
          if (changed) layout(saved)
          else refresh()
        })
        resize.observe(root)
      }
      if (typeof IntersectionObserver !== 'undefined') {
        intersection = new IntersectionObserver(entries => {
          if (entries.some(e => e.isIntersecting)) visible()
        }, { root, threshold: 0 })
      }
      for (const node of nodes.values()) { resize?.observe(node); intersection?.observe(node) }
      refresh()
      return () => {
        container.removeEventListener('scroll', refresh)
        resize?.disconnect(); intersection?.disconnect(); resize = undefined; intersection = undefined
        root = list = null
      }
    },
    attach(node: HTMLElement, id: string) {
      nodes.set(id, node); resize?.observe(node); intersection?.observe(node)
      const focus = () => { focused = node }
      const blur = (event: FocusEvent) => {
        if (event.relatedTarget && !node.contains(event.relatedTarget as Node) && focused === node) focused = null
      }
      node.addEventListener('focusin', focus); node.addEventListener('focusout', blur)
      return { destroy() {
        node.removeEventListener('focusin', focus); node.removeEventListener('focusout', blur)
        if (focused === node || node.contains(document.activeElement)) { focused = null; focusLost() }
        resize?.unobserve(node); intersection?.unobserve(node); nodes.delete(id)
      } }
    },
    reveal(id: string, align: 'start' | 'end' = 'start') {
      const index = ids.indexOf(id)
      if (!root || index < 0) return
      root.scrollTop = Math.max(0, listTop() + offsets[align === 'end' ? index + 1 : index] -
        (align === 'end' ? root.clientHeight : 0))
      refresh()
    },
  }
}
