<script lang="ts">
  import { channelNameTooLong, type ChannelVisibility } from './channels.svelte'
  import Button from './ui/Button.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    oncreate,
  }: {
    oncreate: (name: string, visibility: ChannelVisibility) => Promise<string | null>
  } = $props()

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

<form class="create-channel-form" onsubmit={submit}>
  <Input label="チャンネル名" name="channel_name" required bind:value={name} />
  {#if error}
    <StatusBanner tone="danger" role="alert" message={error} />
  {/if}
  <Button variant="primary" type="submit" disabled={busy || name === ''}>チャンネルを作成</Button>
</form>

<style>
  .create-channel-form {
    display: grid;
    gap: var(--space-8);
    padding-top: var(--space-12);
    min-width: 0;
  }
</style>
