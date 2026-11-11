<script lang="ts">
  import { shouldSubmitOnEnter } from './composer-keys'
  import { focusTarget, submitAndFocusComposer } from './focus-management'
  import Button from './ui/Button.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    value,
    topicValue = '',
    allowTopicName = false,
    placeholder = 'メッセージを入力',
    submitDisabled = false,
    error = null,
    disabled = false,
    textareaRef = $bindable(null),
    topicInputRef = $bindable(null),
    oninput,
    ontopicinput,
    onsubmit,
  }: {
    value: string
    topicValue?: string
    allowTopicName?: boolean
    placeholder?: string
    submitDisabled?: boolean
    error?: string | null
    disabled?: boolean
    textareaRef?: HTMLInputElement | HTMLTextAreaElement | null
    topicInputRef?: HTMLInputElement | HTMLTextAreaElement | null
    oninput: (body: string) => void
    ontopicinput?: (topicName: string) => void
    onsubmit: () => Promise<boolean>
  } = $props()

  function submit(e: Event) {
    e.preventDefault()
    if (disabled || submitDisabled) return
    submitAndFocusComposer(onsubmit, textareaRef)
  }

  function keydown(e: KeyboardEvent) {
    if (shouldSubmitOnEnter(e)) {
      submit(e)
    }
  }

  function topicKeydown(e: KeyboardEvent) {
    if (!shouldSubmitOnEnter(e)) return
    e.preventDefault()
    if (disabled || submitDisabled) return
    if (value.trim()) {
      submit(e)
    } else {
      focusTarget(textareaRef)
    }
  }
</script>

<form class="composer" onsubmit={submit}>
  {#if allowTopicName}
    <Input
      bind:inputRef={topicInputRef}
      name="topic"
      ariaLabel="トピック名"
      placeholder="トピック名（任意）"
      {disabled}
      value={topicValue}
      oninput={(v) => ontopicinput?.(v)}
      onkeydown={topicKeydown}
    />
  {/if}
  <Input
    bind:inputRef={textareaRef}
    multiline
    rows={2}
    name="body"
    ariaLabel="メッセージ"
    {placeholder}
    {disabled}
    {value}
    oninput={(v) => oninput(v)}
    onkeydown={keydown}
  />
  {#if error}
    <StatusBanner tone="danger" role="alert" message={error} />
  {/if}
  <div class="composer__actions">
    <Button variant="primary" type="submit" disabled={disabled || submitDisabled || !value.trim()}>送信</Button>
  </div>
</form>

<style>
  .composer {
    display: grid;
    gap: var(--space-8);
    padding: var(--space-12);
    background-color: var(--bg);
    border-radius: var(--radius-16);
    min-width: 0;
  }

  .composer__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-8);
  }
</style>
