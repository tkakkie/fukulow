import { defineConfig } from '@playwright/test'
import dns from 'node:dns'

// APIRequestContext uses Node DNS; Chromium has its own resolver below. Scope
// the fixture to this process so neither the host nor deployment DNS is changed.
if (process.env.E2E_TEST_DOMAIN === 'fukulow.test') {
  const lookup = dns.lookup
  dns.lookup = ((hostname: string, ...args: unknown[]) =>
    Reflect.apply(lookup, dns, [hostname === 'fukulow.test' ? '127.0.0.1' : hostname, ...args])) as typeof dns.lookup
  const promiseLookup = dns.promises.lookup
  dns.promises.lookup = ((hostname: string, ...args: unknown[]) =>
    Reflect.apply(promiseLookup, dns.promises, [hostname === 'fukulow.test' ? '127.0.0.1' : hostname, ...args])) as typeof dns.promises.lookup
}

// Runs against an isolated real Docker Compose stack with an empty database.
// Set E2E_BASE_URL to its private HTTPS port; never reuse another task's stack or database.
// Both TLS profiles use the disposable Pebble CA, hence ignoreHTTPSErrors.
// Match the secret-safe failure policy of playwright.config.ts (#254).
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'

export default defineConfig({
  testDir: './e2e-compose',
  timeout: 60_000,
  workers: 1,
  preserveOutput: 'never',
  outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',
  reporter: process.env.CI ? [['dot'], ['./scripts/e2e-reporter.ts']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://localhost', ignoreHTTPSErrors: true,
    launchOptions: { args: process.env.E2E_TEST_DOMAIN
      ? [`--host-resolver-rules=MAP ${process.env.E2E_TEST_DOMAIN} 127.0.0.1`] : [] },
    trace: 'off', screenshot: 'off', video: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
