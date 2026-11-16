import { expect, it, vi } from 'vitest'
import { bootstrap } from './bootstrap'
it('initializes wasm before mounting any controller and shows an error without starting on failure', async () => {
  let ready!: () => void
  const start = vi.fn(), fail = vi.fn()
  const boot = bootstrap(() => new Promise<void>(resolve => { ready = resolve }), start, fail)
  expect(start).not.toHaveBeenCalled()
  ready(); await boot
  expect(start).toHaveBeenCalledOnce()
  expect(fail).not.toHaveBeenCalled()
  start.mockClear()
  await bootstrap(() => Promise.reject(new Error('invalid wasm')), start, fail)
  expect(start).not.toHaveBeenCalled()
  expect(fail).toHaveBeenCalledOnce()
})
