<script lang="ts">
  import StatusBanner from './StatusBanner.svelte'

  let {
    onrecheckmembership,
    onswitchorganization,
  }: {
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
  } = $props()
</script>

<StatusBanner
  tone="danger"
  role="alert"
  message="この組織は利用できません。"
  detail="この組織へのアクセス権がなくなりました。送信中のメッセージが送信されたかどうかは確認できませんでした。"
  actionLabel={onrecheckmembership ? 'メンバー資格を再確認' : undefined}
  onaction={onrecheckmembership}
  secondaryActionLabel={onswitchorganization ? '組織を切り替える' : undefined}
  onsecondaryaction={onswitchorganization}
/>
