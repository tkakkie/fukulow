<script lang="ts">
  let {
    value,
    error = null,
    disabled = false,
    oninput,
    onsubmit,
  }: {
    value: string
    error?: string | null
    disabled?: boolean
    oninput: (body: string) => void
    onsubmit: () => Promise<boolean>
  } = $props()

  function submit(e: Event) {
    e.preventDefault()
    if (disabled) return
    void onsubmit()
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) submit(e)
  }
</script>

<form onsubmit={submit}>
  <textarea
    name="body"
    rows="2"
    aria-label="メッセージ"
    placeholder="メッセージを入力"
    {disabled}
    {value}
    oninput={(e) => oninput(e.currentTarget.value)}
    onkeydown={keydown}
  ></textarea>
  {#if error}<p role="alert">{error}</p>{/if}
  <button type="submit" disabled={disabled || !value.trim()}>送信</button>
</form>
