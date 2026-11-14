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
  let visibility = $state<ChannelVisibility>('public')
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
    const err = await oncreate(name, visibility)
    busy = false
    error = err ?? ''
    if (!err) {
      name = ''
      visibility = 'public'
    }
  }
</script>

<form class="create-channel-form" onsubmit={submit}>
  <Input label="チャンネル名" name="channel_name" required bind:value={name} />
  <fieldset disabled={busy}>
    <legend>公開範囲</legend>
    <label>
      <input type="radio" name="channel_visibility" value="public" checked={visibility === 'public'} onchange={() => { visibility = 'public' }} />
      公開
    </label>
    <label>
      <input type="radio" name="channel_visibility" value="private" checked={visibility === 'private'} onchange={() => { visibility = 'private' }} />
      非公開
    </label>
  </fieldset>
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

  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  legend {
    padding: 0;
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-medium);
  }

  label {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    min-height: var(--touch-target);
    cursor: pointer;
  }

  input {
    accent-color: var(--primary);
  }
</style>
