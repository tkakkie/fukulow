<script lang="ts">
  import type { Identity, Member, Role } from './api'
  import { roles, roleNames } from './members'
  import type { membersAdapter } from './members.svelte'
  import OutstandingInvites from './OutstandingInvites.svelte'
  import Button from './ui/Button.svelte'
  import Dialog from './ui/Dialog.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    model,
    identity,
    onchanged,
    onopen,
  }: {
    model: ReturnType<typeof membersAdapter>
    identity: Identity
    onchanged(id: string): void
    onopen?(): void
  } = $props()

  let email = $state('')
  let deactivating = $state<Member | null>(null)
  let summary = $state<HTMLElement | null>(null)
  let role = $state<Role>('member')
  const s = $derived(model.state)
  const capabilities = $derived(identity.organization.capabilities)
</script>

<details class="member-list" ontoggle={event => { if (event.currentTarget.open) { onopen?.(); if (capabilities.can_invite.allowed) void model.invites.load() } }}>
  <summary bind:this={summary} class="member-list__summary">メンバー</summary>
  <div class="member-list__body">
    {#if s.loading}
      <p class="member-list__meta">読み込み中…</p>
    {/if}
    {#if s.error}
      <StatusBanner tone="danger" role="alert" message={s.error} />
    {/if}
    <ul class="member-list__items">
      {#each s.members as member (member.id)}
        <li class="member-list__item">
          <span class="member-list__name">{member.name}（{roleNames[member.role]}）</span>
          {#if capabilities.can_manage_roles.allowed}
            <label class="member-list__field">
              <span class="member-list__label">ロール</span>
              <select
                class="member-list__select"
                aria-label={`${member.name}のロール`}
                value={member.role}
                disabled={s.busy}
                onchange={async (e) => {
                  const select = e.currentTarget
                  if (await model.role(member.id, select.value as Role)) onchanged(member.id)
                  else select.value = member.role
                }}
              >
                {#each roles as role}
                  <option value={role}>{roleNames[role]}</option>
                {/each}
              </select>
            </label>
          {/if}
          {#if capabilities.can_deactivate_members.allowed && member.id !== identity.member.id && (identity.member.role === 'owner' || member.role !== 'owner')}
            <Button disabled={s.busy} onclick={() => deactivating = member}>{member.name}を無効化</Button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if capabilities.can_invite.allowed}
      <OutstandingInvites model={model.invites} members={s.members} />
      <form
        class="member-list__invite-form"
        onsubmit={(e) => {
          e.preventDefault()
          void model.invite(email, role)
        }}
      >
        <h2 class="member-list__heading">メンバーを招待</h2>
        <Input label="メールアドレス" type="email" required bind:value={email} />
        <label class="member-list__field">
          <span class="member-list__label">ロール</span>
          <select class="member-list__select" aria-label="招待するロール" bind:value={role}>
            {#each roles.filter((r) => r !== 'owner' || capabilities.can_manage_roles.allowed) as role}
              <option value={role}>{roleNames[role]}</option>
            {/each}
          </select>
        </label>
        <Button variant="primary" type="submit" disabled={s.busy}>招待リンクを作成</Button>
      </form>
      {#if s.inviteLink}
        <div class="member-list__invite-result">
          <label class="member-list__field">
            <span class="member-list__label">招待リンク（7日間有効・1回限り）</span>
            <input class="member-list__readonly-input" readonly value={s.inviteLink} />
          </label>
          <p class="member-list__meta">このリンクを招待先の方に共有してください。</p>
        </div>
      {/if}
    {/if}
  </div>
</details>

<Dialog open={deactivating !== null} title="メンバーを無効化しますか？"
  description={`${deactivating?.name ?? ''}はこの組織を利用できなくなります。過去のメッセージは残ります。`}
  confirmLabel="無効化する" returnFocusFallback={summary} oncancel={() => deactivating = null}
  onconfirm={() => { const target = deactivating; deactivating = null; if (target) void model.deactivate(target.id).then(ok => { if (ok) { onchanged(target.id); summary?.focus() } }) }} />

<style>
  .member-list {
    padding-top: var(--space-8);
    min-width: 0;
  }

  .member-list__summary {
    cursor: pointer;
    padding: var(--space-4) var(--space-8);
    border-radius: var(--radius-8);
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
    user-select: none;
  }

  .member-list__summary:hover {
    background-color: var(--hover);
  }

  .member-list__body {
    display: grid;
    gap: var(--space-12);
    padding-top: var(--space-8);
    min-width: 0;
  }

  .member-list__items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .member-list__item {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-8);
    background-color: var(--surface);
    border-radius: var(--radius-8);
    font-size: var(--font-size-13);
    color: var(--text);
    min-width: 0;
  }

  .member-list__name {
    overflow-wrap: anywhere;
  }

  .member-list__field {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .member-list__label {
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-medium);
    color: var(--text2);
  }

  .member-list__select,
  .member-list__readonly-input {
    width: 100%;
    min-width: 0;
    min-height: var(--touch-target);
    padding: var(--space-4) var(--space-8);
    background-color: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-input);
    border-radius: var(--radius-8);
    font-family: var(--font-sans);
    font-size: var(--font-size-14);
  }

  .member-list__invite-form,
  .member-list__invite-result {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .member-list__heading {
    margin: 0;
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-semibold);
    color: var(--text);
  }

  .member-list__meta {
    margin: 0;
    font-size: var(--font-size-12);
    color: var(--text2);
  }
</style>
