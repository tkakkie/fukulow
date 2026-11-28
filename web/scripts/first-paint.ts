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
import {
  classifyChannelReads,
  summarizeReportChannelReads,
  type CapturedReadMark,
} from './read-reasons.ts'
import { summarizeCell, type ApiTiming, type CellSummary, type RunMetrics } from './first-paint-summary.ts'

export { summarizeCell, type ApiTiming, type CellSummary, type PercentileSummary, type RunMetrics } from './first-paint-summary.ts'

const external = process.env.FIRST_PAINT_EXTERNAL === '1'
const targetDomain = process.env.FIRST_PAINT_DOMAIN ?? 'localhost'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = resolve(process.env.FIRST_PAINT_OUT ?? join(tmpdir(), 'fukulow-345'))
const project = process.env.FIRST_PAINT_PROJECT ?? (external ? process.env.LOAD_PROJECT! : 'fukulow-fp345')
const profile = external ? process.env.LOAD_PROXY ?? 'caddy' : 'caddy'
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

export const DIRECTORY_API_PATH = '/api/v1/orgs/{org}/members'
export const AUTHOR_LOOKUP_API_PATH = '/api/v1/orgs/{org}/message-authors'

export type MilestoneProbe = {
  timelineVisibleMs: number | null
  firstNamedRowMs: number | null
  wsSubscribedMs: number | null
  fcpMs: number | null
  timelinePaintedMs: number | null
  apiCalls: ReadonlyArray<{ method: string; path: string }>
}

export function isPrimaryMilestonesReady(s: MilestoneProbe): boolean {
  return (
    s.timelineVisibleMs !== null &&
    s.wsSubscribedMs !== null &&
    s.fcpMs !== null &&
    s.timelinePaintedMs !== null
  )
}

export function isDiagnosticMilestonesReady(s: MilestoneProbe): boolean {
  const directoryStarted = s.apiCalls.some((c) => c.method === 'GET' && c.path === DIRECTORY_API_PATH)
  return s.firstNamedRowMs !== null && directoryStarted
}

export function findDiagnosticStarts(
  apiCalls: ReadonlyArray<{ method: string; path: string; start: number }>,
): { directoryStartMs: number | null; authorLookupStartMs: number | null } {
  const directoryCall = apiCalls.find((c) => c.method === 'GET' && c.path === DIRECTORY_API_PATH)
  const authorLookupCall = apiCalls.find((c) => c.method === 'POST' && c.path === AUTHOR_LOOKUP_API_PATH)
  return {
    directoryStartMs: directoryCall ? directoryCall.start : null,
    authorLookupStartMs: authorLookupCall ? authorLookupCall.start : null,
  }
}

export function resolveArmSourceSha(options: {
  prebuiltImage: string | undefined
  explicitSourceSha: string | undefined
  inspectImageRevision: () => string | null
  checkoutSha: string
}): string {
  const explicit = options.explicitSourceSha?.trim()
  if (explicit) return explicit
  const prebuilt = options.prebuiltImage?.trim()
  if (prebuilt) {
    const fromImage = options.inspectImageRevision()?.trim()
    if (fromImage && fromImage !== '<no value>') return fromImage
    throw new Error(
      `Prebuilt image "${prebuilt}" has no org.opencontainers.image.revision label; set FIRST_PAINT_SOURCE_SHA explicitly instead of falling back to the checkout SHA.`,
    )
  }
  return options.checkoutSha
}

export async function waitForPageMilestones(
  page: Pick<import('@playwright/test').Page, 'waitForFunction'>,
  options: { primaryTimeoutMs?: number; diagnosticTimeoutMs?: number } = {},
): Promise<number> {
  const primaryTimeoutMs = options.primaryTimeoutMs ?? 60_000
  const diagnosticTimeoutMs = options.diagnosticTimeoutMs ?? 5_000
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __fp345?: MilestoneProbe }).__fp345
      if (!s) return false
      if (s.fcpMs === null) {
        const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0]
        if (fcpEntry) s.fcpMs = fcpEntry.startTime
      }
      return (
        s.timelineVisibleMs !== null &&
        s.wsSubscribedMs !== null &&
        s.fcpMs !== null &&
        s.timelinePaintedMs !== null
      )
    },
    undefined,
    { timeout: primaryTimeoutMs },
  )
  // Record named-row and deferred directory diagnostics separately with one shared end-to-end
  // non-fatal budget so an unresolved sender or stalled directory response never blocks a usable FCP/Timeline sample.
  const diagnosticDeadline = Date.now() + diagnosticTimeoutMs
  try {
    await page.waitForFunction(
      (directoryPath) => {
        const s = (window as unknown as { __fp345?: MilestoneProbe }).__fp345
        if (!s) return false
        const directoryStarted = s.apiCalls.some((c) => c.method === 'GET' && c.path === directoryPath)
        return s.firstNamedRowMs !== null && directoryStarted
      },
      DIRECTORY_API_PATH,
      { timeout: Math.max(1, diagnosticDeadline - Date.now()) },
    )
  } catch {
    // Keep the usable FCP/Timeline sample even if diagnostics do not settle within the bounded wait.
  }
  return Math.max(0, diagnosticDeadline - Date.now())
}

export function installFirstPaintProbe({
  expectedOrg,
  expectedChannel,
}: {
  expectedOrg: string
  expectedChannel: string
}): void {
  type RawApiCall = {
    seq: number
    method: string
    path: string
    search: string
    readId: string | null
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
    firstNamedRowMs: null as number | null,
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

  const isVisibleRow = (el: Element): boolean => {
    if (
      el.closest(
        '[inert], [aria-busy="true"], [hidden], [aria-hidden="true"], .timeline-scroll--positioning, .topic-view__scroll--positioning',
      )
    ) {
      return false
    }
    if (typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(el)
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) {
        return false
      }
    }
    return true
  }

  const checkDom = () => {
    if (state.appMountMs === null) {
      const app = document.getElementById('app')
      if (app && app.childElementCount > 0) state.appMountMs = performance.now()
    }
    if (state.timelineVisibleMs === null) {
      const items = document.querySelectorAll('.timeline-list .timeline-list__item')
      if (Array.from(items).some(isVisibleRow)) {
        state.timelineVisibleMs = performance.now()
        requestAnimationFrame(() => {
          if (state.timelinePaintedMs === null) state.timelinePaintedMs = performance.now()
        })
      }
    }
    if (state.firstNamedRowMs === null) {
      const senders = document.querySelectorAll('.timeline-list .timeline-list__item .ui-message-row__sender')
      if (
        Array.from(senders).some((el) => {
          if (!isVisibleRow(el)) return false
          const text = (el.textContent ?? '').trim()
          return text.length > 0 && text !== 'メンバー'
        })
      ) {
        state.firstNamedRowMs = performance.now()
      }
    }
  }
  new MutationObserver(checkDom).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'inert', 'aria-busy', 'hidden', 'aria-hidden', 'style'],
  })
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
    const parsedUrl = new URL(rawUrl, window.location.origin)
    const path = normalizePath(rawUrl)
    if (!path.startsWith('/api/')) return origFetch(input, init)

    let readId: string | null = null
    try {
      const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined)
      if (headers !== undefined) readId = new Headers(headers).get('x-fukulow-read-id')
    } catch {
      readId = null
    }

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
      search: parsedUrl.search,
      readId,
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
}

export async function extractRunMetricsInPage(args: {
  run: number
  expectedOrg: string
  expectedChannel: string
  settleTimeoutMs: number
}): Promise<
  Omit<RunMetrics, 'directoryStartMs' | 'authorLookupStartMs' | 'channelReads'> & {
    channelReadMarks: CapturedReadMark[] | null
  }
> {
  type RawApiCall = {
    seq: number
    method: string
    path: string
    search?: string
    readId?: string | null
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
        firstNamedRowMs: number | null
        wsConnectStartMs: number
        wsOpenMs: number
        wsSubscribeSentMs: number
        wsSubscribedMs: number
        apiCalls: RawApiCall[]
      }
    }
  ).__fp345

  // Snapshot requests and read-reason marks at the exact same cutoff before the settle wait,
  // so labelled reads issued during the settle wait never become orphan marks.
  const trackedCalls = [...s.apiCalls]
  let channelReadMarks: CapturedReadMark[] | null = null
  try {
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByName === 'function') {
      channelReadMarks = performance.getEntriesByName('fukulow:read:channels', 'mark').map((entry) => {
        const detail = (entry as PerformanceMark).detail as { id?: unknown; reasons?: unknown } | null | undefined
        return {
          id: detail?.id ?? null,
          reasons: detail?.reasons ?? null,
        }
      })
    }
  } catch {
    channelReadMarks = null
  }
  if (args.settleTimeoutMs > 0 && trackedCalls.some((c) => c.end === null)) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(trackedCalls.map((c) => c.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, args.settleTimeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const jsResources = resources.filter((r) => r.name.includes('/assets/') && r.name.endsWith('.js'))
  const cssResources = resources.filter((r) => r.name.includes('/assets/') && r.name.endsWith('.css'))
  const wasmResources = resources.filter((r) => r.name.includes('/assets/') && r.name.endsWith('.wasm'))
  const jsEndMs = jsResources.length > 0 ? Math.max(...jsResources.map((r) => r.responseEnd)) : 0
  const cssEndMs = cssResources.length > 0 ? Math.max(...cssResources.map((r) => r.responseEnd)) : 0
  const wasmEndMs = wasmResources.length > 0 ? Math.max(...wasmResources.map((r) => r.responseEnd)) : 0
  const assetsEndMs = Math.max(jsEndMs, cssEndMs, wasmEndMs)
  const assetsTransferBytes = [...jsResources, ...cssResources, ...wasmResources].reduce(
    (sum, r) => sum + (r.transferSize ?? 0),
    0,
  )

  const usedResourceIndices = new Set<number>()
  const apiCalls: ApiTiming[] = trackedCalls.map((c) => {
    const end = c.end ?? performance.now()
    let transferBytes = 0
    for (let idx = 0; idx < resources.length; idx++) {
      if (usedResourceIndices.has(idx)) continue
      const r = resources[idx]
      const rPath = new URL(r.name, window.location.origin).pathname
        .replaceAll(args.expectedOrg, '{org}')
        .replaceAll(args.expectedChannel, '{channel}')
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
      search: c.search ?? '',
      readId: c.readId ?? null,
      label: c.label,
      start: Number(c.start.toFixed(2)),
      headersEnd: Number(c.headersEnd.toFixed(2)),
      end: Number(end.toFixed(2)),
      duration: Number((end - c.start).toFixed(2)),
      transferBytes,
      status: c.status,
      latestEndedBefore: c.latestEndedBefore,
      startedBeforeTimeline: c.start <= s.timelineVisibleMs,
      completedBeforeTimeline: c.end !== null && c.end <= s.timelineVisibleMs,
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
    run: args.run,
    ttfbMs: Number((nav?.responseStart ?? 0).toFixed(2)),
    htmlEndMs: Number((nav?.responseEnd ?? 0).toFixed(2)),
    htmlTransferBytes: nav?.transferSize ?? 0,
    fcpMs: Number(s.fcpMs.toFixed(2)),
    blankScreenMs: Number(s.fcpMs.toFixed(2)),
    jsEndMs: Number(jsEndMs.toFixed(2)),
    cssEndMs: Number(cssEndMs.toFixed(2)),
    wasmEndMs: Number(wasmEndMs.toFixed(2)),
    assetsEndMs: Number(assetsEndMs.toFixed(2)),
    assetsTransferBytes,
    appMountMs: Number(s.appMountMs.toFixed(2)),
    wsConnectStartMs: Number(s.wsConnectStartMs.toFixed(2)),
    wsOpenMs: Number(s.wsOpenMs.toFixed(2)),
    wsSubscribeSentMs: Number(s.wsSubscribeSentMs.toFixed(2)),
    wsSubscribedMs: Number(s.wsSubscribedMs.toFixed(2)),
    timelineVisibleMs: Number(s.timelineVisibleMs.toFixed(2)),
    timelinePaintedMs: Number(s.timelinePaintedMs.toFixed(2)),
    firstNamedRowMs: s.firstNamedRowMs !== null ? Number(s.firstNamedRowMs.toFixed(2)) : null,
    apiCalls,
    channelReadMarks,
    timingChain: chain,
  }
}

export async function collectRunMetrics(
  page: Pick<import('@playwright/test').Page, 'waitForFunction' | 'evaluate'>,
  options: {
    runNumber: number
    expectedOrg?: string
    expectedChannel?: string
    primaryTimeoutMs?: number
    diagnosticTimeoutMs?: number
  },
): Promise<RunMetrics> {
  const remainingDiagnosticMs = await waitForPageMilestones(page, {
    primaryTimeoutMs: options.primaryTimeoutMs,
    diagnosticTimeoutMs: options.diagnosticTimeoutMs,
  })
  const { channelReadMarks, ...rawMetrics } = await page.evaluate(extractRunMetricsInPage, {
    run: options.runNumber,
    expectedOrg: options.expectedOrg ?? orgId,
    expectedChannel: options.expectedChannel ?? hotChannelId,
    settleTimeoutMs: remainingDiagnosticMs,
  })
  const { directoryStartMs, authorLookupStartMs } = findDiagnosticStarts(rawMetrics.apiCalls)
  const channelReads = classifyChannelReads(rawMetrics.apiCalls, channelReadMarks)
  return {
    ...rawMetrics,
    directoryStartMs,
    authorLookupStartMs,
    channelReads,
  }
}

const overridePath = join(outDir, 'compose.override.yml')
const dockerConfigDir = join(outDir, 'docker-config')
const prebuiltImage = process.env.FIRST_PAINT_IMAGE?.trim()
const image = prebuiltImage || `${project}-app`
let env: NodeJS.ProcessEnv = { ...process.env }
const composeFlags: string[] = external ? JSON.parse(process.env.FIRST_PAINT_COMPOSE!) : ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'compose.yml', '-f', 'compose.dev.yml', '-f', overridePath, '--profile', 'caddy']

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
      { host: '127.0.0.1', port, servername: targetDomain, rejectUnauthorized: false },
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
    await page.addInitScript(installFirstPaintProbe, { expectedOrg: orgId, expectedChannel: hotChannelId })

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
    return await collectRunMetrics(page, {
      runNumber,
      expectedOrg: orgId,
      expectedChannel: hotChannelId,
    })
  } finally {
    await page.close()
  }
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true })
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
  env = {
    ...process.env,
    ...(existsSync(dockerConfigDir) ? { DOCKER_CONFIG: dockerConfigDir } : {}),
    COMPOSE_PROJECT_NAME: project,
    FUKULOW_VERSION: '0.0.0-dev', // compose.dev.yml and the override replace the release image
    POSTGRES_PASSWORD: `fp345-db-only-${randomUUID()}`,
    POSTGRES_APP_PASSWORD: `fp345-app-only-${randomUUID()}`,
    FUKULOW_SETUP_TOKEN: external ? process.env.FUKULOW_SETUP_TOKEN : `fp345-setup-only-${randomUUID()}`,
    FUKULOW_COOKIE_SECURE: 'true',
    FUKULOW_DOMAIN: 'localhost',
    FUKULOW_EDGE_PREFIX: `10.${randomInt(192, 256)}.${randomInt(256)}`,
  }
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const sourceSha = resolveArmSourceSha({
    prebuiltImage,
    explicitSourceSha: process.env.FIRST_PAINT_SOURCE_SHA,
    inspectImageRevision: () => {
      try {
        return docker(['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]) || null
      } catch {
        return null
      }
    },
    checkoutSha: commitSha,
  })
  if (!external) writeFileSync(
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

  try {
    const startMode = external ? 'Using disposable' : prebuiltImage ? `Starting prebuilt image ${image} in` : 'Building and starting'
    console.log(`${startMode} Compose stack (${project}, profile: ${profile})...`)
    if (!external) {
      if (!prebuiltImage) dc(['build', 'app'])
      dc(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120'])
    }

    const portOutput = external ? process.env.FIRST_PAINT_PORT! : dc(['port', 'caddy', '443'])
    const port = portOutput.split(':').at(-1)!
    const baseUrl = `https://${targetDomain}:${port}`
    console.log(`${profile} HTTPS listening at ${baseUrl}`)

    const apiContext = await pwRequest.newContext({ baseURL: external ? process.env.FIRST_PAINT_API : baseUrl, ignoreHTTPSErrors: true })
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
      // Provisioning uses the private app port; only timed navigations traverse TLS.
      if (external) for (const cookie of storageState.cookies) { cookie.domain = targetDomain; cookie.secure = true }

      const pgVersion = dc(['exec', '-T', 'db', 'psql', '-U', 'fukulow', '-d', 'fukulow', '-Atc', 'SHOW server_version'])
      let imageDigest = process.env.FIRST_PAINT_IMAGE_DIGEST?.trim() || null
      if (!imageDigest && (!external || prebuiltImage)) {
        try {
          imageDigest = docker(['image', 'inspect', '--format', '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}', image]) || null
        } catch {
          imageDigest = null
        }
      }
      const spkiHashes = await getServerSpkiHashes(Number(port))

      // Trust Caddy's ephemeral SPKI at the CertVerifier layer so Chromium's HTTP disk cache
      // stores immutable static assets just like a production CA-signed deployment.
      const browser = await chromium.launch({
        headless: true,
        args: [`--ignore-certificate-errors-spki-list=${spkiHashes.join(',')}`,
          ...(external ? [`--host-resolver-rules=MAP ${targetDomain} 127.0.0.1`] : [])],
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

        const channelReads = summarizeReportChannelReads(
          summaries.map((s) => ({ cell: `${s.pathLabel}|${s.network}|${s.cache}`, channelReads: s.channelReads })),
        )
        const report = {
          proxy: profile,
          baseUrl,
          measuredAt: new Date().toISOString(),
          commit: commitSha,
          sourceSha,
          image,
          imageDigest,
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
          channelReads,
          summaries,
          rawCells,
        }

        const resultsPath = join(outDir, 'results.json')
        writeFileSync(resultsPath, JSON.stringify(report, null, 2))
        if (channelReads.status === 'invalid') {
          console.warn(`Target 1 channelReads status: invalid (${channelReads.invalidCells.length} invalid cell(s))`)
        }
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
      if (!external) dc(['down', '-v', '--remove-orphans'])
    } catch (err) {
      console.error('Failed to tear down compose stack:', err)
      process.exitCode = 1
    }
    try {
      // A prebuilt image (FIRST_PAINT_IMAGE) is reused across interleaved rounds, so it is never removed here.
      if (!external && !prebuiltImage) docker(['image', 'rm', '-f', image])
    } catch {
      // ignore
    }
    rmSync(overridePath, { force: true })
    rmSync(dockerConfigDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main()
}
