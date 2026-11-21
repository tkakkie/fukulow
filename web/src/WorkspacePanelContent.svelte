<script lang="ts">
  import type { Channel, DmDiscovery, Member, Message } from './api'
  import type { channelMembersAdapter } from './channel-members.svelte'
  import ChannelMembers from './ChannelMembers.svelte'
  import ChannelOverview from './ChannelOverview.svelte'
  import type { MentionName } from './mentions'
  import type { MoveDestination, MoveResult } from './move-chain'
  import type { RepliesAdapter } from './replies.svelte'
  import ReplyPanel from './ReplyPanel.svelte'
  import type { ChannelSync } from './sync.svelte'
  import TopicList from './TopicList.svelte'
  import type { TopicsAdapter } from './topics.svelte'
  import type { UnreadAdapter } from './unread.svelte'
  import EmptyState from './ui/EmptyState.svelte'
  import type { PanelTabId } from './ui/Panel.svelte'
  import Skeleton from './ui/Skeleton.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    mode,
    activeTab,
    selected,
    currentChannel = null,
    currentTopics = null,
    currentReplies = null,
    currentUnread = null,
    channelMemberModel,
    moveChain,
    activeTopicId = null,
    activeReplyMessageId = null,
    resolvedReplyAnchor = null,
    replyTargetStatus = 'idle',
    searchReply = false,
    searchVisit,
    selfId,
    organizationUnavailable = false,
    currentTimelineUnavailable = false,
    sendDisabled = false,
    selectedArchived = false,
    archiveStatePending = false,
    members = [],
    resolveSenderName,
    resolveMentionName,
    replyComposerRef = $bindable<HTMLInputElement | HTMLTextAreaElement | null>(null),
    onannounce,
    onmentionrequest,
    onopenreplies,
    onretrytarget,
    onretryreplyload,
    ongoToChannelList,
    onrecheckmembership,
    onswitchorganization,
    onselecttopic,
    onstartnewtopic,
    onrename,
    onarchive,
    onrestore,
  }: {
    mode: 'reply' | 'tabs'
    activeTab: PanelTabId
    selected?: Channel | DmDiscovery
    currentChannel?: ChannelSync | null
    currentTopics?: TopicsAdapter | null
    currentReplies?: RepliesAdapter | null
    currentUnread?: UnreadAdapter | null
    channelMemberModel?: ReturnType<typeof channelMembersAdapter>
    moveChain?: (channel: string, anchor: string, destination: MoveDestination) => Promise<MoveResult>
    activeTopicId?: string | null
    activeReplyMessageId?: string | null
    resolvedReplyAnchor?: Message | null
    replyTargetStatus?: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
    searchReply?: boolean
    searchVisit?: symbol
    selfId?: string
    organizationUnavailable?: boolean
    currentTimelineUnavailable?: boolean
    sendDisabled?: boolean
    selectedArchived?: boolean
    archiveStatePending?: boolean
    members?: Member[]
    resolveSenderName?: (senderId: string) => string
    resolveMentionName?: MentionName
    replyComposerRef?: HTMLInputElement | HTMLTextAreaElement | null
    onannounce?: (message: string) => void
    onmentionrequest?: () => void
    onopenreplies?: (message: Message, opener?: HTMLElement | null) => void
    onretrytarget?: () => void
    onretryreplyload?: () => void
    ongoToChannelList?: () => void
    onrecheckmembership?: () => void
    onswitchorganization?: () => void
    onselecttopic: (topicId: string) => void
    onstartnewtopic?: () => void
    onrename: (name: string) => Promise<string | null>
    onarchive: () => Promise<string | null>
    onrestore: () => Promise<string | null>
  } = $props()

  const channelUnavailable = $derived(organizationUnavailable || currentTimelineUnavailable)
</script>

{#if mode === 'reply'}
  {#if currentReplies && currentChannel && selected && activeReplyMessageId}
    <ReplyPanel
      channel={currentChannel}
      replies={currentReplies}
      topics={currentTopics}
      {moveChain}
      {onannounce}
      channelId={selected.id}
      anchorMessageId={activeReplyMessageId}
      resolvedAnchor={resolvedReplyAnchor}
      {replyTargetStatus}
      {searchReply}
      {searchVisit}
      selfId={selfId ?? ''}
      {organizationUnavailable}
      {sendDisabled}
      archived={selectedArchived}
      bind:composerRef={replyComposerRef}
      {resolveSenderName}
      {resolveMentionName}
      {members}
      {onmentionrequest}
      {onopenreplies}
      {onretrytarget}
      {ongoToChannelList}
      {onrecheckmembership}
      {onswitchorganization}
    />
  {:else if replyTargetStatus === 'loading'}
    <Skeleton rows={3} label="返信のつながりを読み込み中" />
  {:else if replyTargetStatus === 'error'}
    <StatusBanner
      tone="danger"
      role="alert"
      message="返信のつながりを読み込めませんでした。"
      actionLabel="再試行"
      onaction={onretryreplyload}
    />
  {:else}
    <EmptyState
      title={replyTargetStatus === 'unavailable' ? 'この返信のつながりは利用できません。' : '返信のつながりの表示は準備中です。'}
    />
  {/if}
{:else if activeTab === 'topics'}
  {#if currentTopics && selected}
    <TopicList
      {resolveMentionName}
      topics={currentTopics}
      unread={currentUnread}
      channelId={selected.id}
      {activeTopicId}
      unavailable={channelUnavailable}
      {onselecttopic}
      onstartnewtopic={channelUnavailable || sendDisabled ? undefined : onstartnewtopic}
    />
  {:else}
    <EmptyState title="チャンネルを選んでください。" />
  {/if}
{:else if activeTab === 'overview'}
  {#if selected?.kind === 'channel'}
    <ChannelOverview
      channel={selected}
      unavailable={channelUnavailable}
      pending={archiveStatePending}
      {onrename}
      {onarchive}
      {onrestore}
      {onannounce}
    />
  {:else}
    <EmptyState title="チャンネルを選んでください。" />
  {/if}
{:else}
  {#if channelMemberModel && selected?.kind === 'channel' && selfId !== undefined}
    <ChannelMembers
      model={channelMemberModel}
      channel={selected}
      self={selfId}
      candidates={members}
    />
  {:else}
    <EmptyState title="チャンネルを選んでください。" />
  {/if}
{/if}
