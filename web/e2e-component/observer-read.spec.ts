import { expect, test, type Page } from '@playwright/test'
import type { ObserverReadProbe } from './observer-read-probe.ts'

const probe = (page: Page) => page.evaluate(() => (globalThis as unknown as { observerRead: ObserverReadProbe }).observerRead)

// #449: rows that mount after native scrolling become read through the row window's IntersectionObserver alone.
// The page applies only reports made inside the observer callback (see observer-read.page.ts).
test('rows mounted after native scrolling stops are reported through the IntersectionObserver alone', async ({ page }) => {
  await page.goto('/e2e-component/observer-read.html')
  const scroller = page.locator('.timeline-scroll')
  await expect(page.locator('[data-confirmed-seq="1"]')).toBeVisible()
  // Timeline is ready to report once any reporter has called presented (the first Unread row is scrolled to).
  await expect.poll(async () => { const p = await probe(page); return p.otherReports + p.observerSeqs.length }).toBeGreaterThan(0)

  const before = await scroller.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, scrollHeight: el.scrollHeight }))
  expect(before.top).toBeLessThan(before.height / 2)
  expect(before.scrollHeight).toBeGreaterThan(before.height * 6)
  const { everMounted: mountedBefore, scrollEnds } = await probe(page)
  expect(Math.max(...mountedBefore)).toBeLessThan(60)

  // Native wheel scroll, three viewports down: past the overscan, so the rows shown at the stop were never mounted.
  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, before.height * 3)
  await expect.poll(async () => (await probe(page)).scrollEnds).toBeGreaterThan(scrollEnds)
  expect(await scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(before.height * 2)

  await expect.poll(async () => {
    const shown = await scroller.evaluate(el => {
      const view = el.getBoundingClientRect()
      return [...el.querySelectorAll<HTMLElement>('[data-confirmed-seq]')]
        .filter(row => { const r = row.getBoundingClientRect(); return r.height > 0 && r.bottom > view.top && r.top < view.bottom })
        .map(row => Number(row.dataset.confirmedSeq))
    })
    const { observerSeqs, readSeq } = await probe(page)
    const newlyMounted = shown.filter(seq => !mountedBefore.includes(seq))
    return {
      newlyMountedShown: newlyMounted.length > 0,
      notReportedByObserver: newlyMounted.filter(seq => !observerSeqs.includes(seq)),
      readSeqCoversThem: newlyMounted.length > 0 && readSeq >= Math.max(...newlyMounted),
    }
  }, { timeout: 5_000 }).toEqual({ newlyMountedShown: true, notReportedByObserver: [], readSeqCoversThem: true })
})
