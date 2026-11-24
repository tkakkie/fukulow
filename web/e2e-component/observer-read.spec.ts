import { expect, test, type Page } from '@playwright/test'
import type { ObserverReadProbe } from './observer-read-probe.ts'

type TestGlobal = { observerRead: ObserverReadProbe; stop: () => void }
const probe = (page: Page) => page.evaluate(() => (globalThis as unknown as TestGlobal).observerRead)

/** True when no scroll event, mount, report or scroll position change happened over several animation frames. */
const quiet = (page: Page) => page.evaluate(async () => {
  const p = (globalThis as unknown as TestGlobal).observerRead
  const scroller = document.querySelector('.timeline-scroll')!
  const snapshot = () => [p.scrolls, p.scrollEnds, p.everMounted.length, p.presented.length, scroller.scrollTop].join()
  const first = snapshot()
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    if (snapshot() !== first) return false
  }
  return true
})

/** Confirmed seqs of rows that are mounted and intersect the scroller, in seq order. */
const shownSeqs = (page: Page) => page.locator('.timeline-scroll').evaluate(el => {
  const view = el.getBoundingClientRect()
  return [...el.querySelectorAll<HTMLElement>('[data-confirmed-seq]')]
    .filter(row => { const r = row.getBoundingClientRect(); return r.height > 0 && r.bottom > view.top && r.top < view.bottom })
    .map(row => Number(row.dataset.confirmedSeq)).sort((a, b) => a - b)
})

// #449: rows that mount after native scrolling stops become read through the row window's IntersectionObserver alone.
// The page applies every report until `stop()`, then only reports made inside the observer callback
// (see observer-read.page.ts), and readSeq follows the production rule.
test('rows mounted after native scrolling stops are reported through the IntersectionObserver alone', async ({ page }) => {
  await page.goto('/e2e-component/observer-read.html')
  const scroller = page.locator('.timeline-scroll')
  await expect(page.locator('[data-confirmed-seq="1"]')).toBeVisible()
  // Timeline is ready to report once any reporter has called presented (the first Unread row is scrolled to).
  await expect.poll(async () => (await probe(page)).presented.length).toBeGreaterThan(0)
  // Startup scrolls (to the first Unread row) have finished, so the next scrollend can only come from the wheel.
  await expect.poll(() => quiet(page)).toBe(true)

  const before = await scroller.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, scrollHeight: el.scrollHeight }))
  expect(before.top).toBeLessThan(before.height / 2)
  expect(before.scrollHeight).toBeGreaterThan(before.height * 6)
  const { scrollEnds } = await probe(page)

  // Native wheel scroll by less than one viewport, so every row it passes is shown and read stays contiguous.
  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, Math.round(before.height * 0.7))
  await expect.poll(async () => (await probe(page)).scrollEnds).toBe(scrollEnds + 1)
  await expect.poll(() => quiet(page)).toBe(true)
  const stoppedTop = await scroller.evaluate(el => el.scrollTop)
  expect(stoppedTop).toBeGreaterThan(before.top + before.height / 2)

  // Scrolling has stopped. From here only the observer callback may advance readSeq.
  await page.evaluate(() => (globalThis as unknown as TestGlobal).stop())
  const { stopped } = await probe(page)
  expect(stopped!.scrollEnds).toBe(scrollEnds + 1)
  const shownAtStop = await shownSeqs(page)
  expect(stopped!.readSeq).toBe(shownAtStop.at(-1))

  // A taller window mounts rows past the old overscan without any scroll.
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: viewport.width, height: viewport.height + 1_800 })

  await expect.poll(async () => {
    const shown = await shownSeqs(page)
    const p = await probe(page)
    const mountedAfterStop = shown.filter(seq => !p.stopped!.mounted.includes(seq))
    return {
      mountedAfterStopShown: mountedAfterStop.length >= 5,
      notReportedByObserver: mountedAfterStop.filter(seq => !p.afterStop.includes(seq)),
      // Each row mounted after the stop fired an applied observer callback itself, not only rows mounted before it.
      notObservedThemselves: mountedAfterStop.filter(seq => !p.firedAfterStop.includes(seq)),
      reportedButNotShown: p.afterStop.filter(seq => !shown.includes(seq)),
      readSeqIsLastShown: p.readSeq === shown.at(-1) && p.readSeq > p.stopped!.readSeq,
    }
  }, { timeout: 5_000 }).toEqual({
    mountedAfterStopShown: true, notReportedByObserver: [], notObservedThemselves: [], reportedButNotShown: [], readSeqIsLastShown: true,
  })
  const after = await probe(page)
  expect({ scrolls: after.scrolls, scrollEnds: after.scrollEnds }).toEqual({ scrolls: stopped!.scrolls, scrollEnds: stopped!.scrollEnds })
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(stoppedTop)
})
