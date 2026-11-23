<script lang="ts">
  import type { FocusableTarget } from '../focus-management'
  import Dialog from './Dialog.svelte'

  let {
    pendingId,
    description,
    returnFocusFallback = null,
    onconfirm,
    oncancel,
  }: {
    pendingId: string | null
    description: string
    returnFocusFallback?: FocusableTarget | null
    onconfirm: () => void
    oncancel: () => void
  } = $props()
</script>

<Dialog
  open={pendingId !== null}
  title="入力中の下書きを置き換えますか？"
  {description}
  confirmLabel="置き換える"
  cancelLabel="キャンセル"
  {returnFocusFallback}
  {onconfirm}
  {oncancel}
/>
