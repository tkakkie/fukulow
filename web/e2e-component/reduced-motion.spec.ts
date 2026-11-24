import { expect, test } from '@playwright/test'

test('prefers-reduced-motion: reduce zeroes computed transition duration for panel and badge (#839)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/e2e-component/reduced-motion.html')

  const panel = page.locator('.ui-panel')
  const badge = page.locator('.ui-badge').first()

  await expect(panel).toBeVisible()
  await expect(badge).toBeVisible()

  await expect(panel).toHaveCSS('transition-duration', '0.2s')
  await expect(badge).toHaveCSS('transition-duration', '0.12s')

  await page.emulateMedia({ reducedMotion: 'reduce' })

  await expect(panel).toHaveCSS('transition-duration', '0s')
  await expect(badge).toHaveCSS('transition-duration', '0s')
})
