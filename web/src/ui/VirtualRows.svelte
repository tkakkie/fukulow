<script lang="ts" generics="T, U">
  import { tick, untrack, type Snippet } from 'svelte'
  import { createRowWindow, type RowRange } from '../row-window'

  let { items, rowId, confirmedSeq, container, label, class: className = '', children,
    pendingItems, pendingId, pendingStatus, pendingRow, pendingClass = '',
    itemClass = '', followBottom = false, onvisible = () => {}, onfocuslost = () => {}, onmounted = () => {} }: {
    items: T[]
    rowId: (item: T) => string
    confirmedSeq?: (item: T) => number | null
    container: HTMLElement | null
    label: string
    class?: string
    itemClass?: string | ((item: T) => string)
    followBottom?: boolean
    children: Snippet<[T, number]>
    pendingItems: U[]
    pendingId: (item: U) => string
    pendingStatus: (item: U) => string
    pendingRow: Snippet<[U]>
    pendingClass?: string
    onvisible?: () => void
    onfocuslost?: () => void
    onmounted?: (ids: string[]) => void
  } = $props()
  let list = $state<HTMLElement | null>(null)
  let range = $state<RowRange>({ start: 0, end: 12, top: 0, bottom: 0 })
  let revealing = false
  const window = createRowWindow(next => { range = next }, () => onvisible(), () => onfocuslost(), () => {
    if (revealing || !untrack(() => followBottom)) return
    void tick().then(() => { if (!revealing && container) container.scrollTop = container.scrollHeight })
  })
  $effect(() => {
    const ids = [...items.map(rowId), ...pendingItems.map(item => `pending:${pendingId(item)}`)]
    untrack(() => window.setRows(ids))
  })
  $effect(() => { if (container && list) return window.connect(container, list) })
  $effect(() => {
    const ids = items.slice(range.start, range.end).map(rowId)
    untrack(() => onmounted(ids))
  })
  function attach(node: HTMLElement, id: string) { return window.attach(node, id) }
  function spacer(node: HTMLElement, height: number) {
    const set = (value: number) => node.style.setProperty('--row-space', `${value}px`)
    set(height)
    return { update: set }
  }
  export async function reveal(id: string, focus = false, align: 'start' | 'end' = 'start') {
    const mounted = list?.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(id)}"] .ui-message-row`)
    if (mounted && focus) { mounted.focus(); return }
    revealing = true
    window.reveal(id, align)
    await tick()
    if (focus) {
      if (typeof requestAnimationFrame !== 'undefined') await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      window.reveal(id, align)
      await tick()
      list?.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(id)}"] .ui-message-row`)?.focus({ preventScroll: true })
    }
    revealing = false
  }
</script>

<ul bind:this={list} class={className} aria-label={label}>
  <li aria-hidden="true" class="spacer" use:spacer={range.top}></li>
  {#each items.slice(range.start, range.end) as item, index (rowId(item))}
    <li class={typeof itemClass === 'function' ? itemClass(item) : itemClass} use:attach={rowId(item)} data-window-id={rowId(item)} data-message-id={rowId(item)}
      aria-posinset={range.start + index + 1} aria-setsize={items.length + pendingItems.length}
      data-confirmed-seq={confirmedSeq?.(item) ?? undefined}>
      {@render children(item, range.start + index)}
    </li>
  {/each}
  {#each pendingItems.slice(Math.max(0, range.start - items.length), Math.max(0, range.end - items.length)) as item, index (pendingId(item))}
    <li class={pendingClass} use:attach={`pending:${pendingId(item)}`} data-window-id={`pending:${pendingId(item)}`}
      data-status={pendingStatus(item)} aria-posinset={Math.max(range.start, items.length) + index + 1}
      aria-setsize={items.length + pendingItems.length}>
      {@render pendingRow(item)}
    </li>
  {/each}
  <li aria-hidden="true" class="spacer" use:spacer={range.bottom}></li>
</ul>

<style>
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; flex-shrink: 0; }
  li { min-width: 0; flex-shrink: 0; }
  .spacer { height: var(--row-space); pointer-events: none; margin-block: -2px; }
</style>
