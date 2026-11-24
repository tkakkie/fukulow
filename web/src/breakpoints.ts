export type ViewportClass = 'phone' | 'tablet' | 'desktop'

/**
 * Responsive breakpoint media queries matching CSS `@media` rules and `docs/ui.md` §3:
 * - `phone`: `< 600px` (`(max-width: 599px)`)
 * - `tablet`: `600px - 959px` (`(min-width: 600px) and (max-width: 959px)`)
 * - `desktop`: `>= 960px` (`(min-width: 960px)`)
 */
export const BREAKPOINT_QUERIES = {
  phone: '(max-width: 599px)',
  tablet: '(min-width: 600px) and (max-width: 959px)',
  desktop: '(min-width: 960px)',
} as const satisfies Record<ViewportClass, string>

export function resolveViewportClass(matches: {
  phone: boolean
  tablet: boolean
  desktop?: boolean
}): ViewportClass {
  if (matches.phone) return 'phone'
  if (matches.tablet) return 'tablet'
  return 'desktop'
}
