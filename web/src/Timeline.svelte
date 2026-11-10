<script lang="ts">
  import type { ChannelSync } from './sync.svelte'
  import Composer from './Composer.svelte'

  // The session owns the sync controller and outlives this component; this only displays its state.
  let { channel }: { channel: ChannelSync } = $props()
  const s = $derived(channel.timeline)

  const sendErrorMessage = (retryable: boolean) =>
    retryable ? '送信できませんでした。再送できます。' : '送信できませんでした。内容を確認してください。'
</script>

<section aria-label="タイムライン">
  {#if s.status === 'loading'}
    <p>読み込み中…</p>
  {:else if s.status === 'unavailable'}
    <p role="alert">このチャンネルは利用できません。</p>
    <button type="button" onclick={() => channel.loadLatest()}>再試行</button>
  {:else if s.status === 'error'}
    <p role="alert">メッセージを読み込めませんでした。</p>
    <button type="button" onclick={() => channel.loadLatest()}>再試行</button>
  {/if}
  {#if s.hasOlder && s.status !== 'unavailable'}
    <button type="button" disabled={s.loadingOlder} onclick={() => channel.loadOlder()}>以前のメッセージを読み込む</button>
    {#if s.olderError}<p role="alert">以前のメッセージを読み込めませんでした。</p>{/if}
  {/if}
  {#if s.messages.length > 0 || s.pending.length > 0}
    <ul>
      {#each s.messages as m (m.id)}
        <li><time datetime={m.created_at}>{new Date(m.created_at).toLocaleString('ja-JP')}</time> <span class="body">{m.body}</span></li>
      {/each}
      {#each s.pending as p (p.clientMessageId)}
        <li data-status={p.status}>
          <span class="body">{p.body}</span>
          {#if p.status === 'sending'}
            <small>送信中…</small>
          {:else}
            <small role="alert">{sendErrorMessage(p.retryable)}</small>
            {#if p.retryable}
              <button type="button" disabled={s.status === 'unavailable'} onclick={() => channel.retry(p.clientMessageId)}>再送</button>
            {:else}
              <button type="button" onclick={() => channel.restore(p.clientMessageId)}>編集</button>
            {/if}
            <button type="button" onclick={() => channel.discard(p.clientMessageId)}>削除</button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if s.status === 'ready'}
    <p>まだメッセージがありません。</p>
  {/if}
  <Composer
    value={s.draft}
    error={s.composerError}
    disabled={s.status === 'unavailable'}
    oninput={(b) => channel.setDraft(b)}
    onsubmit={() => channel.submit()}
  />
</section>
