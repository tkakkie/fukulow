// Test-only ACME directory: omit optional ARI so ten-minute certificates use
// each client's lifetime-based schedule, rather than Pebble's random ARI window.
import { createServer } from 'node:http'
import { request } from 'node:https'
import { readFileSync } from 'node:fs'

export function lifetimeDirectory(body: string): string {
  const directory = JSON.parse(body)
  delete directory.renewalInfo
  return JSON.stringify(directory)
}

if (import.meta.main) {
  const ca = readFileSync('/etc/pebble-ca.pem') // public CA certificate only
  createServer((incoming, response) => {
    if (incoming.url !== '/dir' || incoming.method !== 'GET') {
      response.writeHead(404).end()
      return
    }
    const upstream = request('https://pebble:14000/dir', { ca, timeout: 2000 }, result => {
      let body = ''
      result.setEncoding('utf8')
      result.on('data', chunk => { body += chunk })
      result.on('end', () => {
        if (result.statusCode !== 200) { response.writeHead(503).end(); return }
        try { response.writeHead(200, { 'Content-Type': 'application/json' }).end(lifetimeDirectory(body)) }
        catch { response.writeHead(503).end() }
      })
      result.on('error', () => response.destroy())
    })
    upstream.on('timeout', () => upstream.destroy())
    upstream.on('error', () => response.writeHead(503).end())
    upstream.end()
  }).listen(14001, '127.0.0.1')
}
