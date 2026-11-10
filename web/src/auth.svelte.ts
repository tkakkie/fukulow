import { errorMessage, restore, setupAndSignIn, signIn, signOut, type AuthState } from './auth'
import { getOrganizationMe, isOrganizationUnavailable, type Identity } from './api'
import { channelsAdapter, type ChannelsAdapter } from './channels.svelte'
import { createSession } from './session'
import { syncAdapter, type SyncAdapter } from './sync.svelte'

export type { AuthState } from './auth'
export type SessionModel = { channels: ChannelsAdapter; sync: SyncAdapter; close(): void }
export type AuthDeps = {
  restore: typeof restore
  signIn: typeof signIn
  setupAndSignIn: typeof setupAndSignIn
  signOut: typeof signOut
  getOrganization: typeof getOrganizationMe
  openSession(selfId: string, onEnded: () => void, organizationId: string): SessionModel
}
const defaults: AuthDeps = {
  restore, signIn, setupAndSignIn, signOut, getOrganization: getOrganizationMe,
  openSession(selfId, onEnded, organizationId) {
    const session = createSession({ selfId, onEnded, organizationId })
    return { channels: channelsAdapter(session.channels), sync: syncAdapter(session.sync), close: session.close }
  },
}
const sessionEndedNotice = 'セッションが終了しました。もう一度ログインしてください。'

/** Account lifetime owns the 401 fence; each Organization selection owns a separate data generation. */
export function createAuth(deps: AuthDeps = defaults) {
  let view = $state<AuthState>({ screen: 'loading' })
  let error = $state('')
  let busy = $state(false)
  let organization = $state<Identity | null>(null)
  let selectedOrganizationId = $state('')
  let organizationStatus = $state<'loading' | 'ready' | 'unavailable' | 'error'>('loading')
  let session: SessionModel | null = null
  let changes = $state(0)
  let accountGeneration = 0
  let selectionGeneration = 0
  const unavailable = new Set<string>()

  function closeOrganization() {
    if (session?.sync.unavailable) unavailable.add(selectedOrganizationId)
    session?.close(); session = null
    organization = null
    selectionGeneration++
    changes++
  }
  function ended(generation: number) {
    if (generation === accountGeneration) void show({ screen: 'signin', notice: sessionEndedNotice })
  }
  async function selectOrganization(id: string) {
    if (view.screen !== 'app') return
    closeOrganization()
    selectedOrganizationId = id
    organizationStatus = 'loading'
    if (unavailable.has(id)) { organizationStatus = 'unavailable'; return }
    const account = accountGeneration, selection = selectionGeneration
    const result = await deps.getOrganization(id)
    // Account Session rejection remains authoritative even when this selection was replaced.
    if (!result.ok && result.kind === 'http' && result.status === 401) { ended(account); return }
    if (account !== accountGeneration || selection !== selectionGeneration) return
    if (!result.ok) {
      if (isOrganizationUnavailable(result)) { unavailable.add(id); organizationStatus = 'unavailable' }
      else organizationStatus = 'error'
      return
    }
    organization = result.data
    session = deps.openSession(result.data.member.id, () => ended(account), id)
    organizationStatus = 'ready'
    changes++
  }
  async function show(next: AuthState) {
    closeOrganization()
    accountGeneration++
    unavailable.clear()
    selectedOrganizationId = ''
    error = ''
    view = next
    if (next.screen === 'app' && next.identity.organizations[0]) {
      await selectOrganization(next.identity.organizations[0].organization_id)
    }
  }

  return {
    get view() { return view }, get error() { return error }, get busy() { return busy },
    get organization() { return organization },
    get selectedOrganizationId() { return selectedOrganizationId },
    get organizationStatus() { return session?.sync.unavailable ? 'unavailable' : organizationStatus },
    get session() { void changes; return session },
    selectOrganization,
    async load() { view = { screen: 'loading' }; await show(await deps.restore()) },
    async submitSetup(req: Parameters<typeof setupAndSignIn>[0]): Promise<boolean> {
      busy = true; error = ''
      const result = await deps.setupAndSignIn(req)
      busy = false
      if ('error' in result) { error = result.error; return false }
      await show(result.state)
      return true
    },
    async submitSignIn(email: string, password: string): Promise<boolean> {
      busy = true; error = ''
      const result = await deps.signIn(email, password)
      busy = false
      if (!result.ok) { error = errorMessage(result, 'signin'); return false }
      await show({ screen: 'app', identity: result.data.identity })
      return true
    },
    async signOut(): Promise<boolean> {
      busy = true
      const ok = await deps.signOut()
      busy = false
      if (!ok) { error = errorMessage({ ok: false, kind: 'network' }, 'signin'); return false }
      await show({ screen: 'signin' })
      return true
    },
  }
}
