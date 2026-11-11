<script lang="ts">
  import { shouldSubmitOnEnter } from './composer-keys'
  import { focusTarget } from './focus-management'
  import Button from './ui/Button.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    value,
    error = null,
    disabled = false,
    textareaRef = $bindable(null),
    oninput,
    onsubmit,
  }: {
    value: string
    error?: string | null
    disabled?: boolean
    textareaRef?: HTMLInputElement | HTMLTextAreaElement | null
    oninput: (body: string) => void
    onsubmit: () => Promise<boolean>
  } = $props()

  function submit(e: Event) {
    e.preventDefault()
    if (disabled) return
    void onsubmit().finally(() => {
      focusTarget(textareaRef)
    })
  }

  function keydown(e: KeyboardEvent) {
    if (shouldSubmitOnEnter(e)) {
      submit(e)
    }
  }
</script>

<form class="composer" onsubmit={submit}>
  <Input
    bind:inputRef={textareaRef}
    multiline
    rows={2}
    name="body"
    ariaLabel="メッセージ"
    placeholder="メッセージを入力"
    {disabled}
    {value}
    oninput={(v) => oninput(v)}
    onkeydown={keydown}
  />
  {#if error}
    <StatusBanner tone="danger" role="alert" message={error} />
  {/if}
  <div class="composer__actions">
    <Button variant="primary" type="submit" disabled={disabled || !value.trim()}>送信</Button>
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
