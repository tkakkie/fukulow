<script lang="ts">
  import { isImeComposing } from './composer-keys'
  import type { FocusableTarget } from './focus-management'
  import { OTHER_CHANNELS_LABEL, validateSectionName } from './section-ui'
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
  let trackedMode = $state<SectionDialogMode>(null)

  $effect(() => {
    if (mode === trackedMode) return
    trackedMode = mode
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

  function handleNameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !isImeComposing(e) && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      handleConfirm()
    }
  }
</script>

<Dialog
  open={mode !== null}
  {busy}
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
        onkeydown={handleNameKeydown}
      />
    {:else if mode?.kind === 'move'}
      <fieldset class="section-dialog__choices" disabled={busy}>
        <legend class="section-dialog__legend">移動先</legend>
        {#each customSections as section (section.id)}
          <label class="section-dialog__option">
            <input
              type="radio"
              name="section_move_destination"
              value={section.id}
              checked={moveTarget === section.id}
              onchange={() => { moveTarget = section.id }}
            />
            <span class="section-dialog__option-label">{section.name}</span>
          </label>
        {/each}
        <label class="section-dialog__option">
          <input
            type="radio"
            name="section_move_destination"
            value=""
            checked={moveTarget === null}
            onchange={() => { moveTarget = null }}
          />
          <span class="section-dialog__option-label">{OTHER_CHANNELS_LABEL}</span>
        </label>
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
