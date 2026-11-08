<script lang="ts">
  import { sendErrorMessage, type createTimeline } from './timeline'
  import Composer from './Composer.svelte'

  // The parent keys this component by channel and owns the instance (it outlives this component).
  let { timeline: given }: { timeline: ReturnType<typeof createTimeline> } = $props()
  // svelte-ignore state_referenced_locally
  const timeline = given
  let s = $state(timeline.get())
  const unsubscribe = timeline.subscribe(() => (s = timeline.get()))
  if (s.status !== 'ready') timeline.loadLatest()
  $effect(() => unsubscribe)
</script>

<section aria-label="タイムライン">
  {#if s.status === 'loading'}
    <p>読み込み中…</p>
  {:else if s.status === 'error'}
    <p role="alert">メッセージを読み込めませんでした。</p>
    <button type="button" onclick={() => timeline.loadLatest()}>再試行</button>
  {:else}
    {#if s.hasOlder}
      <button type="button" disabled={s.loadingOlder} onclick={() => timeline.loadOlder()}>以前のメッセージを読み込む</button>
    {/if}
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
            {#if p.retryable}<button type="button" onclick={() => timeline.retry(p.clientMessageId)}>再送</button>{/if}
            <button type="button" onclick={() => timeline.discard(p.clientMessageId)}>削除</button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if s.messages.length === 0 && s.pending.length === 0}<p>まだメッセージがありません。</p>{/if}
  {/if}
  <Composer onsend={(b) => timeline.send(b)} />
</section>
