import { fileURLToPath } from 'node:url'
import { build, type Rollup } from 'vite'
import { expect, it } from 'vitest'

it('preloads exactly the hashed wasm URL used by the production glue', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const { output } = await build({ root, mode: 'production', build: { write: false }, logLevel: 'silent' }) as Rollup.RollupOutput
  const index = output.find(item => item.type === 'asset' && item.fileName === 'index.html')
  const glue = output.find(item => item.type === 'chunk' && item.name === 'sync-wasm')
  if (index?.type !== 'asset' || glue?.type !== 'chunk') throw new Error('Missing index or wasm glue')

  const wasm = glue.code.match(/new URL\(["'`]+(\/assets\/fukulow_client_core_bg-[\w-]+\.wasm)["'`]+,/)?.[1]
  expect(wasm).toBeDefined()
  expect(output.some(item => '/' + item.fileName === wasm)).toBe(true)
  const preloads = (String(index.source).match(/<link\b[^>]*>/g) ?? [])
    .filter(tag => tag.includes('rel="preload"') && /application\/wasm|\.wasm"/.test(tag))
  expect(preloads).toHaveLength(1)
  expect(preloads[0]).toContain(`href="${wasm}"`)
  expect(preloads[0]).toContain('as="fetch"')
  expect(preloads[0]).toContain('type="application/wasm"')
  expect(preloads[0]).toMatch(/\scrossorigin(?:="anonymous")?(?=\s|>)/)
})
