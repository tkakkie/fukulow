<script lang="ts">
  import type { ChannelVisibility } from './api'
  let { oncreate }: { oncreate: (name: string, visibility: ChannelVisibility) => Promise<string | null> } = $props()

  let name = $state('')
  let error = $state('')
  let busy = $state(false)

  async function submit(e: Event) {
    e.preventDefault()
    busy = true
    const err = await oncreate(name, 'public')
    busy = false
    error = err ?? ''
    if (!err) name = ''
  }
</script>

<form onsubmit={submit}>
  <label>チャンネル名 <input name="channel_name" required maxlength="80" bind:value={name} /></label>
  {#if error}<p role="alert">{error}</p>{/if}
  <button type="submit" disabled={busy || !name.trim()}>チャンネルを作成</button>
</form>
