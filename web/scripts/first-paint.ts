// Issue #345 first-paint and timeline-ready waterfall measurement.
// Reproducible one-line command from the repository root:
//   node web/scripts/first-paint.ts
import { execFileSync } from 'node:child_process'
import { createHash, randomInt, randomUUID, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { connect as tlsConnect, type DetailedPeerCertificate } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { chromium, request as pwRequest } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = resolve(process.env.FIRST_PAINT_OUT ?? join(tmpdir(), 'fukulow-345'))
const project = process.env.FIRST_PAINT_PROJECT ?? 'fukulow-fp345'
const runsPerCell = Number(process.env.FIRST_PAINT_RUNS ?? '10')
const warmupRuns = Number(process.env.FIRST_PAINT_WARMUP ?? '12')
const orgId = '00000000-0000-4000-8000-00000000000a'
// md5('chan-a-1')::uuid from load/hot-plans/seed.sql (100,000 Messages, 2,000 Topics)
const hotChannelId = '386df2c5-c664-ee3d-2a08-b1c9f0a0275c'
const memberEmail = 'm2@a.invalid'
const memberPassword = `fp345-test-only-${randomUUID()}`

// Exact CDP network profile: 150 ms RTT, 1.6 Mbps (200,000 B/s) down, 750 kbps (93,750 B/s) up.
const cdpThrottleProfile = {
  name: '150 ms RTT, 1.6 Mbps (200,000 B/s) down, 750 kbps (93,750 B/s) up',
  offline: false,
  latency: 150,
  downloadThroughput: 200_000,
  uploadThroughput: 93_750,
} as const
const viewport = { width: 1280, height: 800 } as const

type ApiTiming = {
  seq: number
  method: string
  path: string
  label: string
  start: number
  headersEnd: number
  end: number
  duration: number
  transferBytes: number
  status: number
  latestEndedBefore: string | null
  completedBeforeTimeline: boolean
}

type RunMetrics = {
  run: number
  ttfbMs: number
  htmlEndMs: number
  htmlTransferBytes: number
  fcpMs: number
  blankScreenMs: number
  jsEndMs: number
  cssEndMs: number
  assetsEndMs: number
  assetsTransferBytes: number
  appMountMs: number
  wsConnectStartMs: number
  wsOpenMs: number
  wsSubscribeSentMs: number
  wsSubscribedMs: number
  timelineVisibleMs: number
  timelinePaintedMs: number
  apiCalls: ApiTiming[]
  timingChain: string[]
}

type PercentilePair = { p50: number; p95: number }

type CellSummary = {
  pathLabel: '/' | '/o/:org/c/:channel'
  path: string
  network: 'unthrottled' | 'throttled'
  cache: 'cold' | 'warm'
  runs: number
  ttfbMs: PercentilePair
  fcpMs: PercentilePair
  blankScreenMs: PercentilePair
  assetsEndMs: PercentilePair
  jsEndMs: PercentilePair
  cssEndMs: PercentilePair
  appMountMs: PercentilePair
  wsSubscribedMs: PercentilePair
  timelineVisibleMs: PercentilePair
  assetsTransferBytes: PercentilePair
  htmlTransferBytes: PercentilePair
  apiByLabel: Record<
    string,
    {
      start: PercentilePair
      end: PercentilePair
      duration: PercentilePair
      transferBytes: PercentilePair
      latestEndedBefore: string | null
      completedBeforeTimelineCount: number
    }
  >
  timingChain: string[]
}

// Nearest rank: with 10 runs, p95 is the 10th value, i.e. the maximum of the cell.
function nearestRank(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1))
  return Number(sorted[index].toFixed(2))
}

function summarizeNumbers(values: number[]): PercentilePair {
  return { p50: nearestRank(values, 50), p95: nearestRank(values, 95) }
}

mkdirSync(outDir, { recursive: true })
const overridePath = join(outDir, 'compose.override.yml')
const dockerConfigDir = join(outDir, 'docker-config')
if (
  !process.env.DOCKER_CONFIG &&
  !existsSync(join(process.env.HOME ?? '', '.docker/cli-plugins')) &&
  existsSync('/Applications/Docker.app/Contents/Resources/cli-plugins')
) {
  mkdirSync(dockerConfigDir, { recursive: true })
  writeFileSync(
    join(dockerConfigDir, 'config.json'),
    JSON.stringify({ cliPluginsExtraDirs: ['/Applications/Docker.app/Contents/Resources/cli-plugins'] }),
  )
}
const image = `${project}-app`
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...(existsSync(dockerConfigDir) ? { DOCKER_CONFIG: dockerConfigDir } : {}),
  COMPOSE_PROJECT_NAME: project,
  POSTGRES_PASSWORD: `fp345-db-only-${randomUUID()}`,
  POSTGRES_APP_PASSWORD: `fp345-app-only-${randomUUID()}`,
  FUKULOW_SETUP_TOKEN: `fp345-setup-only-${randomUUID()}`,
  FUKULOW_COOKIE_SECURE: 'true',
  FUKULOW_DOMAIN: 'localhost',
  FUKULOW_EDGE_PREFIX: `10.${randomInt(192, 256)}.${randomInt(256)}`,
}
const composeFlags = ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'compose.yml', '-f', overridePath, '--profile', 'caddy']

function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  }).trim()
}

function dc(args: string[], input?: string): string {
  return docker([...composeFlags, ...args], input)
}

async function getServerSpkiHashes(port: number): Promise<string[]> {
  return await new Promise<string[]>((resolvePromise, rejectPromise) => {
    const socket = tlsConnect(
      { host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false },
      () => {
        const hashes = new Set<string>()
        let cert: DetailedPeerCertificate | undefined = socket.getPeerCertificate(true)
        while (cert && cert.raw) {
          const x509 = new X509Certificate(cert.raw)
          const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
          hashes.add(createHash('sha256').update(spkiDer).digest('base64'))
          if (!cert.issuerCertificate || cert.issuerCertificate === cert) break
          cert = cert.issuerCertificate
        }
        socket.end()
        resolvePromise([...hashes])
      },
    )
    socket.on('error', rejectPromise)
  })
}

writeFileSync(
  overridePath,
  `services:
  app:
    image: ${image}
  migrate:
    image: ${image}
  caddy:
    ports: !override
      - "127.0.0.1::443"
`,
)

async function measurePageLoad(
  context: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>,
  baseUrl: string,
  targetPath: string,
  cache: 'cold' | 'warm',
  network: 'unthrottled' | 'throttled',
  runNumber: number,
): Promise<RunMetrics> {
  const page = await context.newPage()
  try {
    await page.addInitScript(
      ({ expectedOrg, expectedChannel }) => {
        type RawApiCall = {
          seq: number
          method: string
          path: string
          label: string
          start: number
          headersEnd: number
          end: number | null
          status: number
          latestEndedBefore: string | null
          done: Promise<void>
        }
        const state = {
          appMountMs: null as number | null,
          fcpMs: null as number | null,
          timelineVisibleMs: null as number | null,
          timelinePaintedMs: null as number | null,
          wsConnectStartMs: null as number | null,
          wsOpenMs: null as number | null,
          wsSubscribeSentMs: null as number | null,
          wsSubscribedMs: null as number | null,
          apiCalls: [] as RawApiCall[],
        }
        Object.assign(window, { __fp345: state })

        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint' && state.fcpMs === null) {
              state.fcpMs = entry.startTime
            }
          }
        }).observe({ type: 'paint', buffered: true })

        const checkDom = () => {
          if (state.appMountMs === null) {
            const app = document.getElementById('app')
            if (app && app.childElementCount > 0) state.appMountMs = performance.now()
          }
          if (state.timelineVisibleMs === null) {
            const firstLine = document.querySelector('.timeline-list .timeline-list__item')
            if (firstLine) {
              state.timelineVisibleMs = performance.now()
              requestAnimationFrame(() => {
                if (state.timelinePaintedMs === null) state.timelinePaintedMs = performance.now()
              })
            }
          }
        }
        new MutationObserver(checkDom).observe(document, { childList: true, subtree: true })
        document.addEventListener('DOMContentLoaded', checkDom)

        const counts = new Map<string, number>()
        const normalizePath = (rawUrl: string): string => {
          const u = new URL(rawUrl, window.location.origin)
          return u.pathname
            .replaceAll(expectedOrg, '{org}')
            .replaceAll(expectedChannel, '{channel}')
        }

        const origFetch = window.fetch.bind(window)
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
          const path = normalizePath(rawUrl)
          if (!path.startsWith('/api/')) return origFetch(input, init)

          const start = performance.now()
          let latestPrior: RawApiCall | null = null
          for (const c of state.apiCalls) {
            if (c.end !== null && c.end <= start && (!latestPrior || c.end > (latestPrior.end ?? 0))) {
              latestPrior = c
            }
          }
          const baseKey = `${method} ${path}`
          const count = (counts.get(baseKey) ?? 0) + 1
          counts.set(baseKey, count)
          const label = count === 1 ? baseKey : `${baseKey} #${count}`
          let resolveDone = () => {}
          const done = new Promise<void>((r) => {
            resolveDone = r
          })
          const record: RawApiCall = {
            seq: state.apiCalls.length + 1,
            method,
            path,
            label,
            start,
            headersEnd: start,
            end: null,
            status: 0,
            latestEndedBefore: latestPrior ? latestPrior.label : null,
            done,
          }
          state.apiCalls.push(record)
          try {
            const response = await origFetch(input, init)
            record.headersEnd = performance.now()
            record.status = response.status
            const markEnd = () => {
              if (record.end === null) {
                record.end = performance.now()
                resolveDone()
              }
            }
            const origJson = response.json.bind(response)
            response.json = async () => {
              try {
                return await origJson()
              } finally {
                markEnd()
              }
            }
            const origText = response.text.bind(response)
            response.text = async () => {
              try {
                return await origText()
              } finally {
                markEnd()
              }
            }
            void response
              .clone()
              .arrayBuffer()
              .then(markEnd, markEnd)
            return response
          } catch (err) {
            record.end = performance.now()
            resolveDone()
            throw err
          }
        }

        const OrigWebSocket = window.WebSocket
        class TimedWebSocket extends OrigWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            if (state.wsConnectStartMs === null) state.wsConnectStartMs = performance.now()
            super(url, protocols)
            this.addEventListener('open', () => {
              if (state.wsOpenMs === null) state.wsOpenMs = performance.now()
            })
            this.addEventListener('message', (ev) => {
              if (typeof ev.data === 'string' && state.wsSubscribedMs === null) {
                try {
                  const parsed = JSON.parse(ev.data) as { type?: string }
                  if (parsed.type === 'subscribed') state.wsSubscribedMs = performance.now()
                } catch {
                  // ignore non-JSON
                }
              }
            })
          }
          override send(data: string | Blob | BufferSource) {
            if (typeof data === 'string' && state.wsSubscribeSentMs === null && data.includes('"subscribe"')) {
              state.wsSubscribeSentMs = performance.now()
            }
            super.send(data)
          }
        }
        window.WebSocket = TimedWebSocket
      },
      { expectedOrg: orgId, expectedChannel: hotChannelId },
    )

    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false })
    if (cache === 'cold') {
      await cdp.send('Network.clearBrowserCache')
    }
    if (network === 'throttled') {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: cdpThrottleProfile.offline,
        latency: cdpThrottleProfile.latency,
        downloadThroughput: cdpThrottleProfile.downloadThroughput,
        uploadThroughput: cdpThrottleProfile.uploadThroughput,
      })
    }

    await page.goto(`${baseUrl}${targetPath}`, { waitUntil: 'commit', timeout: 60_000 })
    await page.waitForFunction(
      () => {
        const s = (
          window as unknown as {
            __fp345?: {
              timelineVisibleMs: number | null
              wsSubscribedMs: number | null
              fcpMs: number | null
              timelinePaintedMs: number | null
            }
          }
        ).__fp345
        if (!s) return false
        if (s.fcpMs === null) {
          const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0]
          if (fcpEntry) s.fcpMs = fcpEntry.startTime
        }
        return Boolean(
          s.timelineVisibleMs !== null &&
            s.wsSubscribedMs !== null &&
            s.fcpMs !== null &&
            s.timelinePaintedMs !== null,
        )
      },
      undefined,
      { timeout: 60_000 },
    )

    const metrics = await page.evaluate(async (run) => {
      type RawApiCall = {
        seq: number
        method: string
        path: string
        label: string
        start: number
        headersEnd: number
        end: number | null
        status: number
        latestEndedBefore: string | null
        done: Promise<void>
      }
      const s = (
        window as unknown as {
          __fp345: {
            appMountMs: number
            fcpMs: number
            timelineVisibleMs: number
            timelinePaintedMs: number
            wsConnectStartMs: number
            wsOpenMs: number
            wsSubscribeSentMs: number
            wsSubscribedMs: number
            apiCalls: RawApiCall[]
          }
        }
      ).__fp345

      const startedBeforeTimeline = s.apiCalls.filter((c) => c.start <= s.timelineVisibleMs)
      await Promise.all(startedBeforeTimeline.map((c) => c.done))

      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      const jsResources = resources.filter((r) => r.name.includes('/assets/') && r.name.endsWith('.js'))
      const cssResources = resources.filter((r) => r.name.includes('/assets/') && r.name.endsWith('.css'))
      const jsEndMs = jsResources.length > 0 ? Math.max(...jsResources.map((r) => r.responseEnd)) : 0
      const cssEndMs = cssResources.length > 0 ? Math.max(...cssResources.map((r) => r.responseEnd)) : 0
      const assetsEndMs = Math.max(jsEndMs, cssEndMs)
      const assetsTransferBytes = [...jsResources, ...cssResources].reduce((sum, r) => sum + (r.transferSize ?? 0), 0)

      const usedResourceIndices = new Set<number>()
      const apiCalls: ApiTiming[] = startedBeforeTimeline.map((c) => {
        const end = c.end ?? performance.now()
        let transferBytes = 0
        for (let idx = 0; idx < resources.length; idx++) {
          if (usedResourceIndices.has(idx)) continue
          const r = resources[idx]
          const rPath = new URL(r.name, window.location.origin).pathname
            .replaceAll(
              (window as unknown as { __fpOrg?: string }).__fpOrg ?? '00000000-0000-4000-8000-00000000000a',
              '{org}',
            )
            .replaceAll(
              (window as unknown as { __fpChan?: string }).__fpChan ?? '386df2c5-c664-ee3d-2a08-b1c9f0a0275c',
              '{channel}',
            )
          if (rPath === c.path) {
            usedResourceIndices.add(idx)
            transferBytes = r.transferSize ?? 0
            break
          }
        }
        return {
          seq: c.seq,
          method: c.method,
          path: c.path,
          label: c.label,
          start: Number(c.start.toFixed(2)),
          headersEnd: Number(c.headersEnd.toFixed(2)),
          end: Number(end.toFixed(2)),
          duration: Number((end - c.start).toFixed(2)),
          transferBytes,
          status: c.status,
          latestEndedBefore: c.latestEndedBefore,
          completedBeforeTimeline: end <= s.timelineVisibleMs,
        }
      })

      // Time order only: each link is the latest API request that ended before the next one started.
      // It does not prove that a request waited for that response; actual dependencies come from the source.
      const byLabel = new Map(apiCalls.map((c) => [c.label, c]))
      const timelineCall = apiCalls.find((c) => c.path.endsWith('/timeline'))
      const chain: string[] = []
      let cursor: ApiTiming | undefined = timelineCall
      while (cursor) {
        chain.unshift(cursor.label)
        cursor = cursor.latestEndedBefore ? byLabel.get(cursor.latestEndedBefore) : undefined
      }

      return {
        run,
        ttfbMs: Number(nav.responseStart.toFixed(2)),
        htmlEndMs: Number(nav.responseEnd.toFixed(2)),
        htmlTransferBytes: nav.transferSize ?? 0,
        fcpMs: Number(s.fcpMs.toFixed(2)),
        blankScreenMs: Number(s.fcpMs.toFixed(2)),
        jsEndMs: Number(jsEndMs.toFixed(2)),
        cssEndMs: Number(cssEndMs.toFixed(2)),
        assetsEndMs: Number(assetsEndMs.toFixed(2)),
        assetsTransferBytes,
        appMountMs: Number(s.appMountMs.toFixed(2)),
        wsConnectStartMs: Number(s.wsConnectStartMs.toFixed(2)),
        wsOpenMs: Number(s.wsOpenMs.toFixed(2)),
        wsSubscribeSentMs: Number(s.wsSubscribeSentMs.toFixed(2)),
        wsSubscribedMs: Number(s.wsSubscribedMs.toFixed(2)),
        timelineVisibleMs: Number(s.timelineVisibleMs.toFixed(2)),
        timelinePaintedMs: Number(s.timelinePaintedMs.toFixed(2)),
        apiCalls,
        timingChain: chain,
      }
    }, runNumber)

    return metrics
  } finally {
    await page.close()
  }
}

function summarizeCell(
  pathLabel: '/' | '/o/:org/c/:channel',
  path: string,
  network: 'unthrottled' | 'throttled',
  cache: 'cold' | 'warm',
  runs: RunMetrics[],
): CellSummary {
  const labels = new Set<string>()
  for (const r of runs) {
    for (const c of r.apiCalls) labels.add(c.label)
  }
  const apiByLabel: CellSummary['apiByLabel'] = {}
  for (const label of labels) {
    const matching = runs.flatMap((r) => r.apiCalls.filter((c) => c.label === label))
    if (matching.length === 0) continue
    apiByLabel[label] = {
      start: summarizeNumbers(matching.map((m) => m.start)),
      end: summarizeNumbers(matching.map((m) => m.end)),
      duration: summarizeNumbers(matching.map((m) => m.duration)),
      transferBytes: summarizeNumbers(matching.map((m) => m.transferBytes)),
      latestEndedBefore: matching[0].latestEndedBefore,
      completedBeforeTimelineCount: matching.filter((m) => m.completedBeforeTimeline).length,
    }
  }
  return {
    pathLabel,
    path,
    network,
    cache,
    runs: runs.length,
    ttfbMs: summarizeNumbers(runs.map((r) => r.ttfbMs)),
    fcpMs: summarizeNumbers(runs.map((r) => r.fcpMs)),
    blankScreenMs: summarizeNumbers(runs.map((r) => r.blankScreenMs)),
    assetsEndMs: summarizeNumbers(runs.map((r) => r.assetsEndMs)),
    jsEndMs: summarizeNumbers(runs.map((r) => r.jsEndMs)),
    cssEndMs: summarizeNumbers(runs.map((r) => r.cssEndMs)),
    appMountMs: summarizeNumbers(runs.map((r) => r.appMountMs)),
    wsSubscribedMs: summarizeNumbers(runs.map((r) => r.wsSubscribedMs)),
    timelineVisibleMs: summarizeNumbers(runs.map((r) => r.timelineVisibleMs)),
    assetsTransferBytes: summarizeNumbers(runs.map((r) => r.assetsTransferBytes)),
    htmlTransferBytes: summarizeNumbers(runs.map((r) => r.htmlTransferBytes)),
    apiByLabel,
    timingChain: runs[0]?.timingChain ?? [],
  }
}

try {
  console.log(`Building and starting Compose stack (${project}, profile: caddy)...`)
  dc(['build', 'app'])
  dc(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120'])

  const portOutput = dc(['port', 'caddy', '443'])
  const port = portOutput.split(':').at(-1)!
  const baseUrl = `https://localhost:${port}`
  console.log(`Caddy HTTPS listening at ${baseUrl}`)

  const apiContext = await pwRequest.newContext({ baseURL: baseUrl, ignoreHTTPSErrors: true })
  try {
    for (let i = 0; i < 30; i++) {
      try {
        const res = await apiContext.get('/api/v1/health')
        if (res.ok() && (await res.text()) === 'ok') break
      } catch {
        // retry
      }
      if (i === 29) throw new Error('HTTPS health check did not succeed')
      await delay(1000)
    }

    // Obtain a server-generated Argon2 password hash via /api/v1/setup (same pattern as load/signin.ts),
    // then run load/hot-plans/seed.sql and copy the hash to m2@a.invalid.
    const setupRes = await apiContext.post('/api/v1/setup', {
      data: {
        organization_name: 'Bootstrap Seed',
        name: 'Bootstrap Owner',
        email: 'seed@example.invalid',
        password: memberPassword,
        setup_token: env.FUKULOW_SETUP_TOKEN,
      },
    })
    if (setupRes.status() !== 201) {
      throw new Error(`Initial setup failed with status ${setupRes.status()}`)
    }

    console.log('Seeding database with load/hot-plans/seed.sql (#325 dataset scale)...')
    const seedSql = readFileSync(join(root, 'load/hot-plans/seed.sql'), 'utf8')
    dc(['exec', '-T', 'db', 'psql', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1'], seedSql)
    dc([
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'fukulow',
      '-d',
      'fukulow',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `UPDATE accounts SET password_hash = (SELECT password_hash FROM accounts WHERE email = 'seed@example.invalid') WHERE email = '${memberEmail}';`,
    ])

    const signInRes = await apiContext.post('/api/v1/session', {
      data: { email: memberEmail, password: memberPassword },
    })
    if (signInRes.status() !== 200) {
      throw new Error(`Sign-in as ${memberEmail} failed with status ${signInRes.status()}`)
    }
    const storageState = await apiContext.storageState()

    const pgVersion = dc(['exec', '-T', 'db', 'psql', '-U', 'fukulow', '-d', 'fukulow', '-Atc', 'SHOW server_version'])
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const spkiHashes = await getServerSpkiHashes(Number(port))

    // Trust Caddy's ephemeral SPKI at the CertVerifier layer so Chromium's HTTP disk cache
    // stores immutable static assets just like a production CA-signed deployment.
    const browser = await chromium.launch({
      headless: true,
      args: [`--ignore-certificate-errors-spki-list=${spkiHashes.join(',')}`],
    })
    try {
      const directChannelPath = `/o/${orgId}/c/${hotChannelId}`
      const paths: Array<{ label: '/' | '/o/:org/c/:channel'; path: string }> = [
        { label: '/', path: '/' },
        { label: '/o/:org/c/:channel', path: directChannelPath },
      ]
      const networks: Array<'unthrottled' | 'throttled'> = ['unthrottled', 'throttled']

      console.log(`Running ${warmupRuns} warm-up navigations to stabilize PostgreSQL buffer/plan cache...`)
      const warmupMetrics: RunMetrics[] = []
      const warmupCtx = await browser.newContext({
        viewport,
        storageState,
      })
      try {
        for (let w = 1; w <= warmupRuns; w++) {
          warmupMetrics.push(await measurePageLoad(warmupCtx, baseUrl, '/', 'warm', 'unthrottled', w))
        }
      } finally {
        await warmupCtx.close()
      }

      const rawCells: Record<string, RunMetrics[]> = {}
      const summaries: CellSummary[] = []

      for (const net of networks) {
        for (const p of paths) {
          const coldRuns: RunMetrics[] = []
          const warmRuns: RunMetrics[] = []
          console.log(`Measuring path=${p.label} network=${net} (${runsPerCell} cold + ${runsPerCell} warm runs)...`)

          for (let i = 1; i <= runsPerCell; i++) {
            const context = await browser.newContext({
              viewport,
              storageState,
            })
            try {
              const cold = await measurePageLoad(context, baseUrl, p.path, 'cold', net, i)
              coldRuns.push(cold)
              const warm = await measurePageLoad(context, baseUrl, p.path, 'warm', net, i)
              warmRuns.push(warm)
            } finally {
              await context.close()
            }
          }

          const coldKey = `${p.label}|${net}|cold`
          const warmKey = `${p.label}|${net}|warm`
          rawCells[coldKey] = coldRuns
          rawCells[warmKey] = warmRuns
          summaries.push(summarizeCell(p.label, p.path, net, 'cold', coldRuns))
          summaries.push(summarizeCell(p.label, p.path, net, 'warm', warmRuns))
        }
      }

      const report = {
        measuredAt: new Date().toISOString(),
        commit: commitSha,
        host: {
          platform: platform(),
          release: release(),
          arch: arch(),
          cpuModel: cpus()[0]?.model ?? 'unknown',
          cpus: cpus().length,
          memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
          nodeVersion: process.version,
        },
        postgresVersion: pgVersion,
        dataset: {
          source: 'load/hot-plans/seed.sql',
          organizationId: orgId,
          memberEmail,
          visibleChannels: 50,
          publicChannels: 40,
          privateChannels: 10,
          openedChannelId: hotChannelId,
          openedChannelName: 'channel-1',
          openedChannelMessages: 100_000,
          openedChannelTopics: 2_000,
          otherChannelsMessagesEach: 2_000,
          membersInOrgA: 10_000,
        },
        cdpThrottleProfile,
        viewport,
        runsPerCell,
        warmupRuns,
        warmupTimelineDurationsMs: warmupMetrics.map(
          (m) => m.apiCalls.find((c) => c.path.endsWith('/timeline'))?.duration ?? null,
        ),
        summaries,
        rawCells,
      }

      const resultsPath = join(outDir, 'results.json')
      writeFileSync(resultsPath, JSON.stringify(report, null, 2))
      console.log(`Saved full measurement results to ${resultsPath}`)
    } finally {
      await browser.close()
    }
  } finally {
    await apiContext.dispose()
  }
} finally {
  console.log(`Tearing down Compose stack (${project})...`)
  try {
    dc(['down', '-v', '--remove-orphans'])
  } catch (err) {
    console.error('Failed to tear down compose stack:', err)
    process.exitCode = 1
  }
  try {
    docker(['image', 'rm', '-f', image])
  } catch {
    // ignore
  }
  rmSync(overridePath, { force: true })
  rmSync(dockerConfigDir, { recursive: true, force: true })
}
