<script lang="ts">
  import { isImeComposing, shouldCloseOnEscape } from './composer-keys'
  import Button from './ui/Button.svelte'
  import Input from './ui/Input.svelte'

  let {
    value = '',
    open = false,
    busy = false,
    disabled = false,
    inputRef = $bindable<HTMLInputElement | HTMLTextAreaElement | null>(null),
    oninput,
    onsubmit,
    onclose,
  }: {
    value?: string
    open?: boolean
    busy?: boolean
    disabled?: boolean
    inputRef?: HTMLInputElement | HTMLTextAreaElement | null
    oninput?: (value: string) => void
    onsubmit?: (value: string) => void
    onclose?: () => void
  } = $props()

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (disabled) return
    onsubmit?.(value)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (isImeComposing(e)) {
      if (e.key === 'Enter') e.preventDefault()
      return
    }
    if (open && onclose && shouldCloseOnEscape(e)) {
      e.preventDefault()
      onclose()
    }
  }
</script>

<form class="search-bar" role="search" aria-label="メッセージを検索" onsubmit={handleSubmit}>
  <div class="search-bar__field">
    <Input
      type="search"
      ariaLabel="メッセージを検索"
      placeholder="メッセージを検索"
      autocomplete="off"
      {value}
      {disabled}
      bind:inputRef
      oninput={(next) => oninput?.(next)}
      onkeydown={handleKeydown}
    />
  </div>
  <Button type="submit" variant="secondary" disabled={disabled || busy}>検索</Button>
</form>

<style>
  .search-bar {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
    flex: 1 1 14rem;
    max-width: 24rem;
  }

  .search-bar__field {
    flex: 1 1 8rem;
    min-width: 0;
  }
</style>
