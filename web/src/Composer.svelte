<script lang="ts">
  let { onsend }: { onsend: (body: string) => Promise<boolean> } = $props()
  let body = $state('')

  async function submit(e: Event) {
    e.preventDefault()
    const text = body
    body = '' // cleared at once: the message is shown optimistically
    if (!(await onsend(text))) body = text
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) submit(e)
  }
</script>

<form onsubmit={submit}>
  <textarea name="body" rows="2" aria-label="メッセージ" placeholder="メッセージを入力" bind:value={body} onkeydown={keydown}></textarea>
  <button type="submit" disabled={!body.trim()}>送信</button>
</form>
