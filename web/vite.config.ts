import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const test = mode === 'test'
  return {
    plugins: [
      svelte({
        // Vitest runs in Node, which Vite treats as SSR: `.svelte.ts` modules would compile with `generate: 'server'`,
        // where `$effect` never runs. Compile for the client instead, so adapters run like in the browser.
        dynamicCompileOptions: () => (test ? { generate: 'client' } : undefined),
      }),
    ],
    // Same reason for the runtime: resolve svelte's browser build (it needs no DOM) instead of its server build.
    ssr: { resolve: { conditions: test ? ['browser', 'module', 'node', 'development|production'] : undefined } },
    test: { exclude: ['e2e/**', 'e2e-compose/**', 'node_modules/**'] },
  }
})
