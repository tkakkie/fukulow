import { defineConfig } from '@playwright/test'

// Browser component tests (#449): Vite's dev server serves test pages from e2e-component/ that mount real components
// with test-only fakes. No server or database. The pages are not build inputs, so they never ship.
const port = Number(process.env.E2E_COMPONENT_PORT ?? 18180)

// Same secret-safe failure policy as playwright.config.ts (#254).
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'

export default defineConfig({
  testDir: './e2e-component',
  workers: 1,
  timeout: 30_000,
  preserveOutput: 'never',
  reporter: process.env.CI ? 'dot' : 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } }],
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/e2e-component/observer-read.html`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
