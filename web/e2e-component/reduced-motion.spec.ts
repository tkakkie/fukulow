import { expect, test } from '@playwright/test'

test('prefers-reduced-motion: reduce zeroes computed transition duration for panel and badge (#839)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/e2e-component/reduced-motion.html')

  const panelSlot = page.locator('.right-panel-slot')
  const badge = page.locator('.ui-badge').first()

  await expect(panelSlot).toBeVisible()
  await expect(badge).toBeVisible()

  await expect(panelSlot).toHaveCSS('transition-duration', '0.2s')
  await expect(badge).toHaveCSS('transition-duration', '0.12s')

  await page.emulateMedia({ reducedMotion: 'reduce' })

  await expect(panelSlot).toHaveCSS('transition-duration', '0s')
  await expect(badge).toHaveCSS('transition-duration', '0s')
})
