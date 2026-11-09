<script lang="ts">
  import { createChannels } from './channels'
  import { createTimelines } from './timeline'
  import ChannelList from './ChannelList.svelte'
  import CreateChannelForm from './CreateChannelForm.svelte'
  import Timeline from './Timeline.svelte'
  import { createRealtime } from './realtime'

  let { selfId, onSessionEnded }: { selfId: string; onSessionEnded: () => void } = $props()

  const channels = createChannels()
  // svelte-ignore state_referenced_locally
  const timelines = createTimelines(undefined, undefined, selfId)
  const realtime = createRealtime({
    onEvent: (e) => {
      if (e.type === 'message') timelines.get(e.message.channel_id).receive(e.message)
    },
    // svelte-ignore state_referenced_locally
    onSessionEnded,
    cursor: (id) => timelines.get(id).lastSeq(),
  })
  let live = $state(realtime.get())
  const stopLive = realtime.subscribe(() => (live = realtime.get()))
  $effect(() => () => {
    stopLive()
    realtime.close()
  })

  let s = $state(channels.get())
  const unsubscribe = channels.subscribe(() => (s = channels.get()))
  channels.load()
  $effect(() => unsubscribe)

  // Watch the selected channel once its history is loaded, so the resume cursor is a real seq.
  // Only the selected channel stays watched: the server caps subscriptions per connection.
  // `selectedId` is derived so the effect re-runs only when the selection itself changes.
  const selectedId = $derived(s.selectedId)
  $effect(() => {
    const id = selectedId
    if (!id) return
    const t = timelines.get(id)
    const watch = () => t.get().status === 'ready' && realtime.watch(id)
    watch()
    const stop = t.subscribe(watch)
    return () => {
      stop()
      realtime.unwatch(id)
    }
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
      <small data-testid="live-status" data-live={live.subscribed.has(selected.id)}>
        {live.subscribed.has(selected.id) ? 'リアルタイム接続済み' : 'リアルタイムに接続中…'}
      </small>
      {#key selected.id}<Timeline timeline={timelines.get(selected.id)} />{/key}
    {:else if s.status === 'ready'}
      <p>チャンネルがありません。左のフォームから作成してください。</p>
    {/if}
  </div>
</div>
