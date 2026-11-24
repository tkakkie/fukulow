import { createActivityTarget, type Activity, type ActivityTarget, type Invalidation } from './activity'
import * as api from './api'
import type { createChannels } from './channels'
import { createRequestDeadlines } from './request-deadlines'
import { sectionGeneration } from './section-generation'

export type SectionsApi = {
  layout(signal: AbortSignal): Promise<api.Result<api.SectionLayout>>
  placement(channel: string, signal: AbortSignal): Promise<api.Result<api.ChannelPlacement>>
  create(body: api.CreateSection, signal: AbortSignal): Promise<api.Result<api.CreatedSection>>
  rename(id: string, body: api.RenameSection, signal: AbortSignal): Promise<api.Result<undefined>>
  reorder(body: api.SectionOrder, signal: AbortSignal): Promise<api.Result<undefined>>
  moveChannel(channel: string, body: api.MoveChannel, signal: AbortSignal): Promise<api.Result<undefined>>
  reorderChannels(body: api.ChannelOrder, signal: AbortSignal): Promise<api.Result<undefined>>
  delete(id: string, signal: AbortSignal): Promise<api.Result<undefined>>
}

export const sectionsApi = (org: string): SectionsApi => ({
  layout: signal => api.getSectionLayout(org, undefined, signal),
  placement: (channel, signal) => api.getChannelPlacement(org, channel, undefined, signal),
  create: (body, signal) => api.createSection(org, body, undefined, signal),
  rename: (id, body, signal) => api.renameSection(org, id, body, undefined, signal),
  reorder: (body, signal) => api.reorderSections(org, body, undefined, signal),
  moveChannel: (channel, body, signal) => api.moveChannel(org, channel, body, undefined, signal),
  reorderChannels: (body, signal) => api.reorderSectionChannels(org, body, undefined, signal),
  delete: (id, signal) => api.deleteSection(org, id, undefined, signal),
})

export type SectionGroup =
  | { id: string; name: string; channels: readonly api.Channel[] }
  | { id: null; channels: readonly api.Channel[] }
type Failure = Extract<api.Result<never>, { ok: false }>
type LocalRefusal = { ok: false; kind: 'busy' | 'inactive' | 'reconciling' }
export type SectionResult<T> = api.Result<T> | LocalRefusal
export type SectionsState = {
  groups: readonly SectionGroup[]
  generation?: string
  layoutRevision: number
  error?: Failure
  writing: boolean
  reconnecting: boolean
}

const inactive = { ok: false, kind: 'inactive' } as const
const network = { ok: false, kind: 'network' } as const
const empty = (): SectionsState => ({ groups: [{ id: null, channels: [] }], layoutRevision: 0, writing: false, reconnecting: false })

export function createSections(options: {
  api: SectionsApi
  activity: Activity
  list: ReturnType<typeof createChannels>['authorizedList']
  observeAccess(result: api.Result<unknown>): void
  random?: () => number
  timeoutMs?: number
}) {
  let state = empty()
  let layout: api.SectionLayout | undefined
  let accepted = -1n, observed = -1n, access = 0
  let layoutCurrent = false, waitingForReady = false, socketReady = false, closed = false
  let recovery: 'write' | 'sections' | 'channels' | undefined
  let mutationVersion = 0
  let release: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  let listRows = options.list.get().channels
  let layoutIds = new Set<string>()
  let visible = new Set<string>()
  const listeners = new Set<() => void>()
  const deadlines = createRequestDeadlines()
  const requests = new Set<AbortController>()
  const notify = () => listeners.forEach(listener => listener())
  const observe = async <T>(request: Promise<api.Result<T>>) => {
    const result = await request
    options.observeAccess(result)
    return result
  }

  function render() {
    if (!layout || closed) return
    const list = options.list.get()
    const current = layoutCurrent && list.current
    if (current && recovery === 'channels') recovery = undefined
    const rows = new Map(list.channels.map(row => [row.id, row]))
    const next = new Set<string>()
    function intersect(ids: string[]) {
      const channels: api.Channel[] = []
      for (const id of ids) {
        const row = rows.get(id)
        if (!row || row.archived || next.has(id) || (!current && !visible.has(id))) continue
        next.add(id)
        channels.push(row)
      }
      return channels
    }
    const groups: SectionGroup[] = layout.sections.map(section => ({
      id: section.id, name: section.name, channels: intersect(section.channel_ids),
    }))
    groups.push({ id: null, channels: intersect(layout.other_channel_ids) })
    visible = next
    state = { ...state, groups, generation: layout.generation }
    notify()
  }

  function accept(value: api.SectionLayout) {
    const ids = new Set(value.other_channel_ids)
    for (const section of value.sections) {
      for (const id of section.channel_ids) ids.add(id)
    }
    const omitted = [...layoutIds].some(id => !ids.has(id))
    layoutIds = ids
    accepted = BigInt(value.generation)
    layout = value
    layoutCurrent = true
    if (recovery !== 'channels') recovery = undefined
    state = { ...state, error: undefined, layoutRevision: state.layoutRevision + 1 }
    // A later reappearance needs Channel-list authority from after the omission.
    if (omitted) {
      access++
      options.list.invalidate()
    }
    render()
  }

  const target = createActivityTarget({
    canLoad: () => !waitingForReady,
    load: signal => observe(options.api.layout(signal)),
    covers(value) {
      const version = sectionGeneration(value?.generation)
      return version !== undefined && version >= accepted && version >= observed
    },
    accept,
    error: error => { layoutCurrent = false; state = { ...state, error }; notify() },
    terminal: result => !result.ok && result.kind === 'http' && (result.status === 401 || api.isOrganizationUnavailable(result)),
    random: options.random,
    timeoutMs: options.timeoutMs,
  })

  function invalidate(reason: Invalidation = 'notice', delay?: number) {
    if (reason !== 'notice') { access++; layoutCurrent = false }
    target.invalidate(reason, delay)
  }

  function listChanged() {
    const list = options.list.get()
    const previous = listRows
    listRows = list.channels
    if (!list.current && previous === listRows) return
    if (list.current && previous !== listRows) {
      const ids = new Set(listRows.map(row => row.id))
      if (previous.some(row => !ids.has(row.id))) invalidate('access')
    }
    render()
  }

  const activityTarget: ActivityTarget = {
    invalidate,
    notice(event) {
      if (event.type !== 'sections_changed' || !socketReady) return
      const version = sectionGeneration(event.generation)
      if (version === undefined || version <= observed || version <= accepted) return
      observed = version
      target.demandCoverage()
    },
    close,
  }

  function hideChannel(id: string) {
    if (!layout || !layoutIds.delete(id)) return
    layout = {
      ...layout,
      sections: layout.sections.map(section => ({ ...section, channel_ids: section.channel_ids.filter(channel => channel !== id) })),
      other_channel_ids: layout.other_channel_ids.filter(channel => channel !== id),
    }
    render()
  }

  function placementRefusal(channel: string, result: Extract<Failure, { kind: 'http' }>) {
    if (result.status === 404 && result.error === 'channel not found') {
      hideChannel(channel)
      invalidate('access')
      options.list.invalidate()
    } else if (result.status === 409 && result.error === 'channel_archived') {
      hideChannel(channel)
      options.activity.notice({ type: 'channel_list_changed' })
    }
  }

  function fenceMutation() {
    mutationVersion++
    target.fence()
  }

  async function requestWithDeadline<T>(request: (signal: AbortSignal) => Promise<api.Result<T>>): Promise<api.Result<T> | typeof inactive> {
    if (closed) return inactive
    const controller = new AbortController()
    requests.add(controller)
    const deadline = deadlines.start<api.Result<T> | typeof inactive>(inactive, {
      timeoutMs: options.timeoutMs ?? 10_000,
      onTimeout() { controller.abort(); return network },
    })
    try { return await Promise.race([observe(request(controller.signal)), deadline.until]) }
    catch { return network }
    finally { deadline.clear(); requests.delete(controller) }
  }

  async function mutate<T>(request: (signal: AbortSignal) => Promise<api.Result<T>>, channel?: string, order?: 'sections' | 'channels'): Promise<SectionResult<T>> {
    if (closed || !release) return inactive
    if (state.writing) return { ok: false, kind: 'busy' }
    if (recovery === 'write' || (order && recovery)) return { ok: false, kind: 'reconciling' }
    const own = access
    fenceMutation()
    state = { ...state, writing: true }
    notify()
    const result = await requestWithDeadline(request)
    if (closed) return inactive
    state = { ...state, writing: false }
    fenceMutation()
    if (result.ok) target.invalidate()
    else if (result.kind === 'network' && result.error !== 'lock_contention') {
      recovery = 'write'
      target.invalidate()
    } else if (result.kind === 'http') {
      if (channel !== undefined && own === access) placementRefusal(channel, result)
      if (order && result.status === 409 && result.error === 'section_layout_changed') {
        recovery = order
        if (order === 'channels') options.activity.notice({ type: 'channel_list_changed' })
        else target.invalidate()
      } else if (order === 'channels' && (result.error === 'channel_archived' || result.error === 'channel not found')) {
        options.activity.notice({ type: 'channel_list_changed' })
      }
    }
    notify()
    return result
  }

  function close() {
    if (closed) return
    closed = true
    deadlines.cancel()
    for (const request of requests) request.abort()
    target.close()
    release?.()
    unsubscribe?.()
    layout = undefined
    layoutIds.clear()
    visible.clear()
    state = empty()
    notify()
    listeners.clear()
  }

  return {
    /** Retain for the Organization lifetime, including when the left column is hidden. */
    hold() {
      if (closed || release) return
      listRows = options.list.get().channels
      unsubscribe = options.list.subscribe(listChanged)
      release = options.activity.hold('sections', activityTarget)
      if (waitingForReady) options.list.disconnected()
      void target.refresh()
    },
    ready() {
      if (closed || socketReady) return
      socketReady = true
      waitingForReady = false
      options.list.ready()
      // Reset on a fresh socket. A same-socket reset keeps the monotonic version floors.
      accepted = -1n
      observed = -1n
      if (state.reconnecting) {
        state = { ...state, reconnecting: false }
        notify()
      }
    },
    disconnected() {
      if (closed || waitingForReady) return
      socketReady = false
      waitingForReady = true
      access++
      layoutCurrent = false
      target.suspend()
      if (release) options.list.disconnected()
      state = { ...state, reconnecting: true }
      notify()
    },
    hideChannel,
    close,
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    retry() { if (release && !closed && !waitingForReady) target.invalidate() },
    async placement(channel: string): Promise<SectionResult<api.ChannelPlacement>> {
      if (closed || !release || waitingForReady) return inactive
      const own = access
      const mutation = mutationVersion
      const result = await requestWithDeadline(signal => options.api.placement(channel, signal))
      if (closed || own !== access || mutation !== mutationVersion) return inactive
      if (!result.ok && result.kind === 'http') placementRefusal(channel, result)
      return result
    },
    create: (body: api.CreateSection) => mutate(signal => options.api.create(body, signal)),
    rename: (id: string, body: api.RenameSection) => mutate(signal => options.api.rename(id, body, signal)),
    reorder: (body: api.SectionOrder) => mutate(signal => options.api.reorder(body, signal), undefined, 'sections'),
    moveChannel: (channel: string, body: api.MoveChannel) => mutate(signal => options.api.moveChannel(channel, body, signal), channel),
    reorderChannels: (body: api.ChannelOrder) => mutate(signal => options.api.reorderChannels(body, signal), undefined, 'channels'),
    delete: (id: string) => mutate(signal => options.api.delete(id, signal)),
  }
}
export type Sections = ReturnType<typeof createSections>
