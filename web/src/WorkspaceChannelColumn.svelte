<script lang="ts">
  import type { Identity } from './api'
  import type { Organization } from './api-schema.d.ts'
  import ArchivedChannelList from './ArchivedChannelList.svelte'
  import ChannelList from './ChannelList.svelte'
  import type { Channel, ChannelVisibility } from './channels.svelte'
  import CreateChannelForm from './CreateChannelForm.svelte'
  import type { DmRow } from './dm-list'
  import DmList from './DmList.svelte'
  import Members from './MemberList.svelte'
  import type { membersAdapter } from './members.svelte'
  import SearchBar from './SearchBar.svelte'
  import type { SectionsAdapter } from './sections.svelte'
  import type { TopicLine } from './topic-selectors'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  type ChannelCreationDraft = {
    name: string
    visibility: ChannelVisibility
    error: string
    busy: boolean
  }

  type DmListView = {
    rows: DmRow[]
    loading: boolean
    error: boolean
    message: string
    busy: boolean
    more: boolean
  }

  let {
    organizations = [],
    currentOrganizationId = '',
    organization = null,
    organizationUnavailable = false,
    showMobileSearch = false,
    searchInput = '',
    searchOpen = false,
    searchDisabled = false,
    channelListStatus,
    channelListTimedOut = false,
    sectionsReconnecting = false,
    channels,
    selectedId,
    activeTopicId = null,
    topics = [],
    allTopicsKnown = false,
    channelUnreadCount,
    channelMentionUnreadCount,
    topicUnreadCounts = {},
    sections,
    showCreateChannel = false,
    createChannelDisabled = false,
    createChannelDraft,
    archivedList,
    dms = null,
    members = null,
    authError = '',
    headingRef = $bindable<HTMLElement | null>(null),
    searchInputRef = $bindable<HTMLInputElement | HTMLTextAreaElement | null>(null),
    onselectorganization,
    onsearchinput,
    onsearchsubmit,
    onretrychannels,
    onselectchannel,
    onselecttopic,
    onopenalltopics,
    oncreatechannel,
    onholdarchived,
    onretryarchived,
    ondmmore,
    ondmretry,
    onopenmembers,
    onopendm,
    onmemberchanged,
  }: {
    organizations?: Organization[]
    currentOrganizationId?: string
    organization?: Identity | null
    organizationUnavailable?: boolean
    showMobileSearch?: boolean
    searchInput?: string
    searchOpen?: boolean
    searchDisabled?: boolean
    channelListStatus: 'loading' | 'ready' | 'error'
    channelListTimedOut?: boolean
    sectionsReconnecting?: boolean
    channels: Channel[]
    selectedId: string | null
    activeTopicId?: string | null
    topics?: readonly TopicLine[]
    allTopicsKnown?: boolean
    channelUnreadCount?: (channelId: string) => number | null
    channelMentionUnreadCount?: (channelId: string) => number | null
    topicUnreadCounts?: Readonly<Record<string, { readonly unreadCount: number | null; readonly mentionUnreadCount?: number | null }>>
    sections?: SectionsAdapter
    showCreateChannel?: boolean
    createChannelDisabled?: boolean
    createChannelDraft?: ChannelCreationDraft
    archivedList?: { status: 'loading' | 'ready' | 'error'; channels: Channel[] }
    dms?: DmListView | null
    members?: ReturnType<typeof membersAdapter> | null
    authError?: string
    headingRef?: HTMLElement | null
    searchInputRef?: HTMLInputElement | HTMLTextAreaElement | null
    onselectorganization?: (id: string) => void
    onsearchinput?: (value: string) => void
    onsearchsubmit?: (value: string) => void
    onretrychannels?: () => void
    onselectchannel: (id: string) => void
    onselecttopic?: (topicId: string) => void
    onopenalltopics?: (opener: HTMLElement | null) => void
    oncreatechannel: (name: string, visibility: ChannelVisibility) => Promise<string | null>
    onholdarchived: () => () => void
    onretryarchived: () => void
    ondmmore?: () => void
    ondmretry?: () => void
    onopenmembers?: () => void
    onopendm?: (memberId: string) => void
    onmemberchanged: (id: string) => void
  } = $props()
</script>

<div class="channel-column__header">
  {#if organizations.length > 1 && onselectorganization}
    <label class="org-switcher">
      <span class="org-switcher__label">組織</span>
      <select
        class="org-switcher__select"
        value={currentOrganizationId}
        onchange={(e) => onselectorganization(e.currentTarget.value)}
      >
        {#each organizations as org (org.organization_id)}
          <option value={org.organization_id}>{org.name}</option>
        {/each}
      </select>
    </label>
  {/if}
  {#if organization}
    <p class="member-summary">{organization.organization.name} / {organization.member.name} さん</p>
  {/if}
  <h2
    bind:this={headingRef}
    id="channel-list-heading"
    class="channel-column__heading"
    tabindex="-1"
  >
    チャンネル
  </h2>
  {#if showMobileSearch && onsearchinput && onsearchsubmit}
    <div class="channel-column__search mobile-only">
      <SearchBar
        value={searchInput}
        open={searchOpen}
        disabled={searchDisabled}
        bind:inputRef={searchInputRef}
        oninput={onsearchinput}
        onsubmit={onsearchsubmit}
      />
    </div>
  {/if}
</div>

<div class="channel-column__scroll">
  {#if !organizationUnavailable && (channelListStatus === 'error' || (channelListStatus === 'loading' && channels.length === 0 && channelListTimedOut))}
    <StatusBanner
      tone="danger"
      role="alert"
      message="チャンネルを読み込めませんでした。"
      detail="通信状況を確認して、もう一度お試しください。"
      actionLabel={sectionsReconnecting ? undefined : '再試行'}
      onaction={sectionsReconnecting ? undefined : onretrychannels}
    />
  {:else if !organizationUnavailable && !sectionsReconnecting && channelListStatus === 'loading' && channels.length === 0}
    <Skeleton rows={3} label="チャンネルを読み込み中" />
  {/if}

  <ChannelList
    {channels}
    {selectedId}
    {activeTopicId}
    {topics}
    {allTopicsKnown}
    {channelUnreadCount}
    {channelMentionUnreadCount}
    {topicUnreadCounts}
    {sections}
    disabled={organizationUnavailable}
    channelListHeading={headingRef}
    onselect={onselectchannel}
    {onselecttopic}
    {onopenalltopics}
  />
  {#if !organizationUnavailable && showCreateChannel}
    <CreateChannelForm oncreate={oncreatechannel} draft={createChannelDraft} disabled={createChannelDisabled} />
  {/if}
  <ArchivedChannelList
    list={archivedList}
    {selectedId}
    disabled={organizationUnavailable}
    onhold={onholdarchived}
    onretry={onretryarchived}
    onselect={onselectchannel}
  />
  {#if dms && ondmmore && ondmretry}
    <DmList
      rows={dms.rows}
      {selectedId}
      loading={dms.loading}
      error={dms.error}
      message={dms.message}
      busy={dms.busy}
      canOpen={Boolean(organization && organization.member.role !== 'guest')}
      more={dms.more}
      unread={channelUnreadCount}
      mentions={channelMentionUnreadCount}
      onselect={onselectchannel}
      onmore={ondmmore}
      onretry={ondmretry}
    />
  {/if}
  {#if !organizationUnavailable && members && organization}
    <Members
      model={members}
      identity={organization}
      onopen={onopenmembers}
      {onopendm}
      dmBusy={dms?.busy ?? false}
      onchanged={onmemberchanged}
    />
  {/if}
</div>

{#if authError}
  <div class="channel-column__footer">
    <StatusBanner tone="danger" role="alert" message={authError} />
  </div>
{/if}

<style>
  .channel-column__header {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .channel-column__scroll {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
    min-height: 0;
    min-width: 0;
  }

  .channel-column__footer {
    min-width: 0;
  }

  .org-switcher {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .org-switcher__label {
    font-size: var(--font-size-12);
    font-weight: var(--font-weight-medium);
    color: var(--text2);
  }

  .org-switcher__select {
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

  .member-summary {
    margin: 0;
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-medium);
    color: var(--text2);
    overflow-wrap: anywhere;
  }

  .channel-column__heading {
    margin: 0;
    border-radius: var(--radius-8);
    font-size: var(--font-size-13);
    font-weight: var(--font-weight-semibold);
    color: var(--text2);
  }

  .channel-column__search {
    min-width: 0;
    width: 100%;
  }

  .mobile-only {
    display: none;
  }

  @media (width < 600px) {
    .mobile-only {
      display: inline-flex;
    }
  }
</style>
