import { fileURLToPath } from 'node:url'
import { checkCoreBundle } from './scripts/core-bundle.ts'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const test = mode === 'test'
  const implementation = process.env.SYNC_CORE ?? 'wasm'
  if (!['wasm', 'ts'].includes(implementation)) throw new Error('SYNC_CORE must be wasm or ts')
  return {
    build: { manifest: true, assetsInlineLimit: 0, rollupOptions: { output: {
      manualChunks: id => id.endsWith('/wasm/fukulow_client_core.js') ? 'sync-wasm' : undefined,
    } } },
    resolve: { alias: [
      { find: '#sync-core', replacement: fileURLToPath(new URL('./src/core-' + implementation + '.ts', import.meta.url)) },
      ...(test ? [{ find: /^\.\/core-values$/, replacement: fileURLToPath(new URL('./scripts/core-test-values.ts', import.meta.url)) }] : []),
    ] },
    plugins: [
      { name: 'single-sync-implementation', generateBundle(_options, bundle) {
        checkCoreBundle(implementation, Object.values(bundle).flatMap(chunk => chunk.type === 'chunk' ? Object.keys(chunk.modules) : []),
          Object.values(bundle).filter(chunk => chunk.type === 'asset').map(asset => asset.fileName))
      } },
      // Start the core download with the entry JS instead of after it; the shell no longer waits for it (#466).
      { name: 'preload-sync-wasm', transformIndexHtml: { order: 'post', handler(_html, ctx) {
        const wasm = Object.values(ctx.bundle ?? {}).find(file => file.type === 'asset' && file.fileName.endsWith('.wasm'))
        return wasm ? [{ tag: 'link', injectTo: 'head', attrs: { rel: 'preload', href: '/' + wasm.fileName, as: 'fetch', type: 'application/wasm', crossorigin: '' } }] : []
      } } },
      svelte({
        // Vitest runs in Node, which Vite treats as SSR: `.svelte.ts` modules would compile with `generate: 'server'`,
        // where `$effect` never runs. Compile for the client instead, so adapters run like in the browser.
        dynamicCompileOptions: () => (test ? { generate: 'client' } : undefined),
      }),
    ],
    // Same reason for the runtime: resolve svelte's browser build (it needs no DOM) instead of its server build.
    ssr: { resolve: { conditions: test ? ['browser', 'module', 'node', 'development|production'] : undefined } },
    test: { setupFiles: ['./scripts/init-wasm.ts'], exclude: ['e2e/**', 'e2e-compose/**', 'node_modules/**'] },
  }
})
