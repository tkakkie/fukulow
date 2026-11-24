// Test page for e2e-component/reduced-motion.spec.ts (#839): mounts the real Workspace (with open right panel
// `.right-panel-slot` and an unread `Badge` `.ui-badge`) and real `app.css` using static fakes (no server or wasm).
import { mount } from 'svelte'
import '../src/app.css'
import type { Channel } from '../src/api'
import type { SessionModel } from '../src/auth.svelte'
import type { ChannelsAdapter } from '../src/channels.svelte'
import { createNavigation, type NavigationBrowser } from '../src/navigation'
import type { RepliesAdapter } from '../src/replies.svelte'
import type { ChannelSync, SyncAdapter } from '../src/sync.svelte'
import type { TopicsAdapter } from '../src/topics.svelte'
import type { UnreadAdapter } from '../src/unread.svelte'
import Workspace from '../src/Workspace.svelte'

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000002'

const channel: Channel = {
  id: CHANNEL_ID,
  kind: 'channel',
  name: 'general',
  visibility: 'public',
  archived: false,
  capabilities: {
    can_add_members: { allowed: false },
    can_remove_members: { allowed: false },
    can_manage_managers: { allowed: false },
    can_leave: { allowed: false },
    can_rename: { allowed: false },
    can_archive: { allowed: false },
  },
}

const channels: ChannelsAdapter = {
  state: {
    status: 'ready',
    channels: [channel],
    selectedId: CHANNEL_ID,
    openChannelPending: false,
  },
  load: async () => {},
  select: () => {},
  selectHint: () => {},
  creationAccess: 'denied',
  create: async () => false as const,
  holdArchived: () => () => {},
  retryArchived: async () => {},
  isArchived: () => false,
  rename: async () => null,
  archive: async () => null,
  restore: async () => null,
}

const channelSync = {
  timeline: { status: 'ready' as const, messages: [], pending: [], hasOlder: false, loadingOlder: false, olderError: false },
  composer: { draft: '', topicDraft: '', composerError: null },
  loadLatest: async () => {},
  loadOlder: async () => {},
  setDraft: () => {},
  setTopicDraft: () => {},
  submit: async () => false,
  retry: async () => {},
  restore: () => false,
  discard: () => {},
  topic: () => ({ composer: { draft: '', composerError: null }, setDraft: () => {}, submit: async () => false, restore: () => false }),
  reply: () => ({ composer: { draft: '', composerError: null }, setDraft: () => {}, submit: async () => false, restore: () => false }),
} as unknown as ChannelSync

const sync: SyncAdapter = {
  unavailable: false,
  markUnavailable: async () => {},
  onUnavailable: () => () => {},
  hasUnsavedChanges: () => false,
  channel: () => channelSync,
}

const topics = {
  state: {
    main: { asOfSeq: 0, hasMore: false, hasNewer: false, following: true, newerCount: 0, loading: false, error: false },
    mainItems: [],
    list: { asOfSeq: 0, hasMore: false, hasNewer: false, following: true, newerCount: 0, loading: false, error: false },
    topics: [],
    unavailable: false,
    views: {},
  },
  loadMain: async () => {},
  loadList: async () => {},
  ensureSummary: async () => {},
  retrySummary: async () => {},
  loadView: async () => {},
  loadOlderView: async () => {},
  resetView: () => {},
} as unknown as TopicsAdapter

const replies = {
  counts: {},
  state: {
    anchor: null,
    messages: [],
    pending: [],
    hasMore: false,
    hasOlder: false,
    hasNewer: false,
    following: true,
    newerCount: 0,
    loading: false,
    error: false,
    notFound: false,
    unavailable: false,
  },
  open: async () => {},
  loadMore: async () => {},
  loadOlder: async () => {},
  loadLatest: async () => {},
  setPinned: () => {},
  dismiss: () => {},
  send: async () => false,
  retry: async () => {},
  move: async () => ({ kind: 'baseline_unavailable' as const }),
} as unknown as RepliesAdapter

const unread: UnreadAdapter = {
  state: {
    generation: Symbol('gen'),
    asOfSeq: 3,
    unreadCount: 3,
    mentionUnreadCount: 0,
    main: { position: 0, unreadCount: 3, mentionUnreadCount: 0, stopped: false, error: false },
    topics: {},
    stopped: false,
    error: false,
    entry: null,
  },
  enter: async () => undefined,
  leave: () => {},
  visibility: () => {},
  presented: () => {},
  refresh: async () => {},
}

const session: SessionModel = {
  channels,
  sync,
  topics: () => topics,
  replies: () => replies,
  unread: () => unread,
  close: () => {},
}

let href = `/o/${ORG_ID}/c/${CHANNEL_ID}?panel=topics`
let historyState: unknown = null
const browser: NavigationBrowser = {
  location: { get href() { return href } } as Location,
  history: {
    get state() { return historyState },
    pushState(s: unknown, _: string, url?: string | URL | null) { historyState = s; href = String(url) },
    replaceState(s: unknown, _: string, url?: string | URL | null) { historyState = s; href = String(url) },
  } as History,
  addEventListener: () => {},
  removeEventListener: () => {},
}

const navigation = createNavigation(browser)

mount(Workspace, {
  target: document.getElementById('app')!,
  props: {
    navigation,
    session,
    selectedOrganizationId: ORG_ID,
  },
})
