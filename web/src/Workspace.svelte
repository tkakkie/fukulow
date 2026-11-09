<script lang="ts">
  import type { SessionModel } from './auth.svelte'
  import ChannelList from './ChannelList.svelte'
  import CreateChannelForm from './CreateChannelForm.svelte'
  import Timeline from './Timeline.svelte'

  // The session's controllers outlive this component: unmounting it never closes the connection.
  let { session }: { session: SessionModel } = $props()
  const channels = $derived(session.channels)
  const selected = $derived(channels.selected)
</script>

<div class="workspace">
  <aside>
    {#if channels.state.status === 'error'}
      <p role="alert">チャンネルを読み込めませんでした。</p>
      <button type="button" onclick={() => channels.load()}>再試行</button>
    {:else if channels.state.status === 'loading' && channels.state.channels.length === 0}
      <p>読み込み中…</p>
    {/if}
    <ChannelList channels={channels.state.channels} selectedId={channels.state.selectedId} onselect={(id) => channels.select(id)} />
    <CreateChannelForm oncreate={(name, visibility) => channels.create(name, visibility)} />
  </aside>
  <div class="main">
    {#if selected}
      {@const channel = session.sync.channel(selected.id)}
      <h2>{selected.name}</h2>
      <small data-testid="live-status" data-live={channel.live}>
        {channel.live ? 'リアルタイム接続済み' : 'リアルタイムに接続中…'}
      </small>
      {#key selected.id}<Timeline {channel} />{/key}
    {:else if channels.state.status === 'ready'}
      <p>チャンネルがありません。左のフォームから作成してください。</p>
    {/if}
  </div>
</div>
