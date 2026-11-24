<script lang="ts">
  import { channelNameTooLong, type ChannelVisibility } from './channels.svelte'
  import type { ChannelCreationBlocked } from './channel-creation'
  import Button from './ui/Button.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  const local = $state({ name: '', visibility: 'public' as ChannelVisibility, error: '',
    permissionError: null as ChannelCreationBlocked['blocked'] | null, busy: false })
  let {
    oncreate,
    draft = local,
    disabled = false,
  }: {
    oncreate: (name: string, visibility: ChannelVisibility) => Promise<string | ChannelCreationBlocked | null | false>
    draft?: typeof local
    disabled?: boolean
  } = $props()

  async function submit(e: Event) {
    e.preventDefault()
    if (disabled || draft.busy) return
    draft.permissionError = null
    const tooLong = channelNameTooLong(draft.name)
    if (tooLong) {
      draft.error = tooLong
      return
    }
    const { name, visibility } = draft
    draft.error = ''
    draft.busy = true
    const err = await oncreate(name, visibility)
    draft.busy = false
    if (err === false) return
    if (err && typeof err === 'object') {
      draft.permissionError = err.blocked
      return
    }
    draft.error = err ?? ''
    if (!err) {
      if (draft.name === name) draft.name = ''
      draft.visibility = 'public'
    }
  }
</script>

<form class="create-channel-form" aria-busy={draft.busy} onsubmit={submit}>
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
  <Button variant="primary" type="submit" disabled={disabled || draft.busy || draft.name === ''}>チャンネルを作成</Button>
  {#if disabled && !draft.busy && !draft.permissionError}
    <p class="creation-permission">チャンネルを作成する権限を確認できるまで、作成できません。</p>
  {/if}
</form>

<style>
  .create-channel-form {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .creation-permission {
    margin: 0;
    color: var(--text2);
    font-size: var(--font-size-13);
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
