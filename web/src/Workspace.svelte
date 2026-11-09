<script lang="ts">
  import { createChannels } from './channels'
  import { createSync } from './timeline'
  import ChannelList from './ChannelList.svelte'
  import CreateChannelForm from './CreateChannelForm.svelte'
  import Timeline from './Timeline.svelte'

  let { selfId, onSessionEnded }: { selfId: string; onSessionEnded: () => void } = $props()

  const channels = createChannels()
  // svelte-ignore state_referenced_locally
  const sync = createSync({ selfId, onSessionEnded })
  sync.start()
  let live = $state(sync.get())
  const stopLive = sync.subscribe(() => (live = sync.get()))
  $effect(() => () => {
    stopLive()
    sync.close()
  })

  let s = $state(channels.get())
  const unsubscribe = channels.subscribe(() => (s = channels.get()))
  channels.load()
  $effect(() => unsubscribe)

  const selectedId = $derived(s.selectedId)
  $effect(() => {
    const id = selectedId
    if (!id) return
    sync.watch(id)
    return () => { sync.unwatch(id) }
  })

  const selected = $derived(s.channels.find((c) => c.id === s.selectedId))

  async function create(name: string, visibility: 'public' | 'private') {
    const r = await channels.create({ name, visibility })
    return 'error' in r ? r.error : null
  }
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
    <CreateChannelForm oncreate={create} />
  </aside>
  <div class="main">
    {#if selected}
      <h2>{selected.name}</h2>
      <small data-testid="live-status" data-live={live.channels[selected.id]?.subscription?.confirmed === true}>
        {live.channels[selected.id]?.subscription?.confirmed === true ? 'リアルタイム接続済み' : 'リアルタイムに接続中…'}
      </small>
      {#key selected.id}<Timeline timeline={sync.getTimeline(selected.id)} />{/key}
    {:else if s.status === 'ready'}
      <p>チャンネルがありません。左のフォームから作成してください。</p>
    {/if}
  </div>
</div>
