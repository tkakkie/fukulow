import { describe, expect, it, vi } from 'vitest'
import { errorMessage, restore, setupAndSignIn, signOut } from './auth'

const identity = {
  account: { id: 'a', email: 'a@example.com' },
  organizations: [{ organization_id: 'o', name: 'Org' }],
}
const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const route = (table: Record<string, () => Response | Promise<Response>>) =>
  vi.fn(async (url: string, init?: RequestInit) => {
    const h = table[`${init?.method ?? 'GET'} ${url}`]
    if (!h) throw new Error('unexpected ' + url)
    return h()
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>

describe('restore', () => {
  it('signed in when /me is 200', async () => {
    const f = route({ 'GET /api/v1/me': () => j(identity) })
    expect(await restore(f)).toEqual({ screen: 'app', identity })
  })
  it('401 on a fresh instance -> setup', async () => {
    const f = route({
      'GET /api/v1/me': () => j({ error: 'x' }, 401),
      'GET /api/v1/setup': () => j({ setup_required: true }),
    })
    expect(await restore(f)).toEqual({ screen: 'setup' })
  })
  it('401 on a set-up instance -> signin, setup status not cached', async () => {
    const f = route({
      'GET /api/v1/me': () => j({ error: 'x' }, 401),
      'GET /api/v1/setup': () => j({ setup_required: false }),
    })
    expect(await restore(f)).toEqual({ screen: 'signin' })
    expect((f as any).mock.calls[1][1].cache).toBe('no-store')
  })
  it('network failure and 5xx are retryable errors, not signed out', async () => {
    expect(await restore(vi.fn().mockRejectedValue(new Error('n')))).toEqual({ screen: 'error' })
    expect(await restore(route({ 'GET /api/v1/me': () => j({}, 503) }))).toEqual({ screen: 'error' })
  })
  it('error when setup status fails', async () => {
    const f = route({
      'GET /api/v1/me': () => j({}, 401),
      'GET /api/v1/setup': () => j({}, 500),
    })
    expect(await restore(f)).toEqual({ screen: 'error' })
  })
})

const req = { organization_name: 'Org', name: 'A', email: 'a@example.com', password: 'passwordpassword', setup_token: 'tok' }

describe('setupAndSignIn', () => {
  it('signs in right after setup 201', async () => {
    const f = route({
      'POST /api/v1/setup': () => j({}, 201),
      'POST /api/v1/session': () => j({ expires_in: 1, identity }),
    })
    expect(await setupAndSignIn(req, f)).toEqual({ state: { screen: 'app', identity } })
  })
  it('sends the required setup_token and omits organization_id on sign-in', async () => {
    const f = route({
      'POST /api/v1/setup': () => j({}, 201),
      'POST /api/v1/session': () => j({ expires_in: 1, identity }),
    })
    await setupAndSignIn({ ...req, setup_token: 'tok' }, f)
    const calls = (f as any).mock.calls
    expect(JSON.parse(calls[0][1].body).setup_token).toBe('tok')
    expect(JSON.parse(calls[1][1].body)).toEqual({ email: req.email, password: req.password })
  })
  it('failed auto sign-in goes to signin without re-running setup', async () => {
    const f = route({
      'POST /api/v1/setup': () => j({}, 201),
      'POST /api/v1/session': () => j({}, 401),
    })
    const r = await setupAndSignIn(req, f)
    expect('state' in r && r.state.screen).toBe('signin')
    expect((f as any).mock.calls.filter((c: any[]) => c[0] === '/api/v1/setup')).toHaveLength(1)
  })
  it.each([
    [400, '12文字'],
    [401, 'セットアップトークン'],
  ])('shows an error for %i and stays on setup', async (status, text) => {
    const f = route({ 'POST /api/v1/setup': () => j({ error: 'x' }, status) })
    const r = await setupAndSignIn(req, f)
    expect('error' in r && r.error).toContain(text)
  })
  it('409 goes to signin', async () => {
    const f = route({ 'POST /api/v1/setup': () => j({ error: 'x' }, 409) })
    const r = await setupAndSignIn(req, f)
    expect('state' in r && r.state.screen).toBe('signin')
  })
})

describe('signOut', () => {
  it('true on 204 and 401, false on network error', async () => {
    expect(await signOut(route({ 'DELETE /api/v1/session': () => new Response(null, { status: 204 }) }))).toBe(true)
    expect(await signOut(route({ 'DELETE /api/v1/session': () => j({}, 401) }))).toBe(true)
    expect(await signOut(vi.fn().mockRejectedValue(new Error('n')))).toBe(false)
  })
})

describe('errorMessage', () => {
  it('distinguishes 400 wording between setup and signin', () => {
    const bad = { ok: false as const, kind: 'http' as const, status: 400 }
    expect(errorMessage(bad, 'setup')).toContain('12文字以上')
    const signin = errorMessage(bad, 'signin')
    expect(signin).not.toContain('12文字')
    expect(signin).toContain('入力内容を確認してください')
  })

  it('tells the user to wait before retrying on 429', () => {
    const throttled = { ok: false as const, kind: 'http' as const, status: 429 }
    expect(errorMessage(throttled, 'signin')).toContain('しばらく待ってから')
    expect(errorMessage(throttled, 'setup')).toContain('しばらく待ってから')
  })
})

describe('credentials', () => {
  it('never touches web storage', async () => {
    const s = vi.fn()
    vi.stubGlobal('localStorage', { setItem: s })
    vi.stubGlobal('sessionStorage', { setItem: s })
    await setupAndSignIn(req, route({
      'POST /api/v1/setup': () => j({}, 201),
      'POST /api/v1/session': () => j({ expires_in: 1, identity }),
    }))
    expect(s).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
