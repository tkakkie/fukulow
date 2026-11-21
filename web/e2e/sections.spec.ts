import { expect, test, type Page } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

type CreateSection = components['schemas']['CreateSection']
type CreatedSection = components['schemas']['CreatedSection']
type SectionLayout = components['schemas']['SectionLayout']

async function cleanupCreatedSections(page: Page, orgId: string, createdIds: ReadonlySet<string>) {
  for (const id of createdIds) {
    const res = await secretSafe(() => page.request.delete(`/api/v1/orgs/${orgId}/me/sections/${id}`))
    expect(res.status()).toBe(204)
  }
}

async function createSectionViaApi(
  page: Page,
  orgId: string,
  name: string,
  createdIds: Set<string>,
): Promise<string> {
  const body: CreateSection = { id: crypto.randomUUID(), name }
  createdIds.add(body.id)
  const res = await secretSafe(() => page.request.post(`/api/v1/orgs/${orgId}/me/sections`, { data: body }))
  expect(res.ok()).toBe(true)
  const created = (await secretSafe(() => res.json())) as CreatedSection
  return created.id
}

async function captureCreatedSectionId(
  page: Page,
  orgId: string,
  createdIds: Set<string>,
  submit: () => Promise<void>,
): Promise<string> {
  const layoutPath = `/api/v1/orgs/${orgId}/me/sections`
  const reqPromise = page.waitForRequest(
    req => req.method() === 'POST' && new URL(req.url()).pathname === layoutPath,
  )
  const resPromise = page.waitForResponse(
    res => res.request().method() === 'POST' && new URL(res.url()).pathname === layoutPath,
  )
  await submit()
  const req = await reqPromise
  const body = req.postDataJSON() as Partial<CreateSection> | null
  expect(body?.id).toBeTruthy()
  createdIds.add(body!.id!)
  const res = await resPromise
  expect(res.ok()).toBe(true)
  return body!.id!
}

function trackLayoutReads(page: Page, layoutPath: string) {
  const state = { completed: 0, inFlight: 0 }
  const isLayoutGet = (url: string, method: string) =>
    method === 'GET' && new URL(url).pathname === layoutPath
  page.on('request', (req) => {
    if (isLayoutGet(req.url(), req.method())) state.inFlight++
  })
  page.on('requestfinished', async (req) => {
    if (!isLayoutGet(req.url(), req.method())) return
    state.inFlight = Math.max(0, state.inFlight - 1)
    const res = await req.response().catch(() => null)
    if (res && res.status() === 200) state.completed++
  })
  page.on('requestfailed', (req) => {
    if (isLayoutGet(req.url(), req.method())) state.inFlight = Math.max(0, state.inFlight - 1)
  })
  return state
}

async function fetchLayout(page: Page, orgId: string): Promise<SectionLayout> {
  const res = await secretSafe(() => page.request.get(`/api/v1/orgs/${orgId}/me/sections`))
  expect(res.ok()).toBe(true)
  return (await secretSafe(() => res.json())) as SectionLayout
}

test('sections lifecycle: create, rename, move in and back, reorder, collapse, delete with focus, and 320px move dialog fit', async ({ page }) => {
  const orgId = await signInOwner(page.request)
  const createdIds = new Set<string>()
  const suffix = crypto.randomUUID().slice(0, 8)
  const chA = await createChannel(page.request, orgId, `sec-a-${suffix}`)
  const chB = await createChannel(page.request, orgId, `sec-b-${suffix}`)

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/o/${orgId}/c/${chA.id}`)
    const leftCol = page.locator('#channel-content')
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    await expect(leftCol.getByRole('button', { name: 'セクションを作成', exact: true })).toBeEnabled()
    await expect(leftCol.getByRole('button', { name: 'その他のチャンネル' })).toHaveAttribute('aria-expanded', 'true')

    // Create two sections; record each client-generated ID at request time before waiting for rendering.
    const name1 = `開発-${suffix}`
    const name2 = `運用-${suffix}`
    await leftCol.getByRole('button', { name: 'セクションを作成', exact: true }).click()
    await page.getByRole('dialog').getByLabel('セクション名', { exact: true }).fill(name1)
    const sec1Id = await captureCreatedSectionId(page, orgId, createdIds, () =>
      page.getByRole('dialog').getByRole('button', { name: '作成する', exact: true }).click(),
    )
    const sec1 = leftCol.locator(`section[data-section-id="${sec1Id}"]`)
    await expect(sec1).toBeVisible()

    await leftCol.getByRole('button', { name: 'セクションを作成', exact: true }).click()
    await page.getByRole('dialog').getByLabel('セクション名', { exact: true }).fill(name2)
    const sec2Id = await captureCreatedSectionId(page, orgId, createdIds, () =>
      page.getByRole('dialog').getByRole('button', { name: '作成する', exact: true }).click(),
    )
    const sec2 = leftCol.locator(`section[data-section-id="${sec2Id}"]`)
    await expect(sec2).toBeVisible()

    // Rename first section.
    const renamed1 = `設計-${suffix}`
    await sec1.getByRole('button', { name: '名前を変更', exact: true }).click()
    await page.getByRole('dialog').getByLabel('セクション名', { exact: true }).fill(renamed1)
    await page.getByRole('dialog').getByRole('button', { name: '変更する', exact: true }).click()
    const renamedSec1 = leftCol.locator(`section[data-section-id="${sec1Id}"]`)
    await expect(renamedSec1).toHaveAttribute('aria-label', renamed1)

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

    // Move chB back to その他のチャンネル（既定）.
    await renamedSec1.locator(`[data-channel-id="${chB.id}"]`).getByRole('button', { name: 'チャンネルを移動', exact: true }).click()
    await page.getByRole('dialog').getByLabel('その他のチャンネル（既定）', { exact: true }).check()
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
    await sec2.getByTestId(`section-move-up-${sec2Id}`).click()
    await expect.poll(async () => {
      const ids = await leftCol.locator('section.section-group').evaluateAll(els =>
        els.map(el => el.getAttribute('data-section-id')),
      )
      return ids.indexOf(sec2Id) < ids.indexOf(sec1Id)
    }).toBe(true)
    const sec2IsFirst = (await leftCol.locator('section.section-group').first().getAttribute('data-section-id')) === sec2Id
    if (sec2IsFirst) {
      await expect(sec2.locator('[data-section-heading]')).toBeFocused()
    } else {
      await expect(sec2.getByTestId(`section-move-up-${sec2Id}`)).toBeFocused()
    }

    // Delete section 2 -> focus moves to next section heading (renamed1).
    await sec2.getByRole('button', { name: 'セクションを削除', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click()
    await expect(sec2).toHaveCount(0)
    createdIds.delete(sec2Id)
    await expect(renamedSec1.locator('[data-section-heading]')).toBeFocused()

    // Delete renamed1 (last custom section created here) -> focus moves to next heading (or その他のチャンネル).
    await renamedSec1.getByRole('button', { name: 'セクションを削除', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click()
    await expect(renamedSec1).toHaveCount(0)
    createdIds.delete(sec1Id)
    const layoutAfterDeletes = await fetchLayout(page, orgId)
    if (layoutAfterDeletes.sections.length === 0) {
      await expect(otherSec.locator('[data-section-heading]')).toBeFocused()
    }

    // Responsive 320px fit: open the phone Channel list and a populated move dialog so actions stay inside viewport.
    for (let i = 1; i <= 14; i++) {
      await createSectionViaApi(page, orgId, `表示確認-${suffix}-${i}`, createdIds)
    }
    await page.setViewportSize({ width: 320, height: 600 })
    await page.goto(`/o/${orgId}`)
    await expect(page.locator('.workspace')).toHaveAttribute('data-mobile-level', 'channels')
    await expect(leftCol).toBeVisible()
    await expect(leftCol.locator(`section[aria-label="表示確認-${suffix}-14"]`)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    const createBtnBox = await leftCol.getByRole('button', { name: 'セクションを作成', exact: true }).boundingBox()
    expect(createBtnBox).not.toBeNull()
    expect(createBtnBox!.x).toBeGreaterThanOrEqual(0)
    expect(createBtnBox!.x + createBtnBox!.width).toBeLessThanOrEqual(320)

    // Verify full-width input inside Dialog scroll body keeps clearance for focus outline + offset (4px).
    await leftCol.getByRole('button', { name: 'セクションを作成', exact: true }).click()
    const createDialog = page.getByRole('dialog')
    await expect(createDialog).toBeVisible()
    const createBodyBox = await createDialog.locator('.ui-dialog__body').boundingBox()
    const createInputBox = await createDialog.getByLabel('セクション名', { exact: true }).boundingBox()
    expect(createBodyBox).not.toBeNull()
    expect(createInputBox).not.toBeNull()
    expect(createInputBox!.x - createBodyBox!.x).toBeGreaterThanOrEqual(4)
    expect(createBodyBox!.x + createBodyBox!.width - (createInputBox!.x + createInputBox!.width)).toBeGreaterThanOrEqual(4)
    expect(createInputBox!.y - createBodyBox!.y).toBeGreaterThanOrEqual(4)
    expect(createBodyBox!.y + createBodyBox!.height - (createInputBox!.y + createInputBox!.height)).toBeGreaterThanOrEqual(4)
    await createDialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await expect(createDialog).toHaveCount(0)

    await leftCol.locator(`[data-channel-id="${chA.id}"]`).getByRole('button', { name: 'チャンネルを移動', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const dialogBox = await dialog.boundingBox()
    const cancelBox = await dialog.getByRole('button', { name: 'キャンセル', exact: true }).boundingBox()
    const moveBox = await dialog.getByRole('button', { name: '移動する', exact: true }).boundingBox()
    expect(dialogBox).not.toBeNull()
    expect(cancelBox).not.toBeNull()
    expect(moveBox).not.toBeNull()
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0)
    expect(dialogBox!.y).toBeGreaterThanOrEqual(0)
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(320)
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(600)
    expect(cancelBox!.y + cancelBox!.height).toBeLessThanOrEqual(600)
    expect(moveBox!.y + moveBox!.height).toBeLessThanOrEqual(600)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    // Destination list scrolls inside the dialog body to reach the implicit group while actions stay visible.
    const dialogBody = dialog.locator('.ui-dialog__body')
    expect(await dialogBody.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const implicitRadio = dialog.getByLabel('その他のチャンネル（既定）', { exact: true })
    await implicitRadio.scrollIntoViewIfNeeded()
    await expect(implicitRadio).toBeVisible()
    await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  } finally {
    await cleanupCreatedSections(page, orgId, createdIds)
  }
})

test('keyboard-only flow: create, collapse, cancel Escape, rename, move, reorder channels and sections, and delete', async ({ page }) => {
  const orgId = await signInOwner(page.request)
  const createdIds = new Set<string>()
  const suffix = crypto.randomUUID().slice(0, 8)
  const chA = await createChannel(page.request, orgId, `sec-kb-a-${suffix}`)
  const chB = await createChannel(page.request, orgId, `sec-kb-b-${suffix}`)

  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/o/${orgId}/c/${chA.id}`)
    const leftCol = page.locator('#channel-content')
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
    const createBtn = leftCol.getByRole('button', { name: 'セクションを作成', exact: true })
    await expect(createBtn).toBeEnabled()

    // 1. Create two sections via keyboard Enter; capture each ID at request time before rendering.
    const sec1Name = `キーボード一-${suffix}`
    const sec2Name = `キーボード二-${suffix}`
    await createBtn.focus()
    await page.keyboard.press('Enter')
    const nameInput = page.getByRole('dialog').getByLabel('セクション名', { exact: true })
    await expect(nameInput).toBeFocused()
    await page.keyboard.type(sec1Name)
    const sec1Id = await captureCreatedSectionId(page, orgId, createdIds, () =>
      page.keyboard.press('Enter'),
    )
    const sec1 = leftCol.locator(`section[data-section-id="${sec1Id}"]`)
    await expect(sec1).toBeVisible()

    await createBtn.focus()
    await page.keyboard.press('Enter')
    await expect(nameInput).toBeFocused()
    await page.keyboard.type(sec2Name)
    const sec2Id = await captureCreatedSectionId(page, orgId, createdIds, () =>
      page.keyboard.press('Enter'),
    )
    const sec2 = leftCol.locator(`section[data-section-id="${sec2Id}"]`)
    await expect(sec2).toBeVisible()

    // 2. Collapse & expand heading via keyboard Space.
    const heading1 = sec1.locator('[data-section-heading]')
    await heading1.focus()
    await page.keyboard.press('Space')
    await expect(heading1).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Space')
    await expect(heading1).toHaveAttribute('aria-expanded', 'true')

    // 3. Open Rename dialog and cancel with Escape -> focus returns to rename button.
    const renameBtn = sec1.getByRole('button', { name: '名前を変更', exact: true })
    await renameBtn.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(renameBtn).toBeFocused()

    // 4. Rename sec1 via keyboard Enter.
    const renamed1 = `キーボード改-${suffix}`
    await page.keyboard.press('Enter')
    await expect(nameInput).toBeFocused()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await page.keyboard.type(renamed1)
    await page.keyboard.press('Enter')
    const renamedSec1 = leftCol.locator(`section[data-section-id="${sec1Id}"]`)
    await expect(renamedSec1).toHaveAttribute('aria-label', renamed1)

    // 5. Move chA and chB into renamedSec1 via keyboard.
    for (const ch of [chA, chB]) {
      const moveBtn = leftCol.locator(`[data-channel-id="${ch.id}"]`).getByRole('button', { name: 'チャンネルを移動', exact: true })
      await moveBtn.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      const destRadio = dialog.getByLabel(renamed1, { exact: true })
      await destRadio.focus()
      await page.keyboard.press('Space')
      await expect(destRadio).toBeChecked()
      const confirmMove = dialog.getByRole('button', { name: '移動する', exact: true })
      await confirmMove.focus()
      await page.keyboard.press('Enter')
      await expect(renamedSec1.locator(`[data-channel-id="${ch.id}"]`)).toBeVisible()
      await expect(renamedSec1.locator(`[data-channel-id="${ch.id}"] .ui-list-row`)).toBeFocused()
    }

    // 6. Reorder chB up above chA within renamedSec1 via keyboard; assert order and focus.
    const moveChBUp = renamedSec1.getByTestId(`channel-move-up-${chB.id}`)
    await moveChBUp.focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () =>
      renamedSec1.locator('[data-channel-id]').evaluateAll(els => els.map(el => el.getAttribute('data-channel-id'))),
    ).toEqual([chB.id, chA.id])
    await expect(renamedSec1.locator(`[data-channel-id="${chB.id}"] .ui-list-row`)).toBeFocused()

    // 7. Reorder sec2 up above renamedSec1 via keyboard; assert order and focus.
    const moveSec2Up = sec2.getByTestId(`section-move-up-${sec2Id}`)
    await moveSec2Up.focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => {
      const ids = await leftCol.locator('section.section-group').evaluateAll(els =>
        els.map(el => el.getAttribute('data-section-id')),
      )
      return ids.indexOf(sec2Id) < ids.indexOf(sec1Id)
    }).toBe(true)
    const sec2IsFirst = (await leftCol.locator('section.section-group').first().getAttribute('data-section-id')) === sec2Id
    if (sec2IsFirst) {
      await expect(sec2.locator('[data-section-heading]')).toBeFocused()
    } else {
      await expect(moveSec2Up).toBeFocused()
    }

    // 8. Delete sec2 then renamedSec1 via keyboard; assert delete fallback focus.
    const deleteSec2Btn = sec2.getByRole('button', { name: 'セクションを削除', exact: true })
    await deleteSec2Btn.focus()
    await page.keyboard.press('Enter')
    const confirmDelete = page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true })
    await confirmDelete.focus()
    await page.keyboard.press('Enter')
    await expect(sec2).toHaveCount(0)
    createdIds.delete(sec2Id)
    await expect(renamedSec1.locator('[data-section-heading]')).toBeFocused()

    const deleteSec1Btn = renamedSec1.getByRole('button', { name: 'セクションを削除', exact: true })
    await deleteSec1Btn.focus()
    await page.keyboard.press('Enter')
    await confirmDelete.focus()
    await page.keyboard.press('Enter')
    await expect(renamedSec1).toHaveCount(0)
    createdIds.delete(sec1Id)
    const layoutAfterDeletes = await fetchLayout(page, orgId)
    if (layoutAfterDeletes.sections.length === 0) {
      await expect(leftCol.locator('section[aria-label="その他のチャンネル"] [data-section-heading]')).toBeFocused()
    }
  } finally {
    await cleanupCreatedSections(page, orgId, createdIds)
  }
})

test('two-tab convergence without reload', async ({ page, context }) => {
  const orgId = await signInOwner(page.request)
  const createdIds = new Set<string>()
  const suffix = crypto.randomUUID().slice(0, 8)
  const ch = await createChannel(page.request, orgId, `sec-sync-${suffix}`)
  const secName = `同期-${suffix}`
  const layoutPath = `/api/v1/orgs/${orgId}/me/sections`
  const tab2 = await context.newPage()

  try {
    // Keep periodic recovery (~29.7s) out of this test window so tab 2's refresh proves notice-driven convergence.
    await tab2.addInitScript(() => {
      Math.random = () => 0.99
    })
    const tab1Reads = trackLayoutReads(page, layoutPath)
    const tab2Reads = trackLayoutReads(tab2, layoutPath)

    await page.setViewportSize({ width: 1280, height: 800 })
    await tab2.setViewportSize({ width: 1280, height: 800 })
    await Promise.all([
      page.goto(`/o/${orgId}/c/${ch.id}`),
      tab2.goto(`/o/${orgId}/c/${ch.id}`),
    ])

    // Fence the mutation on completion of BOTH tabs' initial and Ready-triggered /me/sections reads
    // so convergence proves notice-driven refresh rather than initial or Ready recovery.
    for (const [tab, reads] of [
      [page, tab1Reads],
      [tab2, tab2Reads],
    ] as const) {
      await expect(tab.getByTestId('live-status')).toHaveAttribute('data-live', 'true')
      await expect(tab.locator('#channel-content').getByRole('button', { name: 'セクションを作成', exact: true })).toBeEnabled()
      await expect(tab.locator(`#channel-content section[aria-label="その他のチャンネル"] [data-channel-id="${ch.id}"]`)).toBeVisible()
      await expect(tab.locator(`#channel-content section[aria-label="${secName}"]`)).toHaveCount(0)
      await expect.poll(() => reads.completed >= 2 && reads.inFlight === 0).toBe(true)
    }

    // Create section in tab 1 -> tab 2 issues a new /me/sections read after the write commits and renders the section.
    await page.locator('#channel-content').getByRole('button', { name: 'セクションを作成', exact: true }).click()
    await page.getByRole('dialog').getByLabel('セクション名', { exact: true }).fill(secName)
    const tab2ReadsBeforeCreate = tab2Reads.completed
    const tab2CreateRefresh = tab2.waitForResponse(
      res => res.request().method() === 'GET' && new URL(res.url()).pathname === layoutPath && res.status() === 200,
    )
    const secId = await captureCreatedSectionId(page, orgId, createdIds, () =>
      page.getByRole('dialog').getByRole('button', { name: '作成する', exact: true }).click(),
    )
    const tab1Sec = page.locator(`#channel-content section[data-section-id="${secId}"]`)
    await expect(tab1Sec).toBeVisible()
    await tab2CreateRefresh
    await expect.poll(() => tab2Reads.completed).toBeGreaterThan(tab2ReadsBeforeCreate)
    await expect(tab2.locator(`#channel-content section[data-section-id="${secId}"]`)).toBeVisible()

    // Move channel in tab 1 -> tab 2 converges without reload.
    await page.locator(`#channel-content [data-channel-id="${ch.id}"]`).getByRole('button', { name: 'チャンネルを移動', exact: true }).click()
    await page.getByRole('dialog').getByLabel(secName, { exact: true }).check()
    await page.getByRole('dialog').getByRole('button', { name: '移動する', exact: true }).click()
    await expect(tab2.locator(`#channel-content section[data-section-id="${secId}"] [data-channel-id="${ch.id}"]`)).toBeVisible()

    // Delete section in tab 1 -> tab 2 converges without reload.
    await tab1Sec.getByRole('button', { name: 'セクションを削除', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '削除する', exact: true }).click()
    await expect(tab1Sec).toHaveCount(0)
    createdIds.delete(secId)
    await expect(tab2.locator(`#channel-content section[data-section-id="${secId}"]`)).toHaveCount(0)
    await expect(tab2.locator(`#channel-content section[aria-label="その他のチャンネル"] [data-channel-id="${ch.id}"]`)).toBeVisible()
  } finally {
    await tab2.close()
    await cleanupCreatedSections(page, orgId, createdIds)
  }
})
