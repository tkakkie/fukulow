<script lang="ts">
  import type { DmPeer } from './api-schema'
  import StatusBanner from './ui/StatusBanner.svelte'
  let { peer, lapsed = false, canRenew = false, busy = false, onrenew }: {
    peer: DmPeer; lapsed?: boolean; canRenew?: boolean; busy?: boolean; onrenew(): void
  } = $props()
</script>

{#if !peer.active}
  <StatusBanner message="このメンバーは無効化されています。履歴は引き続き閲覧できます。" />
{:else if lapsed}
  <StatusBanner message="このダイレクトメッセージには現在送信できません。"
    actionLabel={canRenew && !busy ? 'ダイレクトメッセージを開く' : undefined} onaction={onrenew} />
{/if}
