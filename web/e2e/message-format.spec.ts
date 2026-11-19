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
