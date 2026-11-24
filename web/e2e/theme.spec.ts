import { expect, test } from '@playwright/test'

const LIGHT_APP = 'rgb(233, 239, 237)'
const LIGHT_TEXT = 'rgb(21, 32, 30)'
const DARK_APP = 'rgb(10, 15, 14)'
const DARK_TEXT = 'rgb(229, 236, 234)'

test('light-dark() colour tokens follow prefers-color-scheme and honour manual data-theme overrides in either direction (#832)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')

  const root = page.locator('html')
  const body = page.locator('body')

  // No manual choice under dark system setting -> renders dark tokens
  await expect(root).not.toHaveAttribute('data-theme')
  await expect(body).toHaveCSS('background-color', DARK_APP)
  await expect(body).toHaveCSS('color', DARK_TEXT)

  // Manual light choice under dark system setting -> renders light tokens
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await expect(body).toHaveCSS('background-color', LIGHT_APP)
  await expect(body).toHaveCSS('color', LIGHT_TEXT)

  // Removing manual choice returns to dark system setting
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  await expect(body).toHaveCSS('background-color', DARK_APP)
  await expect(body).toHaveCSS('color', DARK_TEXT)

  // No manual choice under light system setting -> renders light tokens
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(body).toHaveCSS('background-color', LIGHT_APP)
  await expect(body).toHaveCSS('color', LIGHT_TEXT)

  // Manual dark choice under light system setting -> renders dark tokens
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await expect(body).toHaveCSS('background-color', DARK_APP)
  await expect(body).toHaveCSS('color', DARK_TEXT)

  // Removing manual choice returns to light system setting
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  await expect(body).toHaveCSS('background-color', LIGHT_APP)
  await expect(body).toHaveCSS('color', LIGHT_TEXT)
})
