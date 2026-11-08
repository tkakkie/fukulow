<script lang="ts">
  import { createChannels } from './channels'
  import { createTimelines } from './timeline'
  import ChannelList from './ChannelList.svelte'
  import CreateChannelForm from './CreateChannelForm.svelte'
  import Timeline from './Timeline.svelte'

  const channels = createChannels()
  const timelines = createTimelines()
  let s = $state(channels.get())
  const unsubscribe = channels.subscribe(() => (s = channels.get()))
  channels.load()
  $effect(() => unsubscribe)

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
      {#key selected.id}<Timeline timeline={timelines.get(selected.id)} />{/key}
    {:else if s.status === 'ready'}
      <p>チャンネルがありません。左のフォームから作成してください。</p>
    {/if}
  </div>
</div>
