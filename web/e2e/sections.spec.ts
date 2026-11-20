import { expect, test, type Page } from '@playwright/test'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

async function cleanupSections(page: Page, orgId: string) {
  const res = await secretSafe(() => page.request.get(`/api/v1/orgs/${orgId}/me/sections`))
  if (!res.ok()) return
  const layout = (await secretSafe(() => res.json())) as { sections: Array<{ id: string }> }
  for (const section of layout.sections) {
    await secretSafe(() => page.request.delete(`/api/v1/orgs/${orgId}/me/sections/${section.id}`))
  }
}

test('sections lifecycle: create, rename, move in and back, reorder, collapse, delete with focus, and 320px fit', async ({ page }) => {
  const orgId = await signInOwner(page.request)
  await cleanupSections(page, orgId)
  const suffix = crypto.randomUUID().slice(0, 8)
  const chA = await createChannel(page.request, orgId, `sec-a-${suffix}`)
  const chB = await createChannel(page.request, orgId, `sec-b-${suffix}`)

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/o/${orgId}/c/${chA.id}`)
    const leftCol = page.locator('#channel-content')
    await expect(leftCol.getByRole('button', { name: 'セクションを作成', exact: true })).toBeVisible()
    await expect(leftCol.getByRole('button', { name: 'その他のチャンネル' })).toHaveAttribute('aria-expanded', 'true')

    // Create two sections.
    const name1 = `開発-${suffix}`
    const name2 = `運用-${suffix}`
    await leftCol.getByRole('button', { name: 'セクションを作成', exact: true }).click()
    await page.getByRole('dialog').getByLabel('セクション名', { exact: true }).fill(name1)
    await page.getByRole('dialog').getByRole('button', { name: '作成する', exact: true }).click()
    await expect(leftCol.locator('section', { hasText: name1 })).toBeVisible()

    await leftCol.getByRole('button', { name: 'セクションを作成', exact: true }).click()
    await page.getByRole('dialog').getByLabel('セクション名', { exact: true }).fill(name2)
    await page.getByRole('dialog').getByRole('button', { name: '作成する', exact: true }).click()
    await expect(leftCol.locator('section', { hasText: name2 })).toBeVisible()

    // Rename first section.
    const renamed1 = `設計-${suffix}`
    const sec1 = leftCol.locator(`section[aria-label="${name1}"]`)
    await sec1.getByRole('button', { name: '名前を変更', exact: true }).click()
    await page.getByRole('dialog').getByLabel('セクション名', { exact: true }).fill(renamed1)
    await page.getByRole('dialog').getByRole('button', { name: '変更する', exact: true }).click()
    const renamedSec1 = leftCol.locator(`section[aria-label="${renamed1}"]`)
    await expect(renamedSec1).toBeVisible()

    // Move chA and chB into renamedSec1.
    for (const ch of [chA, chB]) {
      await leftCol.locator(`[data-channel-id="${ch.id}"]`).getByRole('button', { name: 'チャンネルを移動', exact: true }).click()
      await page.getByRole('dialog').getByLabel(renamed1, { exact: true }).check()
      await page.getByRole('dialog').getByRole('button', { name: '移動する', exact: true }).click()
      await expect(renamedSec1.locator(`[data-channel-id="${ch.id}"]`)).toBeVisible()
      await expect(renamedSec1.locator(`[data-channel-id="${ch.id}"] .ui-list-row`)).toBeFocused()
    }

    // Reorder chB up above chA within renamedSec1; focus stays on chB.
    await renamedSec1.getByTestId(`channel-move-up-${chB.id}`).click()
    await expect(renamedSec1.locator('[data-channel-id]').first()).toHaveAttribute('data-channel-id', chB.id)
    await expect(renamedSec1.locator(`[data-channel-id="${chB.id}"] .ui-list-row`)).toBeFocused()

    // Move chB back to その他のチャンネル.
    await renamedSec1.locator(`[data-channel-id="${chB.id}"]`).getByRole('button', { name: 'チャンネルを移動', exact: true }).click()
    await page.getByRole('dialog').getByLabel('その他のチャンネル', { exact: true }).check()
    await page.getByRole('dialog').getByRole('button', { name: '移動する', exact: true }).click()
    const otherSec = leftCol.locator('section[aria-label="その他のチャンネル"]')
    await expect(otherSec.locator(`[data-channel-id="${chB.id}"]`)).toBeVisible()
    await expect(otherSec.locator(`[data-channel-id="${chB.id}"] .ui-list-row`)).toBeFocused()

    // Collapse and expand renamedSec1 (in-memory only).
    const heading1 = renamedSec1.locator('[data-section-heading]')
    await heading1.click()
    await expect(heading1).toHaveAttribute('aria-expanded', 'false')
    await expect(renamedSec1.locator(`[data-channel-id="${chA.id}"]`)).toHaveCount(0)
    await heading1.click()
    await expect(heading1).toHaveAttribute('aria-expanded', 'true')
    await expect(renamedSec1.locator(`[data-channel-id="${chA.id}"]`)).toBeVisible()

    // Reorder section 2 up above renamedSec1; focus stays on section 2.
    const sec2 = leftCol.locator(`section[aria-label="${name2}"]`)
    await sec2.getByRole('button', { name: '上へ移動', exact: true }).click()
    await expect(leftCol.locator('section.section-group').first()).toHaveAttribute('aria-label', name2)
    await expect(sec2.locator('[data-section-heading]')).toBeFocused()

    // Delete section 2 (first section) -> focus moves to next section heading (renamed1).
    await sec2.getByRole('button', { name: 'セクションを削除', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click()
    await expect(sec2).toHaveCount(0)
    await expect(renamedSec1.locator('[data-section-heading]')).toBeFocused()

    // Delete renamed1 (last custom section) -> focus moves to その他のチャンネル heading.
    await renamedSec1.getByRole('button', { name: 'セクションを削除', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click()
    await expect(renamedSec1).toHaveCount(0)
    await expect(otherSec.locator('[data-section-heading]')).toBeFocused()

    // Responsive 320px fit without horizontal overflow.
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await cleanupSections(page, orgId)
  }
})

test('keyboard-only flow: create, collapse, rename, cancel Escape, and delete', async ({ page }) => {
  const orgId = await signInOwner(page.request)
  await cleanupSections(page, orgId)
  const suffix = crypto.randomUUID().slice(0, 8)
  const ch = await createChannel(page.request, orgId, `sec-kb-${suffix}`)

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/o/${orgId}/c/${ch.id}`)
    const leftCol = page.locator('#channel-content')

    // Create section via keyboard Enter.
    const secName = `キーボード-${suffix}`
    const createBtn = leftCol.getByRole('button', { name: 'セクションを作成', exact: true })
    await createBtn.focus()
    await page.keyboard.press('Enter')
    const nameInput = page.getByRole('dialog').getByLabel('セクション名', { exact: true })
    await expect(nameInput).toBeFocused()
    await page.keyboard.type(secName)
    await page.keyboard.press('Enter')
    const sec = leftCol.locator(`section[aria-label="${secName}"]`)
    await expect(sec).toBeVisible()

    // Collapse & expand heading via keyboard Space.
    const heading = sec.locator('[data-section-heading]')
    await heading.focus()
    await page.keyboard.press('Space')
    await expect(heading).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Space')
    await expect(heading).toHaveAttribute('aria-expanded', 'true')

    // Open Rename dialog and cancel with Escape -> focus returns to rename button.
    const renameBtn = sec.getByRole('button', { name: '名前を変更', exact: true })
    await renameBtn.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(renameBtn).toBeFocused()

    // Delete via keyboard.
    const deleteBtn = sec.getByRole('button', { name: 'セクションを削除', exact: true })
    await deleteBtn.focus()
    await page.keyboard.press('Enter')
    const confirmDelete = page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true })
    await confirmDelete.focus()
    await page.keyboard.press('Enter')
    await expect(sec).toHaveCount(0)
    await expect(leftCol.locator('section[aria-label="その他のチャンネル"] [data-section-heading]')).toBeFocused()
  } finally {
    await cleanupSections(page, orgId)
  }
})

test('two-tab convergence without reload', async ({ page, context }) => {
  const orgId = await signInOwner(page.request)
  await cleanupSections(page, orgId)
  const suffix = crypto.randomUUID().slice(0, 8)
  const ch = await createChannel(page.request, orgId, `sec-sync-${suffix}`)
  const tab2 = await context.newPage()

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await tab2.setViewportSize({ width: 1280, height: 800 })
    await Promise.all([
      page.goto(`/o/${orgId}/c/${ch.id}`),
      tab2.goto(`/o/${orgId}/c/${ch.id}`),
    ])
    await expect(page.locator('#channel-content').getByRole('button', { name: 'セクションを作成', exact: true })).toBeVisible()
    await expect(tab2.locator('#channel-content').getByRole('button', { name: 'セクションを作成', exact: true })).toBeVisible()

    // Create section in tab 1 -> tab 2 converges without reload.
    const secName = `同期-${suffix}`
    await page.locator('#channel-content').getByRole('button', { name: 'セクションを作成', exact: true }).click()
    await page.getByRole('dialog').getByLabel('セクション名', { exact: true }).fill(secName)
    await page.getByRole('dialog').getByRole('button', { name: '作成する', exact: true }).click()
    await expect(tab2.locator(`#channel-content section[aria-label="${secName}"]`)).toBeVisible()

    // Move channel in tab 1 -> tab 2 converges without reload.
    await page.locator(`#channel-content [data-channel-id="${ch.id}"]`).getByRole('button', { name: 'チャンネルを移動', exact: true }).click()
    await page.getByRole('dialog').getByLabel(secName, { exact: true }).check()
    await page.getByRole('dialog').getByRole('button', { name: '移動する', exact: true }).click()
    await expect(tab2.locator(`#channel-content section[aria-label="${secName}"] [data-channel-id="${ch.id}"]`)).toBeVisible()

    // Delete section in tab 1 -> tab 2 converges without reload.
    await page.locator(`#channel-content section[aria-label="${secName}"]`).getByRole('button', { name: 'セクションを削除', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click()
    await expect(tab2.locator(`#channel-content section[aria-label="${secName}"]`)).toHaveCount(0)
    await expect(tab2.locator(`#channel-content section[aria-label="その他のチャンネル"] [data-channel-id="${ch.id}"]`)).toBeVisible()
  } finally {
    await tab2.close()
    await cleanupSections(page, orgId)
  }
})
