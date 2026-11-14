<script lang="ts">
  import { channelNameTooLong, type ChannelVisibility } from './channels.svelte'
  import Button from './ui/Button.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  const local = $state({ name: '', visibility: 'public' as ChannelVisibility, error: '', busy: false })
  let {
    oncreate,
    draft = local,
  }: {
    oncreate: (name: string, visibility: ChannelVisibility) => Promise<string | null>
    draft?: typeof local
  } = $props()

  async function submit(e: Event) {
    e.preventDefault()
    const tooLong = channelNameTooLong(draft.name)
    if (tooLong) {
      draft.error = tooLong
      return
    }
    draft.busy = true
    const err = await oncreate(draft.name, draft.visibility)
    draft.busy = false
    draft.error = err ?? ''
    if (!err) {
      draft.name = ''
      draft.visibility = 'public'
    }
  }
</script>

<form class="create-channel-form" onsubmit={submit}>
  <Input label="チャンネル名" name="channel_name" required bind:value={draft.name} />
  <fieldset disabled={draft.busy}>
    <legend>公開範囲</legend>
    <label>
      <input type="radio" name="channel_visibility" value="public" checked={draft.visibility === 'public'} onchange={() => { draft.visibility = 'public' }} />
      公開
    </label>
    <label>
      <input type="radio" name="channel_visibility" value="private" checked={draft.visibility === 'private'} onchange={() => { draft.visibility = 'private' }} />
      非公開
    </label>
  </fieldset>
  {#if draft.error}
    <StatusBanner tone="danger" role="alert" message={draft.error} />
  {/if}
  <Button variant="primary" type="submit" disabled={draft.busy || draft.name === ''}>チャンネルを作成</Button>
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
