<script lang="ts">
  import type { Channel, Member } from './api'
  import type { channelMembersAdapter } from './channel-members.svelte'
  import { roleNames } from './members'
  import Button from './ui/Button.svelte'
  import Chip from './ui/Chip.svelte'
  import Dialog from './ui/Dialog.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let { model, channel, self, candidates }: {
    model: ReturnType<typeof channelMembersAdapter>; channel: Channel; self: string; candidates: Member[]
  } = $props()
  const s = $derived(model.state)
  const additions = $derived(candidates.filter(m => !s.members.some(current => current.id === m.id)))
  let removing = $state<Member | null>(null)
  const leaving = $derived(removing?.id === self)
</script>

<section aria-label="チャンネルのメンバー" aria-busy={s.loading}>
  {#if s.unavailable}
    <EmptyState title="このチャンネルは利用できません" description="チャンネル一覧から選び直してください。" />
  {:else}
    {#if s.loading}<Skeleton rows={3} />{/if}
    {#if s.error}<StatusBanner tone="danger" role="alert" message={s.error} actionLabel={s.retryable ? "再試行" : undefined} onaction={s.retryable ? () => void model.load() : undefined} />{/if}
    {#if !s.loading && s.members.length === 0}<EmptyState title="メンバーがいません。" description="追加するとチャンネルに参加できます。" />{/if}
    <ul>
      {#each s.members as member (member.id)}
        <li>
          <span>{member.name}</span><Chip>{roleNames[member.role]}</Chip>
          {#if member.id === self ? channel.capabilities.can_leave.allowed : channel.capabilities.can_remove_members.allowed}
            <Button variant="quiet" disabled={s.busy} ariaLabel={`${member.name}${member.id === self ? 'としてチャンネルを退出' : 'をチャンネルから外す'}`} onclick={() => removing = member}>{member.id === self ? '退出する' : '外す'}</Button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if channel.capabilities.can_add_members.allowed}
      <h3>メンバーを追加</h3>
      <ul>
        {#each additions as member (member.id)}
          <li><span>{member.name}</span><Chip>{roleNames[member.role]}</Chip><Button disabled={s.busy} ariaLabel={`${member.name}を追加`} onclick={() => void model.add(member.id)}>追加する</Button></li>
        {/each}
      </ul>
      {#if additions.length === 0}<EmptyState title="追加できるメンバーがいません。" />{/if}
    {/if}
  {/if}
</section>
<Dialog open={removing !== null && !s.unavailable} title={leaving ? 'チャンネルを退出しますか？' : 'メンバーをチャンネルから外しますか？'}
  description={leaving ? 'プライベートチャンネルやゲストの参加先には、再び追加されるまでアクセスできなくなります。' : `${removing?.name ?? ''}さんは、参加が必要なチャンネルへのアクセス権を失います。`}
  confirmLabel={leaving ? '退出する' : '外す'} oncancel={() => removing = null}
  onconfirm={() => { const id = removing?.id; removing = null; if (id) void model.remove(id) }} />

<style>
  section { display: grid; gap: var(--space-12); min-width: 0; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: var(--space-8); }
  li { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-8); min-width: 0; }
  span { overflow-wrap: anywhere; min-width: 0; }
  h3 { margin: 0; font-size: var(--font-size-15); font-weight: var(--font-weight-semibold); }
</style>
