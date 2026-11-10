<script lang="ts">
  import type { Identity, Role } from './api'
  import { roles, roleNames } from './members'
  import type { membersAdapter } from './members.svelte'
  let { model, identity, onchanged }: { model: ReturnType<typeof membersAdapter>; identity: Identity; onchanged(): void } = $props()
  let email = $state('')
  let role = $state<Role>('member')
  const s = $derived(model.state)
  const capabilities = $derived(identity.organization.capabilities)
</script>

<details>
  <summary>メンバー</summary>
  {#if s.loading}<p>読み込み中…</p>{/if}
  {#if s.error}<p role="alert">{s.error}</p>{/if}
  <ul>
    {#each s.members as member (member.id)}
      <li>
        {member.name}（{roleNames[member.role]}）
        {#if capabilities.can_manage_roles.allowed}
          <label>ロール
            <select aria-label={`${member.name}のロール`} value={member.role} disabled={s.busy}
              onchange={async e => { if (await model.role(member.id, e.currentTarget.value as Role)) onchanged() }}>
              {#each roles as role}<option value={role}>{roleNames[role]}</option>{/each}
            </select>
          </label>
        {/if}
      </li>
    {/each}
  </ul>
  {#if capabilities.can_invite.allowed}
    <form onsubmit={e => { e.preventDefault(); model.invite(email, role) }}>
      <h2>メンバーを招待</h2>
      <label>メールアドレス <input type="email" required bind:value={email} /></label>
      <label>ロール
        <select aria-label="招待するロール" bind:value={role}>
          {#each roles.filter(r => r !== 'owner' || capabilities.can_manage_roles.allowed) as role}
            <option value={role}>{roleNames[role]}</option>
          {/each}
        </select>
      </label>
      <button disabled={s.busy}>招待リンクを作成</button>
    </form>
    {#if s.inviteLink}
      <label>招待リンク（7日間有効・1回限り）<input readonly value={s.inviteLink} /></label>
      <p>このリンクを招待先の方に共有してください。</p>
    {/if}
  {/if}
</details>
