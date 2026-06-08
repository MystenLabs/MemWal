import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(appDir, 'dist')
const distPrefix = `${distDir}${path.sep}`
const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'

const DEFAULT_RELAYER_URL = 'https://relayer.memory.walrus.xyz'
const DEFAULT_HEALTH_PATH = '/health'
const DEFAULT_TIMEOUT_MS = 8000

const contentTypes = new Map([
  ['', 'text/plain; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
])

const fileLikeRequestPattern = /\/[^/?#]+\.[^/?#]+$/

function getTimeoutMs() {
  const value = Number(process.env.STATUS_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(value) || value < 1000 || value > 30000) return DEFAULT_TIMEOUT_MS
  return Math.round(value)
}

function relayerBaseUrl() {
  return (
    process.env.STATUS_RELAYER_URL ||
    process.env.MEMWAL_SERVER_URL ||
    process.env.VITE_MEMWAL_SERVER_URL ||
    DEFAULT_RELAYER_URL
  ).trim()
}

function resolveHealthUrl() {
  const rawBase = relayerBaseUrl()
  const healthPath = (process.env.STATUS_HEALTH_PATH || DEFAULT_HEALTH_PATH).trim() || DEFAULT_HEALTH_PATH
  const url = new URL(rawBase)

  if (!process.env.STATUS_HEALTH_PATH && /\/health\/?$/.test(url.pathname)) {
    url.search = ''
    return url.toString()
  }

  const basePath = url.pathname.replace(/\/+$/, '')
  const nextPath = `${basePath}/${healthPath.replace(/^\/+/, '')}`
  url.pathname = nextPath.replace(/\/{2,}/g, '/')
  url.search = ''
  return url.toString()
}

function noStoreHeaders(contentType) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  }
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    ...noStoreHeaders('application/json; charset=utf-8'),
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendText(res, statusCode, body, cacheControl = 'no-store') {
  res.writeHead(statusCode, {
    'Cache-Control': cacheControl,
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function cacheControlFor(pathname, servingIndex) {
  if (servingIndex) return 'no-store'
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  return 'public, max-age=300, must-revalidate'
}

function resolveDistPath(pathname) {
  const relativePath = pathname.replace(/^\/+/, '')
  const resolved = path.resolve(distDir, relativePath)

  if (resolved !== distDir && !resolved.startsWith(distPrefix)) {
    return null
  }

  return resolved
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncateError(message) {
  if (!message) return 'Health check failed'
  return message.length > 500 ? `${message.slice(0, 500)}...` : message
}

async function probeRelayer() {
  const checkedAt = new Date().toISOString()
  const url = resolveHealthUrl()
  const startedAt = performance.now()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs())

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt))
    const text = await response.text()
    let health = null

    if (text) {
      try {
        const parsed = JSON.parse(text)
        health = isRecord(parsed) ? parsed : null
      } catch {
        health = null
      }
    }

    const reportedOk = isRecord(health) && health.status === 'ok'
    const status = response.ok ? (reportedOk ? 'operational' : 'degraded') : 'outage'

    return {
      name: 'Public relayer API',
      status,
      url,
      httpStatus: response.status,
      latencyMs,
      checkedAt,
      health,
      error: response.ok ? null : truncateError(text || response.statusText),
    }
  } catch (error) {
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt))
    const message = error?.name === 'AbortError'
      ? `Timed out after ${getTimeoutMs()} ms`
      : error?.message || String(error)

    return {
      name: 'Public relayer API',
      status: 'outage',
      url,
      httpStatus: null,
      latencyMs,
      checkedAt,
      health: null,
      error: truncateError(message),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function statusPayload() {
  const relayer = await probeRelayer()
  return {
    generatedAt: new Date().toISOString(),
    service: {
      name: 'Walrus Memory Status',
      status: 'operational',
      runtime: 'node',
    },
    relayer,
    dependencies: [
      {
        name: 'Sui network',
        status: 'monitoring',
        url: process.env.STATUS_SUI_STATUS_URL || 'https://status.sui.io/',
      },
      {
        name: 'Walrus storage',
        status: 'monitoring',
        url: process.env.STATUS_WALRUS_URL || 'https://www.walrus.xyz/',
      },
    ],
  }
}

async function serveFile(req, res, filePath, pathname, servingIndex = false) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) return false

  const ext = path.extname(filePath).toLowerCase()
  const contentType = contentTypes.get(ext) || 'application/octet-stream'

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControlFor(pathname, servingIndex),
    'Content-Length': fileStat.size,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  })

  if (req.method === 'HEAD') {
    res.end()
    return true
  }

  createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) {
        sendText(res, 500, 'Internal server error')
      } else {
        res.destroy()
      }
    })
    .pipe(res)

  return true
}

const server = createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method || '')) {
    res.writeHead(405, {
      Allow: 'GET, HEAD',
      ...noStoreHeaders('text/plain; charset=utf-8'),
    })
    res.end('Method not allowed')
    return
  }

  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
  } catch {
    sendText(res, 400, 'Bad request')
    return
  }

  if (pathname.includes('\0')) {
    sendText(res, 400, 'Bad request')
    return
  }

  if (pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'walrus-memory-status',
      generatedAt: new Date().toISOString(),
    })
    return
  }

  if (pathname === '/api/status') {
    try {
      sendJson(res, 200, await statusPayload())
    } catch (error) {
      console.error('[status-service] failed to build status payload', error)
      sendJson(res, 500, {
        generatedAt: new Date().toISOString(),
        service: { name: 'Walrus Memory Status', status: 'degraded' },
        error: 'Status service failed to build payload',
      })
    }
    return
  }

  const staticPath = resolveDistPath(pathname)
  if (!staticPath) {
    sendText(res, 403, 'Forbidden')
    return
  }

  try {
    if (await serveFile(req, res, staticPath, pathname)) return
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('[status-service] failed to serve file', { pathname, error })
      sendText(res, 500, 'Internal server error')
      return
    }
  }

  if (fileLikeRequestPattern.test(pathname)) {
    sendText(res, 404, 'Not found')
    return
  }

  try {
    if (!(await serveFile(req, res, path.join(distDir, 'index.html'), pathname, true))) {
      sendText(res, 500, 'Internal server error')
    }
  } catch (error) {
    console.error('[status-service] failed to serve SPA fallback', { pathname, error })
    sendText(res, 500, 'Internal server error')
  }
})

server.listen(port, host, () => {
  console.log(`[status-service] serving ${distDir} on http://${host}:${port}`)
  console.log(`[status-service] relayer health target: ${resolveHealthUrl()}`)
})
