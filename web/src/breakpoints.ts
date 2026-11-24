export type ViewportClass = 'phone' | 'tablet' | 'desktop'

/**
 * Responsive breakpoint media queries matching CSS `@media` rules and `docs/ui.md` §3:
 * - `phone`: `< 600px` (`(width < 600px)`)
 * - `tablet`: `600px - 959px` (`(600px <= width < 960px)`)
 * - `desktop`: `>= 960px` (`(width >= 960px)`)
 * - `desktopOverlay`: `960px - 1279px` (`(960px <= width < 1280px)`)
 */
export const BREAKPOINT_QUERIES = {
  phone: '(width < 600px)',
  tablet: '(600px <= width < 960px)',
  desktop: '(width >= 960px)',
  desktopOverlay: '(960px <= width < 1280px)',
} as const satisfies Record<ViewportClass | 'desktopOverlay', string>

export function resolveViewportClass(matches: {
  phone: boolean
  tablet: boolean
  desktop?: boolean
}): ViewportClass {
  if (matches.phone) return 'phone'
  if (matches.tablet) return 'tablet'
  return 'desktop'
}
