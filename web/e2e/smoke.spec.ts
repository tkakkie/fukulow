import { expect, test } from '@playwright/test'
import { secretSafe } from './helpers.ts'

test('built app is served by the server', async ({ page, request }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('fukulow')

  const health = await secretSafe(() => request.get('/api/v1/health'))
  expect(health.ok()).toBe(true)
})
