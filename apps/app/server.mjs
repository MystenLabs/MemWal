import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(appDir, 'dist')
const distPrefix = `${distDir}${path.sep}`
const port = Number(process.env.PORT || 4173)
const host = process.env.HOST || '0.0.0.0'

const contentTypes = new Map([
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
  ['.ttf', 'font/ttf'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

const fileLikeRequestPattern = /\/[^/?#]+\.[^/?#]+$/

function cacheControlFor(pathname, servingIndex) {
  if (servingIndex) {
    return 'no-store'
  }

  if (pathname.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable'
  }

  if (pathname.startsWith('/fonts/')) {
    return 'public, max-age=86400, must-revalidate'
  }

  return 'public, max-age=300, must-revalidate'
}

function sendText(res, statusCode, body, cacheControl = 'no-store') {
  res.writeHead(statusCode, {
    'Cache-Control': cacheControl,
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function resolveDistPath(pathname) {
  const relativePath = pathname.replace(/^\/+/, '')
  const resolved = path.resolve(distDir, relativePath)

  if (resolved !== distDir && !resolved.startsWith(distPrefix)) {
    return null
  }

  return resolved
}

async function serveFile(req, res, filePath, pathname, servingIndex = false) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) {
    return false
  }

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
      'Allow': 'GET, HEAD',
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
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

  const staticPath = resolveDistPath(pathname)
  if (!staticPath) {
    sendText(res, 403, 'Forbidden')
    return
  }

  try {
    if (await serveFile(req, res, staticPath, pathname)) {
      return
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('[static-server] failed to serve file', { pathname, error })
      sendText(res, 500, 'Internal server error')
      return
    }
  }

  if (fileLikeRequestPattern.test(pathname)) {
    sendText(res, 404, 'Not found')
    return
  }

  const indexPath = path.join(distDir, 'index.html')
  try {
    if (!(await serveFile(req, res, indexPath, pathname, true))) {
      sendText(res, 500, 'Internal server error')
    }
  } catch (error) {
    console.error('[static-server] failed to serve SPA fallback', { pathname, error })
    sendText(res, 500, 'Internal server error')
  }
})

server.listen(port, host, () => {
  console.log(`[static-server] serving ${distDir} on http://${host}:${port}`)
})
