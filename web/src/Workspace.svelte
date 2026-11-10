<script lang="ts">
  import type { SessionModel } from './auth.svelte'
  import ChannelList from './ChannelList.svelte'
  import CreateChannelForm from './CreateChannelForm.svelte'
  import Timeline from './Timeline.svelte'

  // The session's controllers outlive this component: unmounting it never closes the connection.
  let { session, canCreateChannels }: { session: SessionModel; canCreateChannels: boolean } = $props()
  const channels = $derived(session.channels)
  // One adapter read per derived: every read of the adapter registers a listener effect.
  const s = $derived(channels.state)
  const selected = $derived(s.channels.find((c) => c.id === s.selectedId))
</script>

<div class="workspace">
  <aside>
    {#if s.status === 'error'}
      <p role="alert">チャンネルを読み込めませんでした。</p>
      <button type="button" onclick={() => channels.load()}>再試行</button>
    {:else if s.status === 'loading' && s.channels.length === 0}
      <p>読み込み中…</p>
    {/if}
    <ChannelList channels={s.channels} selectedId={s.selectedId} onselect={(id) => channels.select(id)} />
    {#if canCreateChannels}<CreateChannelForm oncreate={(name, visibility) => channels.create(name, visibility)} />{/if}
  </aside>
  <div class="main">
    {#if selected}
      {@const channel = session.sync.channel(selected.id)}
      <h2>{selected.name}</h2>
      {@const live = channel.live}
      <small data-testid="live-status" data-live={live}>
        {live ? 'リアルタイム接続済み' : 'リアルタイムに接続中…'}
      </small>
      {#key selected.id}<Timeline {channel} />{/key}
    {:else if s.status === 'ready'}
      <p>チャンネルがありません。</p>
    {/if}
  </div>
</div>
