import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = 4300 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: appDir,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverOutput = ''
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString()
})
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString()
})

function stopServer() {
  if (!server.killed) {
    server.kill('SIGTERM')
  }
}

async function waitForServer() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/`)
      if (response.ok) {
        return
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  throw new Error(`static server did not start:\n${serverOutput}`)
}

async function expectContentType(pathname, expectedType) {
  const response = await fetch(`${baseUrl}${pathname}`)
  const contentType = response.headers.get('content-type') || ''

  if (!response.ok || !contentType.includes(expectedType)) {
    throw new Error(`${pathname} expected ${expectedType}, got ${response.status} ${contentType}`)
  }
}

async function expectHead(pathname, expectedStatus, expectedType) {
  const response = await fetch(`${baseUrl}${pathname}`, { method: 'HEAD' })
  const contentType = response.headers.get('content-type') || ''

  if (response.status !== expectedStatus || !contentType.includes(expectedType)) {
    throw new Error(`HEAD ${pathname} expected ${expectedStatus} ${expectedType}, got ${response.status} ${contentType}`)
  }
}

try {
  await waitForServer()

  const assetFiles = await readdir(path.join(appDir, 'dist', 'assets'))
  const jsAsset = assetFiles.find((file) => file.endsWith('.js'))
  const cssAsset = assetFiles.find((file) => file.endsWith('.css'))

  if (!jsAsset || !cssAsset) {
    throw new Error('dist/assets is missing JS or CSS bundles')
  }

  await expectContentType('/', 'text/html')
  await expectContentType('/dashboard', 'text/html')
  await expectContentType(`/assets/${jsAsset}`, 'application/javascript')
  await expectContentType(`/assets/${cssAsset}`, 'text/css')
  await expectContentType('/walrus-signin-bg.png', 'image/png')
  await expectContentType('/walrus-memory-logo.svg', 'image/svg+xml')
  await expectContentType('/og-image.jpg', 'image/jpeg')
  await expectContentType('/walrus-memory-social-preview.jpg', 'image/jpeg')
  await expectContentType('/fonts/Ratch-Variable.ttf', 'font/ttf')
  await expectHead('/', 200, 'text/html')
  await expectHead('/walrus-signin-bg.png', 200, 'image/png')

  const missingAsset = await fetch(`${baseUrl}/missing-marketing-asset.png`)
  const missingText = await missingAsset.text()
  const missingCacheControl = missingAsset.headers.get('cache-control') || ''
  const missingContentType = missingAsset.headers.get('content-type') || ''

  if (
    missingAsset.status !== 404 ||
    missingText.includes('<div id="root">') ||
    !missingCacheControl.includes('no-store') ||
    missingContentType.includes('text/html')
  ) {
    throw new Error(
      `missing asset fallback is unsafe: ${missingAsset.status} ${missingContentType} ${missingCacheControl}`,
    )
  }

  console.log('[verify-static-server] static server returns real assets and no-store 404s for missing assets')
} finally {
  stopServer()
}
