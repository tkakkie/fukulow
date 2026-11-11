// TEMPORARY (PR #254 verification, reverted next commit): fail on purpose with real secrets in play.
import { expect, test } from '@playwright/test'
import { secretSafe, signInOwner } from './helpers.ts'
test('diagnostics self-test fails on purpose', async ({ page }) => {
  const org = await signInOwner(page.request)
  const invite = await secretSafe(() => page.request.post(`/api/v1/orgs/${org}/invites`, { data: { email: `diag-${crypto.randomUUID()}@example.invalid`, role: 'guest' } }))
  expect(invite.ok()).toBe(true)
  await page.goto('/')
  await page.getByRole('textbox', { name: 'メッセージ' }).fill('DIAG-SENTINEL-BODY')
  expect(invite.status()).toBe(299)
})
test('diagnostics self-test locator timeout', async ({ page }) => {
  await signInOwner(page.request)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'does-not-exist' })).toBeVisible({ timeout: 2000 })
})
