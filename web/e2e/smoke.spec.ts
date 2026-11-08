import { expect, test } from '@playwright/test'

test('built app is served by the server', async ({ page, request }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('fukulow')

  const health = await request.get('/api/v1/health')
  expect(health.ok()).toBe(true)
})
