<script lang="ts">
  import type { ChannelCreationBlocked } from './channel-creation'
  import StatusBanner from './ui/StatusBanner.svelte'

  const messages = {
    'access-changed': 'チャンネルを作成する権限が変更された可能性があります。確認が終わってから、もう一度お試しください。',
    denied: 'チャンネルを作成する権限がありません。',
    'check-failed': 'チャンネルを作成する権限を確認できませんでした。時間をおいて、もう一度お試しください。',
  } satisfies Record<ChannelCreationBlocked['blocked'], string>

  let props: { kind: 'hint'; id: string; visible: boolean }
    | { kind: 'alert'; reason: ChannelCreationBlocked['blocked'] } = $props()
</script>

{#if props.kind === 'hint'}
  <p id={props.id} aria-hidden={!props.visible}>
    チャンネルを作成する権限を確認できるまで、作成できません。
  </p>
{:else}
  <StatusBanner tone="danger" role="alert" message={messages[props.reason]} />
{/if}

<style>
  p {
    margin: 0;
    color: var(--text2);
    font-size: var(--font-size-13);
  }

  /* Keep the wrapped text's space so a permission check never moves Channel rows. */
  p[aria-hidden='true'] {
    visibility: hidden;
  }
</style>
