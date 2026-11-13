import { expect, it, vi } from 'vitest'
import { createAccountSecurity } from './account-security'
import type { Result } from './api'

function fixture() {
  const ended = vi.fn()
  const deps = {
    putPassword: vi.fn(async (): Promise<Result<undefined>> => ({ ok: true, data: undefined })),
    revokeOtherSessions: vi.fn(async (): Promise<Result<undefined>> => ({ ok: true, data: undefined })),
  }
  return { deps, ended, controller: createAccountSecurity(ended, deps) }
}
const input = { current_password: 'correct horse battery', new_password: 'new correct horse battery' }

it('both security actions preserve the current session on 403 and classify other refusals', async () => {
  for (const password of [true, false]) {
    const f = fixture()
    const dependency = password ? f.deps.putPassword : f.deps.revokeOtherSessions
    const run = () => password ? f.controller.changePassword(input) : f.controller.revokeOthers({ current_password: input.current_password })
    for (const [result, error] of [
      [{ ok: false, kind: 'http', status: 403, error: 'current_password_incorrect' }, 'incorrect'],
      [{ ok: false, kind: 'http', status: 400, error: 'invalid_new_password' }, 'invalid'],
      [{ ok: false, kind: 'http', status: 429 }, 'throttled'],
      [{ ok: false, kind: 'network' }, 'unconfirmed'],
    ] as const) {
      dependency.mockResolvedValueOnce(result)
      expect(await run()).toBe(false)
      expect(f.controller.get()).toEqual({ busy: false, error, success: null })
      expect(f.ended).not.toHaveBeenCalled()
    }
    dependency.mockResolvedValueOnce({ ok: false, kind: 'http', status: 401 })
    await run()
    expect(f.ended).toHaveBeenCalledOnce()
  }
})

it('security actions send generated bodies once while pending and publish success without retaining credentials', async () => {
  const f = fixture()
  let finish!: (result: Result<undefined>) => void
  f.deps.putPassword.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const listener = vi.fn()
  f.controller.subscribe(listener)
  const pending = f.controller.changePassword(input)
  expect(f.controller.get().busy).toBe(true)
  expect(await f.controller.revokeOthers(input)).toBe(false)
  expect(f.deps.revokeOtherSessions).not.toHaveBeenCalled()
  expect(f.deps.putPassword).toHaveBeenCalledExactlyOnceWith(input)
  finish({ ok: true, data: undefined })
  expect(await pending).toBe(true)
  expect(f.controller.get()).toEqual({ busy: false, error: null, success: 'password' })
  f.controller.reset()
  await f.controller.revokeOthers({ current_password: input.current_password })
  expect(f.controller.get().success).toBe('sessions')
  expect(listener).toHaveBeenCalled()
})

it('closing an Account security controller fences late successes and 401 from the replaced Account', async () => {
  for (const result of [{ ok: false, kind: 'http', status: 401 }, { ok: true, data: undefined }] as const) {
    const f = fixture()
    let finish!: (result: Result<undefined>) => void
    f.deps.putPassword.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = f.controller.changePassword(input)
    f.controller.close()
    const state = f.controller.get()
    finish(result)
    expect(await pending).toBe(false)
    expect(f.controller.get()).toBe(state)
    expect(f.ended).not.toHaveBeenCalled()
    expect(await f.controller.revokeOthers(input)).toBe(false)
  }
})
