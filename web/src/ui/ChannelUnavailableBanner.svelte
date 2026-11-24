<script lang="ts">
  import StatusBanner from './StatusBanner.svelte'

  // The reply panel's detail differs from the timeline views today; #835 keeps both copies unchanged.
  const details = {
    view: 'アクセス権がないか、削除された可能性があります。',
    replyPanel: 'チャンネルが削除されたか、アクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。',
  } as const

  let {
    ongoToChannelList,
    variant = 'view',
  }: {
    ongoToChannelList?: () => void
    variant?: keyof typeof details
  } = $props()
</script>

<StatusBanner
  tone="danger"
  role="alert"
  message="このチャンネルは利用できません。"
  detail={details[variant]}
  actionLabel={ongoToChannelList ? 'チャンネル一覧へ' : undefined}
  onaction={ongoToChannelList}
/>
