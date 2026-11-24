<script lang="ts">
  import type { FocusableTarget } from './focus-management'
  import { buildMoveDestinations, OTHER_CHANNELS_LABEL, validateSectionName } from './section-ui'
  import Dialog from './ui/Dialog.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  export type SectionDialogMode =
    | { kind: 'create' }
    | { kind: 'rename'; sectionId: string; currentName: string }
    | { kind: 'delete'; sectionId: string; sectionName: string }
    | { kind: 'move'; channelId: string; channelName: string; currentSectionId: string | null }
    | null

  let {
    mode,
    busy = false,
    error = '',
    customSections = [],
    returnFocusFallback = null,
    oncreate,
    onrename,
    ondelete,
    onmove,
    onclose,
    oninputchange,
  }: {
    mode: SectionDialogMode
    busy?: boolean
    error?: string
    customSections?: readonly { id: string; name: string }[]
    returnFocusFallback?: FocusableTarget | null
    oncreate: (name: string) => void
    onrename: (sectionId: string, name: string) => void
    ondelete: (sectionId: string) => void
    onmove: (channelId: string, destinationId: string | null) => void
    onclose: () => void
    oninputchange?: () => void
  } = $props()

  let nameDraft = $state('')
  let validationError = $state('')
  let moveTarget = $state<string | null>(null)
  let trackedKey = $state<string | null>(null)

  const moveDestinations = $derived(buildMoveDestinations(customSections))

  function modeKey(m: SectionDialogMode): string | null {
    if (!m) return null
    if (m.kind === 'create') return 'create'
    if (m.kind === 'rename') return `rename:${m.sectionId}`
    if (m.kind === 'delete') return `delete:${m.sectionId}`
    return `move:${m.channelId}`
  }

  $effect(() => {
    const key = modeKey(mode)
    if (key === trackedKey) return
    trackedKey = key
    validationError = ''
    if (mode?.kind === 'create') {
      nameDraft = ''
    } else if (mode?.kind === 'rename') {
      nameDraft = mode.currentName
    } else if (mode?.kind === 'move') {
      moveTarget = mode.currentSectionId
    }
  })

  const displayError = $derived(validationError || error)

  const title = $derived.by(() => {
    if (!mode) return ''
    if (mode.kind === 'create') return 'セクションを作成'
    if (mode.kind === 'rename') return '名前を変更'
    if (mode.kind === 'delete') return 'セクションを削除'
    return 'チャンネルを移動'
  })

  const description = $derived.by(() => {
    if (!mode) return undefined
    if (mode.kind === 'delete') {
      return `「${mode.sectionName}」を削除しますか？このセクション内のチャンネルは「${OTHER_CHANNELS_LABEL}」に移動します。`
    }
    if (mode.kind === 'move') {
      return `「${mode.channelName}」の移動先を選択してください。`
    }
    return undefined
  })

  const confirmLabel = $derived.by(() => {
    if (!mode) return undefined
    if (mode.kind === 'create') return '作成する'
    if (mode.kind === 'rename') return '変更する'
    if (mode.kind === 'delete') return '削除する'
    return '移動する'
  })

  function handleConfirm() {
    if (!mode || busy) return
    if (mode.kind === 'create' || mode.kind === 'rename') {
      const invalid = validateSectionName(nameDraft)
      if (invalid) {
        validationError = invalid
        return
      }
      validationError = ''
      if (mode.kind === 'create') oncreate(nameDraft)
      else onrename(mode.sectionId, nameDraft)
      return
    }
    if (mode.kind === 'delete') {
      ondelete(mode.sectionId)
      return
    }
    onmove(mode.channelId, moveTarget)
  }
</script>

<Dialog
  open={mode !== null}
  {busy}
  form
  {title}
  {description}
  {confirmLabel}
  cancelLabel="キャンセル"
  {returnFocusFallback}
  onconfirm={handleConfirm}
  oncancel={onclose}
>
  <div class="section-dialog">
    {#if mode?.kind === 'create' || mode?.kind === 'rename'}
      <Input
        label="セクション名"
        name="section_name"
        disabled={busy}
        bind:value={nameDraft}
        oninput={() => {
          validationError = ''
          oninputchange?.()
        }}
      />
    {:else if mode?.kind === 'move'}
      <fieldset class="section-dialog__choices" disabled={busy}>
        <legend class="section-dialog__legend">移動先</legend>
        {#each moveDestinations as option (option.id ?? '__other__')}
          <label class="section-dialog__option">
            <input
              type="radio"
              name="section_move_destination"
              value={option.id ?? ''}
              checked={moveTarget === option.id}
              onchange={() => { moveTarget = option.id }}
            />
            <span class="section-dialog__option-label">{option.label}</span>
          </label>
        {/each}
      </fieldset>
    {/if}

    {#if displayError}
      <StatusBanner tone="danger" role="alert" message={displayError} />
    {/if}
  </div>
</Dialog>

<style>
  .section-dialog {
    display: grid;
    gap: var(--space-12);
    min-width: 0;
  }

  .section-dialog__choices {
    display: grid;
    gap: var(--space-4);
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .section-dialog__legend {
    padding: 0;
    margin-bottom: var(--space-4);
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-medium);
    color: var(--text);
  }

  .section-dialog__option {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    min-height: var(--touch-target);
    padding: var(--space-4) var(--space-8);
    border-radius: var(--radius-8);
    cursor: pointer;
    min-width: 0;
  }

  .section-dialog__option:hover {
    background-color: var(--hover);
  }

  .section-dialog__option input {
    accent-color: var(--primary);
    flex-shrink: 0;
  }

  .section-dialog__option-label {
    font-size: var(--font-size-14);
    color: var(--text);
    overflow-wrap: anywhere;
    min-width: 0;
  }
</style>
