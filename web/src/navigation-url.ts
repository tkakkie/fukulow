export type PanelTab = 'topics' | 'overview' | 'members'
export type PanelTarget = PanelTab | `reply:${string}`
export type NavigationTarget = {
  organizationId: string
  channelId: string | null
  topicId: string | null
  panel: PanelTarget | null
}

/** URLs are hints only; identifiers are never evidence of API access. */
export function parseNavigation(url: string): NavigationTarget | null {
  try {
    const { pathname, searchParams } = new URL(url, 'https://navigation.invalid')
    const match = /^\/o\/([^/]+)(?:\/c\/([^/]+)(?:\/t\/([^/]+))?)?\/?$/.exec(pathname)
    if (!match) return null
    const ids = match.slice(1).map(id => id ? decodeURIComponent(id) : null)
    if (ids.some(id => id !== null && (!id || /[/\u0000-\u001f]/.test(id)))) return null
    const panel = searchParams.get('panel')
    const validPanel = panel === 'topics' || panel === 'overview' || panel === 'members' || /^reply:[^/\s]+$/.test(panel ?? '')
    return { organizationId: ids[0]!, channelId: ids[1] ?? null, topicId: ids[2] ?? null,
      panel: ids[1] && validPanel ? panel as PanelTarget : null }
  } catch { return null }
}

export function serializeNavigation(target: NavigationTarget): string {
  let path = `/o/${encodeURIComponent(target.organizationId)}`
  if (!target.channelId) return path
  path += `/c/${encodeURIComponent(target.channelId)}`
  if (target.topicId) path += `/t/${encodeURIComponent(target.topicId)}`
  if (target.panel) path += `?panel=${target.panel.startsWith('reply:') ? `reply:${encodeURIComponent(target.panel.slice(6))}` : target.panel}`
  return path
}
