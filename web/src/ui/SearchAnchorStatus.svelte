<script lang="ts">
  import type { SearchPresentation } from '../search-anchor.svelte'
  import Button from './Button.svelte'
  import StatusBanner from './StatusBanner.svelte'

  let { search, onlatest }: { search: SearchPresentation; onlatest: () => void } = $props()
  const view = $derived(search.view)
</script>

{#if view?.status === 'missing'}
  <StatusBanner
    tone="danger"
    role="alert"
    message="このメッセージは表示できません。"
    actionLabel="最新のメッセージへ"
    onaction={onlatest}
  />
{:else if view?.status === 'error' || view?.pageError === 'newer' || view?.pageError === 'refresh'}
  <StatusBanner
    tone="danger"
    role="alert"
    message="メッセージを読み込めませんでした。通信状況を確認して、もう一度お試しください。"
    actionLabel="再試行"
    onaction={() => void search.retry()}
  />
{/if}

{#if view?.status === 'ready' && (view.hasNewer || view.detached)}
  <div class="search-history-actions">
    {#if view.hasNewer}
      <Button variant="secondary" disabled={view.paging} onclick={() => void search.loadNewer()}>
        次のメッセージを読み込む
      </Button>
    {/if}
    <Button variant="secondary" onclick={onlatest}>最新のメッセージへ</Button>
  </div>
{/if}

<style>
  .search-history-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
  }
</style>
