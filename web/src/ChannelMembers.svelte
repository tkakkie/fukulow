<script lang="ts">
  import type { Channel, ChannelMember, Member } from './api'
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
  let section = $state<HTMLElement | null>(null)
  let removingId = $state<string | null>(null)
  let managerChange = $state<{ id: string; manager: boolean } | null>(null)
  const removing = $derived(s.members.find(member => member.id === removingId && canRemove(member)))
  const managing = $derived(s.members.find(member => member.id === managerChange?.id &&
    member.manager !== managerChange.manager && canManage(member)))
  const granting = $derived(managerChange?.manager === true)
  const leaving = $derived(removing?.id === self)

  function canRemove(member: ChannelMember) {
    return !s.unavailable && (member.id === self ? channel.capabilities.can_leave.allowed : channel.capabilities.can_remove_members.allowed)
  }
  function canManage(member: ChannelMember) {
    return !s.unavailable && channel.capabilities.can_manage_managers.allowed && (member.manager || member.role !== 'guest')
  }

  $effect(() => {
    if (removingId !== null && !removing) removingId = null
    if (managerChange && !managing) managerChange = null
  })
</script>

<section bind:this={section} tabindex="-1" aria-label="チャンネルのメンバー" aria-busy={s.loading}>
  {#if s.unavailable}
    <EmptyState title="このチャンネルは利用できません" description="チャンネル一覧から選び直してください。" />
  {:else}
    {#if s.loading}<Skeleton rows={3} />{/if}
    {#if s.error}<StatusBanner tone="danger" role="alert" message={s.error} actionLabel={s.retryable ? "再試行" : undefined} onaction={s.retryable ? () => void model.load() : undefined} />{/if}
    {#if !s.loading && !s.error && s.members.length === 0}<EmptyState title="メンバーがいません。" description="追加するとチャンネルに参加できます。" />{/if}
    <ul>
      {#each s.members as member (member.id)}
        <li>
          <span>{member.name}</span><Chip>{roleNames[member.role]}</Chip>
          {#if member.manager}<Chip>チャンネル管理者</Chip>{/if}
          {#if canManage(member)}
            <Button variant="quiet" disabled={s.busy} ariaLabel={`${member.name}のチャンネル管理者を${member.manager ? '解除する' : '付与する'}`} onclick={() => managerChange = { id: member.id, manager: !member.manager }}>{member.manager ? 'チャンネル管理者を解除する' : 'チャンネル管理者にする'}</Button>
          {/if}
          {#if canRemove(member)}
            <Button variant="quiet" disabled={s.busy} ariaLabel={`${member.name}${member.id === self ? 'としてチャンネルを退出' : 'をチャンネルから外す'}`} onclick={() => removingId = member.id}>{member.id === self ? '退出する' : '外す'}</Button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if channel.capabilities.can_add_members.allowed && (s.members.length > 0 || (!s.loading && !s.error))}
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
<Dialog open={removing !== undefined} title={leaving ? 'チャンネルを退出しますか？' : 'メンバーをチャンネルから外しますか？'}
  description={leaving ? 'プライベートチャンネルやゲストの参加先には、再び追加されるまでアクセスできなくなります。' : `${removing?.name ?? ''}さんは、参加が必要なチャンネルへのアクセス権を失います。`}
  confirmLabel={leaving ? '退出する' : '外す'} returnFocusFallback={section} oncancel={() => removingId = null}
  onconfirm={() => { const id = removing?.id; removingId = null; if (id) void model.remove(id) }} />
<Dialog open={managing !== undefined} title={granting ? 'チャンネル管理者を付与しますか？' : 'チャンネル管理者を解除しますか？'}
  description={granting ? `${managing?.name ?? ''}さんにチャンネル管理者を付与します。` : `${managing?.name ?? ''}さんのチャンネル管理者を解除します。`}
  confirmLabel={granting ? '付与する' : '解除する'} returnFocusFallback={section} oncancel={() => managerChange = null}
  onconfirm={() => { const id = managing?.id, manager = granting; managerChange = null; if (id) void model.changeManager(id, manager) }} />

<style>
  section { display: grid; gap: var(--space-12); min-width: 0; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: var(--space-8); }
  li { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-8); min-width: 0; }
  span { overflow-wrap: anywhere; min-width: 0; }
  h3 { margin: 0; font-size: var(--font-size-15); font-weight: var(--font-weight-semibold); }
</style>
