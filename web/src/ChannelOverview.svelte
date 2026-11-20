<script lang="ts">
  import type { Channel, DmDiscovery } from './api'
  import { channelNameTooLong } from './channels.svelte'
  import Button from './ui/Button.svelte'
  import Chip from './ui/Chip.svelte'
  import Dialog from './ui/Dialog.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    channel,
    unavailable = false,
    pending = false,
    onrename,
    onarchive,
    onrestore,
    onannounce,
  }: {
    channel: Channel | DmDiscovery
    unavailable?: boolean
    /** The Channel's archived state is being re-read; its Capabilities may be stale. */
    pending?: boolean
    onrename: (name: string) => Promise<string | null>
    onarchive: () => Promise<string | null>
    onrestore: () => Promise<string | null>
    onannounce?: (message: string) => void
  } = $props()

  let nameDraft = $state('')
  let trackedChannelId = $state('')
  let syncedChannelName = $state('')
  let busy = $state(false)
  let error = $state('')
  let notice = $state('')
  let confirmAction = $state<'archive' | 'restore' | null>(null)
  let sectionEl = $state<HTMLElement | null>(null)
  const locked = $derived(busy || pending)

  const canRename = $derived(channel.kind === 'channel' && !unavailable && !channel.archived && channel.capabilities.can_rename.allowed)
  const canArchive = $derived(channel.kind === 'channel' && !unavailable && channel.capabilities.can_archive.allowed)

  $effect(() => {
    if (channel.kind !== 'channel') {
      trackedChannelId = ''
      syncedChannelName = ''
      nameDraft = ''
      error = ''
      notice = ''
      confirmAction = null
      return
    }
    if (channel.id !== trackedChannelId) {
      trackedChannelId = channel.id
      syncedChannelName = channel.name
      nameDraft = channel.name
      error = ''
      notice = ''
      confirmAction = null
    } else if (channel.name !== syncedChannelName) {
      if (nameDraft === syncedChannelName) nameDraft = channel.name
      syncedChannelName = channel.name
    }
  })

  $effect(() => {
    if (channel.kind !== 'channel' || unavailable || pending || !channel.capabilities.can_archive.allowed) {
      confirmAction = null
      return
    }
    if (confirmAction === 'archive' && channel.archived) confirmAction = null
    if (confirmAction === 'restore' && !channel.archived) confirmAction = null
  })

  async function handleRename(e: Event) {
    e.preventDefault()
    if (channel.kind !== 'channel' || !canRename || locked) return
    const targetId = channel.id
    const nextName = nameDraft
    const tooLong = channelNameTooLong(nextName)
    if (tooLong) {
      error = tooLong
      notice = ''
      return
    }
    busy = true
    error = ''
    notice = ''
    try {
      const err = await onrename(nextName)
      if (channel.kind !== 'channel' || channel.id !== targetId) return
      if (err) {
        error = err
      } else {
        syncedChannelName = nextName
        const msg = 'チャンネル名を変更しました。'
        notice = msg
        onannounce?.(msg)
      }
    } finally {
      busy = false
    }
  }

  async function handleConfirmArchiveAction() {
    if (channel.kind !== 'channel' || !canArchive || locked || !confirmAction) return
    const action = confirmAction
    const targetId = channel.id
    busy = true
    error = ''
    notice = ''
    try {
      const err = action === 'archive' ? await onarchive() : await onrestore()
      if (channel.kind !== 'channel' || channel.id !== targetId) return
      confirmAction = null
      if (err) {
        error = err
      } else {
        const msg = action === 'archive' ? 'チャンネルをアーカイブしました。' : 'チャンネルを復元しました。'
        notice = msg
        onannounce?.(msg)
      }
    } finally {
      busy = false
    }
  }
</script>

<section bind:this={sectionEl} class="channel-overview" tabindex="-1" aria-label="チャンネル概要">
  {#if channel.kind !== 'channel'}
    <EmptyState title="チャンネルを選んでください。" />
  {:else if unavailable}
    <EmptyState title="このチャンネルは利用できません" description="チャンネル一覧から選び直してください。" />
  {:else}
    <div class="channel-overview__summary">
      <p class="channel-overview__name">
        <span aria-hidden="true">{channel.visibility === 'private' ? '🔒' : '#'}</span>
        <span>{channel.name}</span>
      </p>
      <div class="channel-overview__badges">
        <Chip>{channel.visibility === 'private' ? '非公開' : '公開'}</Chip>
        {#if channel.archived}
          <Chip>アーカイブ済み</Chip>
        {/if}
      </div>
    </div>

    {#if error}
      <StatusBanner tone="danger" role="alert" message={error} />
    {/if}
    {#if notice}
      <StatusBanner tone="info" message={notice} />
    {/if}

    {#if canRename}
      <form class="channel-overview__rename" onsubmit={handleRename}>
        <Input
          label="変更後の名前"
          name="channel_name"
          required
          disabled={locked}
          bind:value={nameDraft}
        />
        <div class="channel-overview__actions">
          <Button
            variant="primary"
            type="submit"
            disabled={locked || nameDraft === '' || nameDraft === channel.name}
          >
            名前を変更
          </Button>
        </div>
      </form>
    {/if}

    {#if canArchive}
      <div class="channel-overview__archive">
        {#if channel.archived}
          <Button
            variant="secondary"
            disabled={locked}
            onclick={() => { error = ''; notice = ''; confirmAction = 'restore' }}
          >
            復元
          </Button>
        {:else}
          <Button
            variant="secondary"
            disabled={locked}
            onclick={() => { error = ''; notice = ''; confirmAction = 'archive' }}
          >
            アーカイブ
          </Button>
        {/if}
      </div>
    {/if}
  {/if}
</section>

{#if channel.kind === 'channel'}
  <Dialog
    open={confirmAction !== null}
    {busy}
    title={confirmAction === 'restore' ? 'チャンネルを復元しますか？' : 'チャンネルをアーカイブしますか？'}
    description={confirmAction === 'restore'
      ? `# ${channel.name} を復元します。復元すると再びメッセージを送信できるようになります。`
      : `# ${channel.name} をアーカイブします。アーカイブ中はメッセージを送信できませんが、履歴は引き続き閲覧できます。`}
    confirmLabel={confirmAction === 'restore' ? '復元' : 'アーカイブ'}
    cancelLabel="キャンセル"
    returnFocusFallback={sectionEl}
    oncancel={() => { if (!busy) confirmAction = null }}
    onconfirm={() => void handleConfirmArchiveAction()}
  />
{/if}

<style>
  .channel-overview {
    display: grid;
    gap: var(--space-12);
    min-width: 0;
  }

  .channel-overview__summary {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .channel-overview__name {
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    font-size: var(--font-size-15);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .channel-overview__badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
  }

  .channel-overview__rename {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .channel-overview__actions,
  .channel-overview__archive {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
  }
</style>
