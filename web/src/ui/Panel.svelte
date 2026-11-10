<script lang="ts">
  import type { Snippet } from 'svelte'
  import Button from './Button.svelte'

  export type PanelTabId = 'topics' | 'overview' | 'members'

  const TABS: { id: PanelTabId; label: string }[] = [
    { id: 'topics', label: 'トピック' },
    { id: 'overview', label: '概要' },
    { id: 'members', label: 'メンバー' },
  ]

  let {
    title,
    ariaLabel = '詳細パネル',
    mode = 'tabs',
    activeTab = 'topics',
    showBack = false,
    headingRef = $bindable(null),
    onselecttab,
    onback,
    onclose,
    children,
  }: {
    title: string
    ariaLabel?: string
    mode?: 'tabs' | 'reply'
    activeTab?: PanelTabId
    showBack?: boolean
    headingRef?: HTMLElement | null
    onselecttab?: (tab: PanelTabId) => void
    onback?: () => void
    onclose?: () => void
    children?: Snippet
  } = $props()
</script>

<aside class="ui-panel" aria-label={ariaLabel}>
  <header class="ui-panel__header">
    <div class="ui-panel__title-row">
      {#if showBack && onback}
        <Button variant="icon" ariaLabel="前の表示に戻る" onclick={onback}>‹</Button>
      {/if}
      <h2 bind:this={headingRef} class="ui-panel__title" tabindex="-1">{title}</h2>
    </div>
    {#if onclose}
      <Button variant="icon" ariaLabel="パネルを閉じる(Esc)" onclick={onclose}>×</Button>
    {/if}
  </header>

  {#if mode === 'tabs'}
    <div class="ui-panel__tabs" role="tablist" aria-label="パネル表示切り替え">
      {#each TABS as tab (tab.id)}
        <button
          type="button"
          role="tab"
          class="ui-panel__tab"
          class:ui-panel__tab--active={activeTab === tab.id}
          aria-selected={activeTab === tab.id}
          onclick={() => onselecttab?.(tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>
  {/if}

  <div class="ui-panel__body">
    {#if children}
      {@render children()}
    {/if}
  </div>
</aside>

<style>
  .ui-panel {
    display: grid;
    grid-template-rows: auto auto 1fr;
    height: 100%;
    min-height: 0;
    min-width: 0;
    background-color: var(--surface);
    color: var(--text);
    border-radius: var(--radius-16);
    overflow: hidden;
  }

  .ui-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    padding: var(--space-12) var(--space-16);
    min-width: 0;
  }

  .ui-panel__title-row {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
  }

  .ui-panel__title {
    margin: 0;
    font-size: var(--font-size-15);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ui-panel__tabs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-4);
    padding: 0 var(--space-12) var(--space-8);
  }

  .ui-panel__tab {
    min-height: var(--touch-target);
    padding: var(--space-4) var(--space-8);
    background-color: var(--bg);
    color: var(--text2);
    border: 1px solid transparent;
    border-radius: var(--radius-8);
    font-family: var(--font-sans);
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: background-color var(--duration-fast) var(--ease-out);
  }

  .ui-panel__tab:hover {
    background-color: var(--hover);
    color: var(--text);
  }

  .ui-panel__tab--active {
    background-color: var(--tint);
    color: var(--on-tint);
    font-weight: var(--font-weight-semibold);
  }

  .ui-panel__body {
    overflow-y: auto;
    padding: var(--space-12) var(--space-16);
    min-height: 0;
    min-width: 0;
  }
</style>
