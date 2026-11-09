<script lang="ts">
  import { channelNameTooLong, type ChannelVisibility } from './channels.svelte'
  let { oncreate }: { oncreate: (name: string, visibility: ChannelVisibility) => Promise<string | null> } = $props()

  let name = $state('')
  let error = $state('')
  let busy = $state(false)

  async function submit(e: Event) {
    e.preventDefault()
    const tooLong = channelNameTooLong(name)
    if (tooLong) {
      error = tooLong
      return
    }
    busy = true
    const err = await oncreate(name, 'public')
    busy = false
    error = err ?? ''
    if (!err) name = ''
  }
</script>

<form onsubmit={submit}>
  <label>チャンネル名 <input name="channel_name" required bind:value={name} /></label>
  {#if error}<p role="alert">{error}</p>{/if}
  <button type="submit" disabled={busy || name === ''}>チャンネルを作成</button>
</form>
