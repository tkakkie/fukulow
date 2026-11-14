import type { ActivityTarget } from './activity'
import { createSubscriber } from 'svelte/reactivity'
import { createAuthOperations } from './auth-operations'
import { createAccountSecurity } from './account-security'
import { accountSecurityAdapter } from './account-security.svelte'
import { navigationTargetsAdapter } from './navigation-targets.svelte'
import { createDraftStore, type DraftStore } from './drafts'
import { parseNavigation } from './navigation-url'
import { restore, setupAndSignIn, signIn, signOut, type AuthState } from './auth'
import { getOrganizationMe, isOrganizationUnavailable, type Identity } from './api'
import type { createChannelMembers } from './channel-members'
import { channelsAdapter, type ChannelsAdapter } from './channels.svelte'
import { createSession } from './session'
import { createMembers } from './members'
import { membersAdapter } from './members.svelte'
import { syncAdapter, type SyncAdapter } from './sync.svelte'
import { repliesAdapter, type RepliesAdapter } from './replies.svelte'
import { topicsAdapter, type TopicsAdapter } from './topics.svelte'
import { unreadAdapter, type UnreadAdapter } from './unread.svelte'

export type { AuthState } from './auth'
export type SessionModel = { holdActivity?(key: string, target: ActivityTarget): unknown; navigationTargets?: ReturnType<typeof navigationTargetsAdapter>; channels: ChannelsAdapter; sync: SyncAdapter; topics(id: string): TopicsAdapter; replies?(id: string): RepliesAdapter; unread?(id: string): UnreadAdapter; channelMembers?(id: string): ReturnType<typeof createChannelMembers>; close(): void }
export type AuthDeps = {
  restore: typeof restore
  signIn: typeof signIn
  setupAndSignIn: typeof setupAndSignIn
  signOut: typeof signOut
  getOrganization: typeof getOrganizationMe
  openMembers?: (organizationId: string, onEnded: () => void, onUnavailable: () => void) => ReturnType<typeof membersAdapter>
  openSecurity?: typeof createAccountSecurity
  openSession(selfId: string, onEnded: () => void, organizationId: string, drafts?: DraftStore, onIdentity?: (identity: Identity | null) => void): SessionModel
}
const defaults: AuthDeps = {
  restore, signIn, setupAndSignIn, signOut, getOrganization: getOrganizationMe,
  openMembers: (id, ended, unavailable) => membersAdapter(createMembers(id, ended, unavailable)),
  openSession(selfId, onEnded, organizationId, drafts, onIdentity) {
    const session = createSession({ selfId, onEnded, organizationId, onIdentity, onIdentityInvalidated: () => onIdentity?.(null), sync: { drafts } })
    const topicAdapters = new Map<string, TopicsAdapter>()
    const replyAdapters = new Map<string, RepliesAdapter>()
    const unreadAdapters = new Map<string, UnreadAdapter>()
    return {
      holdActivity: session.holdActivity,
      navigationTargets: navigationTargetsAdapter(session.navigationTargets),
      channels: channelsAdapter(session.channels),
      sync: syncAdapter(session.sync),
      topics(id: string) {
        let adapter = topicAdapters.get(id)
        if (!adapter) topicAdapters.set(id, (adapter = topicsAdapter(session.topics, id)))
        return adapter
      },
      replies(id: string) {
        let adapter = replyAdapters.get(id)
        if (!adapter) replyAdapters.set(id, (adapter = repliesAdapter(session.replies, id)))
        return adapter
      },
      unread(id: string) {
        let adapter = unreadAdapters.get(id)
        if (!adapter) unreadAdapters.set(id, (adapter = unreadAdapter(session.unread, id)))
        return adapter
      },
      channelMembers: session.channelMembers,
      close: session.close,
    }
  },
}
const sessionEndedNotice = 'セッションが終了しました。もう一度ログインしてください。'

/** Account lifetime owns the 401 fence; each Organization selection owns a separate data generation. */
export function createAuth(deps: AuthDeps = defaults) {
  let view = $state<AuthState>({ screen: 'loading' })
  let organization = $state<Identity | null>(null)
  let selectedOrganizationId = $state('')
  let organizationStatus = $state<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  let session: SessionModel | null = null
  let stopMemberAvailability: (() => void) | undefined
  let members = $state<ReturnType<typeof membersAdapter> | null>(null)
  let security = $state<ReturnType<typeof accountSecurityAdapter> | null>(null)
  let changes = $state(0)
  const drafts = createDraftStore()
  let accountGeneration = 0
  let selectionGeneration = 0

  function closeOrganization() {
    stopMemberAvailability?.(); stopMemberAvailability = undefined
    session?.close(); session = null
    members?.close(); members = null
    organization = null
    selectionGeneration++
    changes++
  }
  function ended(generation: number) {
    if (generation === accountGeneration) void show({ screen: 'signin', notice: sessionEndedNotice })
  }
  async function selectOrganization(id: string) {
    if (view.screen !== 'app') return
    operations.clearError()
    closeOrganization()
    selectedOrganizationId = id
    organizationStatus = 'loading'
    const account = accountGeneration, selection = selectionGeneration
    const result = await deps.getOrganization(id)
    // Account Session rejection remains authoritative even when this selection was replaced.
    if (!result.ok && result.kind === 'http' && result.status === 401) { ended(account); return }
    if (account !== accountGeneration || selection !== selectionGeneration) return
    if (!result.ok) {
      if (isOrganizationUnavailable(result)) organizationStatus = 'unavailable'
      else organizationStatus = 'error'
      return
    }
    organization = result.data
    session = deps.openSession(result.data.member.id, () => ended(account), id, drafts.scope(), identity => {
      if (account !== accountGeneration || selection !== selectionGeneration) return
      if (identity) organization = identity
      else if (organization) organization = { ...organization, organization: { ...organization.organization,
        capabilities: Object.fromEntries(Object.keys(organization.organization.capabilities).map(key => [key, { allowed: false }])) as Identity['organization']['capabilities'] } }
    })
    organizationStatus = 'ready'
    members = deps.openMembers?.(id, () => ended(account), () => {
      if (account !== accountGeneration || selection !== selectionGeneration) return
      void session?.sync.markUnavailable()
    }) ?? null
    if (members) session.holdActivity?.('members', members.activityTarget)
    stopMemberAvailability = session.sync.onUnavailable(() => members?.unavailable())
    if (session.sync.unavailable) members?.unavailable()
    void members?.load()
    changes++
  }
  async function show(next: AuthState) {
    closeOrganization()
    security?.close(); security = null
    drafts.clear()
    accountGeneration++
    selectedOrganizationId = ''
    organizationStatus = 'loading'
    operations.clearError()
    view = next
    if (next.screen === 'app') {
      const account = accountGeneration
      security = accountSecurityAdapter((deps.openSecurity ?? createAccountSecurity)(() => ended(account)))
      const requested = typeof window !== 'undefined' ? parseNavigation(window.location.href)?.organizationId : null
      const id = requested ?? next.identity.organizations[0]?.organization_id
      if (id) await selectOrganization(id)
    }
  }

  const operations = createAuthOperations(deps, {
    generation: () => accountGeneration,
    selection: () => selectionGeneration,
    loading: () => { view = { screen: 'loading' } },
    show,
    ended,
    async accepted(identity) {
      if (view.screen !== 'app') return
      const organizations = view.identity.organizations.filter(o => o.organization_id !== identity.organization.organization_id)
      view = { ...view, identity: { ...view.identity, organizations: [...organizations, identity.organization] } }
      await selectOrganization(identity.organization.organization_id)
    },
  })
  const subscribe = createSubscriber(update => operations.subscribe(update))
  return {
    get view() { return view },
    get error() { subscribe(); return operations.get().error },
    get busy() { subscribe(); return operations.get().busy },
    get organization() { return organization },
    get members() { return members },
    get security() { return security },
    get selectedOrganizationId() { return selectedOrganizationId },
    get organizationStatus() { return session?.sync.unavailable ? 'unavailable' : organizationStatus },
    get session() { void changes; return session },
    selectOrganization,
    hasUnsavedChanges: () => drafts.hasDrafts() || (session?.sync.hasUnsavedChanges() ?? false),
    acceptInvitation: operations.acceptInvitation,
    signOutAndContinue: operations.signOutAndContinue,
    load: operations.load,
    submitSetup: operations.submitSetup,
    submitSignIn: operations.submitSignIn,
    signOut: operations.signOut,
  }
}
