import { expect, test } from '@playwright/test'
import type { components } from '../src/api-schema.d.ts'
import { createChannel, secretSafe, signInOwner } from './helpers.ts'

test('Message body formatting (#628): link keyboard focus and activation, target/rel attributes, code block horizontal scroll without page overflow at phone width, long URL wrapping, and light/dark themes', async ({
  page,
}) => {
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `fmt-${crypto.randomUUID().slice(0, 8)}`)

  const longUrl = `https://example.invalid/path/${'0123456789abcdef'.repeat(12)}`
  const longCodeLine = `const veryLongLine = "${'x'.repeat(120)}";`
  const formattedBody = [
    `**太字と~~取り消し線~~** \`inline_code()\``,
    `リンク: ${longUrl} と javascript:alert(1)`,
    '> 引用行1',
    '> 引用行2',
    '```',
    longCodeLine,
    '```',
  ].join('\n')

  const seed: components['schemas']['SendMessageRequest'] = {
    client_message_id: crypto.randomUUID(),
    body: formattedBody,
  }
  const posted = await secretSafe(() =>
    page.request.post(`/api/v1/orgs/${org}/channels/${channel.id}/messages`, { data: seed }),
  )
  expect(posted.status()).toBe(201)

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/o/${org}/c/${channel.id}`)
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

  const main = page.locator('#main-content')
  const article = main.getByRole('article').first()
  await expect(article).toBeVisible()

  // Verify formatted elements and attributes
  await expect(article.locator('strong')).toContainText('太字と')
  await expect(article.locator('del')).toHaveText('取り消し線')
  await expect(article.locator('code.ui-message-body__inline-code')).toHaveText('inline_code()')
  await expect(article.locator('blockquote')).toHaveText('引用行1\n引用行2')

  const links = article.locator('a')
  await expect(links).toHaveCount(1)
  const link = links.first()
  await expect(link).toHaveAttribute('href', longUrl)
  await expect(link).toHaveText(longUrl)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')

  // Light and dark themes apply distinct link/code/quote token colors
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  const lightStyles = await article.evaluate((el) => {
    const a = el.querySelector('a')!
    const pre = el.querySelector('pre')!
    const quote = el.querySelector('blockquote')!
    return {
      linkColor: getComputedStyle(a).color,
      preBg: getComputedStyle(pre).backgroundColor,
      quoteColor: getComputedStyle(quote).color,
    }
  })

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const darkStyles = await article.evaluate((el) => {
    const a = el.querySelector('a')!
    const pre = el.querySelector('pre')!
    const quote = el.querySelector('blockquote')!
    return {
      linkColor: getComputedStyle(a).color,
      preBg: getComputedStyle(pre).backgroundColor,
      quoteColor: getComputedStyle(quote).color,
    }
  })
  expect(darkStyles.linkColor).not.toBe(lightStyles.linkColor)
  expect(darkStyles.preBg).not.toBe(lightStyles.preBg)
  expect(darkStyles.quoteColor).not.toBe(lightStyles.quoteColor)

  // Keyboard focus and activation on link:
  // Focus the confirmed row, press Tab to reach the link, then press Enter to activate it without opening the Reply panel
  await article.focus()
  await expect(article).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(link).toBeFocused()
  const popupPromise = page.waitForEvent('popup')
  await page.keyboard.press('Enter')
  const popup = await popupPromise
  await popup.close()
  await expect(page.locator('#panel-content')).toHaveCount(0)

  // Phone width (320 CSS px): code block scrolls horizontally without page overflow, and long URL wraps
  await page.setViewportSize({ width: 320, height: 800 })
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true)

  const pre = article.locator('pre.ui-message-body__code-block')
  await expect(pre).toBeVisible()
  const codeBlockLayout = await pre.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
      fitsViewport: rect.left >= 0 && rect.right <= window.innerWidth + 1,
    }
  })
  expect(codeBlockLayout.overflowX).toBe('auto')
  expect(codeBlockLayout.scrollWidth).toBeGreaterThan(codeBlockLayout.clientWidth)
  expect(codeBlockLayout.fitsViewport).toBe(true)

  const urlLayout = await link.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return {
      fitsViewport: rect.left >= 0 && rect.right <= window.innerWidth + 1,
      lineRects: el.getClientRects().length,
    }
  })
  expect(urlLayout.fitsViewport).toBe(true)
  expect(urlLayout.lineRects).toBeGreaterThan(1)
})

test('Message body formatting (#628): multi-row roving tabindex keeps only the active row link tabbable across ArrowUp and ArrowDown', async ({
  page,
}) => {
  const org = await signInOwner(page.request)
  const channel = await createChannel(page.request, org, `fmt-roving-${crypto.randomUUID().slice(0, 8)}`)

  for (const body of [
    '1件目のリンク: https://example.invalid/first',
    '2件目のリンク: https://example.invalid/second',
  ]) {
    const seed: components['schemas']['SendMessageRequest'] = {
      client_message_id: crypto.randomUUID(),
      body,
    }
    const posted = await secretSafe(() =>
      page.request.post(`/api/v1/orgs/${org}/channels/${channel.id}/messages`, { data: seed }),
    )
    expect(posted.status()).toBe(201)
  }

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/o/${org}/c/${channel.id}`)
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-live', 'true')

  const main = page.locator('#main-content')
  const articles = main.getByRole('article')
  await expect(articles).toHaveCount(2)

  const row1 = articles.nth(0)
  const row2 = articles.nth(1)
  const link1 = row1.locator('a')
  const link2 = row2.locator('a')

  // Default roving row is the latest confirmed row (row2); row1's link is not a Tab stop
  await expect(row1).toHaveAttribute('tabindex', '-1')
  await expect(link1).toHaveAttribute('tabindex', '-1')
  await expect(row2).toHaveAttribute('tabindex', '0')
  await expect(link2).toHaveAttribute('tabindex', '0')

  // Tab from row2 reaches row2's link, not row1's
  await row2.focus()
  await expect(row2).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(link2).toBeFocused()

  // ArrowUp moves roving focus to row1: row1's link becomes the sole tabbable link
  await row2.focus()
  await page.keyboard.press('ArrowUp')
  await expect(row1).toBeFocused()
  await expect(row1).toHaveAttribute('tabindex', '0')
  await expect(link1).toHaveAttribute('tabindex', '0')
  await expect(row2).toHaveAttribute('tabindex', '-1')
  await expect(link2).toHaveAttribute('tabindex', '-1')

  // Tab from row1 reaches link1; another Tab skips row2 and link2
  await page.keyboard.press('Tab')
  await expect(link1).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(row2).not.toBeFocused()
  await expect(link2).not.toBeFocused()

  // ArrowDown moves roving focus back to row2: row2's link becomes tabbable again
  await row1.focus()
  await page.keyboard.press('ArrowDown')
  await expect(row2).toBeFocused()
  await expect(row1).toHaveAttribute('tabindex', '-1')
  await expect(link1).toHaveAttribute('tabindex', '-1')
  await expect(row2).toHaveAttribute('tabindex', '0')
  await expect(link2).toHaveAttribute('tabindex', '0')

  await page.keyboard.press('Tab')
  await expect(link2).toBeFocused()

  // A failed pending row keeps its link in the Tab order alongside its action buttons
  await page.route(`**/api/v1/orgs/${org}/channels/${channel.id}/messages`, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'forbidden', message: 'forbidden' }),
      })
      return
    }
    await route.continue()
  })
  const composer = main.locator('textarea').first()
  await composer.fill('See https://example.invalid/help')
  await composer.press('Enter')

  const failedLink = main.locator('a[href="https://example.invalid/help"]')
  await expect(failedLink).toBeVisible()
  await expect(failedLink).toHaveAttribute('tabindex', '0')

  // Tab from row2's link reaches the failed pending row's link
  await link2.focus()
  await expect(link2).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(failedLink).toBeFocused()
})
