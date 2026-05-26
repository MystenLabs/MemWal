import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env.PORT || 3000)
const MEMWAL_WEB_URL = process.env.MEMWAL_WEB_URL || 'http://localhost:5173'
const MEMWAL_API_URL = process.env.MEMWAL_API_URL || 'http://localhost:8000'
const STATIC_MEMWAL_CLIENT_ID = (process.env.MEMWAL_CLIENT_ID || '').trim()
const STATIC_MEMWAL_CLIENT_SECRET = (process.env.MEMWAL_CLIENT_SECRET || '').trim()
const APP_LABEL = process.env.APP_LABEL || 'Walrus Memory Demo App'
const APP_BASE_URL = normalizeAppBaseUrl(process.env.APP_BASE_URL)
const COOKIE_NAME = 'memwal_demo_state'

let dynamicClient = null
let dynamicClientPromise = null

function normalizeAppBaseUrl(raw) {
  if (!raw || !raw.trim()) return ''
  const url = new URL(raw)
  url.hash = ''
  url.search = ''
  url.pathname = ''
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('APP_BASE_URL must use https unless it is localhost')
  }
  return url.toString().replace(/\/$/, '')
}

function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseCookies(req) {
  const out = new Map()
  for (const pair of (req.headers.cookie || '').split(';')) {
    const [rawName, ...rawValue] = pair.trim().split('=')
    if (!rawName) continue
    out.set(rawName, decodeURIComponent(rawValue.join('=')))
  }
  return out
}

function requestOrigin(req) {
  if (APP_BASE_URL) return APP_BASE_URL
  const host = req.headers.host || `localhost:${PORT}`
  return `http://${host}`
}

function callbackUrl(req) {
  return `${requestOrigin(req)}/api/memwal/callback`
}

function errorUrl(req) {
  return `${requestOrigin(req)}/memwal/error`
}

function randomState() {
  return randomBytes(24).toString('base64url')
}

function sameState(left, right) {
  const a = Buffer.from(left || '')
  const b = Buffer.from(right || '')
  return a.length === b.length && timingSafeEqual(a, b)
}

function writeHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers })
  res.end()
}

function usesSecureCookies(req) {
  if (APP_BASE_URL) {
    return new URL(APP_BASE_URL).protocol === 'https:'
  }
  return requestOrigin(req).startsWith('https://')
}

function stateCookie(state, req) {
  const secure = usesSecureCookies(req) ? '; Secure' : ''
  return `${COOKIE_NAME}=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`
}

function modeLabel() {
  return APP_BASE_URL ? 'Deployed app' : 'Local app'
}

function configuredClientId() {
  return STATIC_MEMWAL_CLIENT_ID || dynamicClient?.client_id || 'auto-register on first connect'
}

function hasStaticClient() {
  return Boolean(STATIC_MEMWAL_CLIENT_ID && STATIC_MEMWAL_CLIENT_SECRET)
}

async function registerDynamicClient(req) {
  const response = await fetch(new URL('/api/app-auth/register', MEMWAL_API_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      display_name: APP_LABEL,
      redirect_uris: [callbackUrl(req)],
      fallback_uris: [errorUrl(req)],
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || `client registration failed (${response.status})`)
  }
  if (!payload.client_id || !payload.client_secret) {
    throw new Error('client registration did not return credentials')
  }
  return {
    origin: requestOrigin(req),
    client_id: payload.client_id,
    client_secret: payload.client_secret,
  }
}

async function appClient(req) {
  if (hasStaticClient()) {
    return {
      origin: requestOrigin(req),
      client_id: STATIC_MEMWAL_CLIENT_ID,
      client_secret: STATIC_MEMWAL_CLIENT_SECRET,
    }
  }

  const origin = requestOrigin(req)
  if (dynamicClient?.origin === origin) return dynamicClient

  if (!dynamicClientPromise || dynamicClientPromise.origin !== origin) {
    dynamicClientPromise = registerDynamicClient(req)
    dynamicClientPromise.origin = origin
  }
  dynamicClient = await dynamicClientPromise
  return dynamicClient
}

function page({ title, eyebrow, body, result, req }) {
  const resultHtml = result
    ? `<pre class="result">${htmlEscape(JSON.stringify(result, null, 2))}</pre>`
    : ''
  const callback = req ? callbackUrl(req) : `${requestOrigin({ headers: {} })}/api/memwal/callback`
  const fallback = req ? errorUrl(req) : `${requestOrigin({ headers: {} })}/memwal/error`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f3ff;
      --ink: #131018;
      --muted: #61566f;
      --line: #17121f;
      --panel: #fffdf7;
      --accent: #e8ff57;
      --accent-2: #c3a7ff;
      --danger: #d93838;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 28px clamp(20px, 5vw, 64px);
      border-bottom: 2px solid var(--line);
      background: var(--panel);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 850;
      font-size: 22px;
    }
    .mark {
      width: 32px;
      height: 32px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 3px;
    }
    .mark span { background: var(--line); }
    main {
      width: min(100%, 1040px);
      margin: 0 auto;
      padding: clamp(28px, 6vw, 72px) clamp(18px, 4vw, 40px);
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(280px, 0.9fr);
      gap: 32px;
      align-items: start;
    }
    h1 {
      margin: 0;
      max-width: 680px;
      font-size: clamp(42px, 7vw, 76px);
      line-height: 0.94;
      letter-spacing: 0;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 0 12px;
      margin-bottom: 18px;
      border: 2px solid var(--line);
      background: var(--accent-2);
      font-weight: 800;
    }
    .copy {
      margin: 22px 0 0;
      max-width: 620px;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.55;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 30px;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 50px;
      padding: 0 20px;
      border: 3px solid var(--line);
      border-radius: 8px;
      background: var(--accent);
      color: var(--ink);
      box-shadow: 5px 5px 0 var(--line);
      font-weight: 900;
      text-decoration: none;
    }
    .button.secondary {
      background: var(--panel);
      box-shadow: none;
    }
    .panel {
      border: 3px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 22px;
      box-shadow: 8px 8px 0 var(--line);
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 22px;
      letter-spacing: 0;
    }
    dl {
      margin: 0;
      display: grid;
      gap: 14px;
    }
    dt {
      color: var(--muted);
      font-size: 12px;
      font-weight: 850;
      text-transform: uppercase;
    }
    dd {
      margin: 4px 0 0;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
    }
    .result {
      margin: 18px 0 0;
      padding: 16px;
      overflow: auto;
      border: 2px solid var(--line);
      background: #f8f8f8;
      font-size: 13px;
      line-height: 1.45;
    }
    .error { color: var(--danger); font-weight: 850; }
    @media (max-width: 760px) {
      main { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; gap: 10px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand"><span class="mark" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span>Demo App</div>
    <strong>Third-party backend sample</strong>
  </header>
  <main>
    <section>
      <div class="eyebrow">${htmlEscape(eyebrow)}</div>
      ${body}
    </section>
    <aside class="panel">
      <h2>Config</h2>
      <dl>
        <div><dt>Mode</dt><dd>${htmlEscape(modeLabel())}</dd></div>
        <div><dt>App base URL</dt><dd>${htmlEscape(APP_BASE_URL || 'request host')}</dd></div>
        <div><dt>Client</dt><dd>${htmlEscape(configuredClientId())}</dd></div>
        <div><dt>Walrus Memory web</dt><dd>${htmlEscape(MEMWAL_WEB_URL)}</dd></div>
        <div><dt>Walrus Memory API</dt><dd>${htmlEscape(MEMWAL_API_URL)}</dd></div>
        <div><dt>Callback</dt><dd>${htmlEscape(callback)}</dd></div>
        <div><dt>Fallback</dt><dd>${htmlEscape(fallback)}</dd></div>
      </dl>
      ${resultHtml}
    </aside>
  </main>
</body>
</html>`
}

function home(req, res) {
  const previewClientId = STATIC_MEMWAL_CLIENT_ID || dynamicClient?.client_id
  const previewHref = previewClientId
    ? `${MEMWAL_WEB_URL}/connect/app?client_id=${encodeURIComponent(previewClientId)}&redirect_uri=${encodeURIComponent(callbackUrl(req))}&state=preview_state&label=${encodeURIComponent(APP_LABEL)}&intent=sdk_delegate&fallback_uri=${encodeURIComponent(errorUrl(req))}`
    : '/connect/memwal'
  const previewText = previewClientId ? 'Preview auth URL' : 'Register and preview'

  writeHtml(res, 200, page({
    title: 'Walrus Memory App Auth Demo',
    eyebrow: 'Local backend app',
    body: `
      <h1>Connect Walrus Memory from another app</h1>
      <p class="copy">This demo behaves like a third-party app with its own backend. It registers itself with Walrus Memory, sends the browser to hosted connect, then exchanges the returned one-time code server-side.</p>
      <div class="actions">
        <a class="button" href="/connect/memwal">Connect Walrus Memory</a>
        <a class="button secondary" href="${htmlEscape(previewHref)}">${htmlEscape(previewText)}</a>
      </div>
    `,
    req,
  }))
}

async function startConnect(req, res) {
  try {
    const client = await appClient(req)
    const state = randomState()
    const authUrl = new URL('/connect/app', MEMWAL_WEB_URL)
    authUrl.searchParams.set('client_id', client.client_id)
    authUrl.searchParams.set('redirect_uri', callbackUrl(req))
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('label', APP_LABEL)
    authUrl.searchParams.set('intent', 'sdk_delegate')
    authUrl.searchParams.set('fallback_uri', errorUrl(req))

    redirect(res, authUrl.toString(), {
      'set-cookie': stateCookie(state, req),
    })
  } catch (err) {
    writeHtml(res, 502, page({
      title: 'Walrus Memory client registration failed',
      eyebrow: 'Registration failed',
      body: `
        <h1 class="error">Client registration failed</h1>
        <p class="copy">${htmlEscape(err instanceof Error ? err.message : String(err))}</p>
        <div class="actions"><a class="button secondary" href="/">Back</a></div>
      `,
      req,
    }))
  }
}

async function handleCallback(req, res, url) {
  const cookies = parseCookies(req)
  const expectedState = cookies.get(COOKIE_NAME)
  const state = url.searchParams.get('state') || ''
  const code = url.searchParams.get('code') || ''

  if (!expectedState || !sameState(expectedState, state)) {
    writeHtml(res, 400, page({
      title: 'Walrus Memory callback failed',
      eyebrow: 'State mismatch',
      body: `
        <h1 class="error">State check failed</h1>
        <p class="copy">The callback did not match the state stored by this demo backend.</p>
        <div class="actions"><a class="button secondary" href="/">Back</a></div>
      `,
      req,
    }))
    return
  }

  if (!code) {
    writeHtml(res, 400, page({
      title: 'Walrus Memory callback missing code',
      eyebrow: 'Missing code',
      body: `
        <h1 class="error">No code returned</h1>
        <p class="copy">Walrus Memory did not return an authorization code.</p>
        <div class="actions"><a class="button secondary" href="/">Back</a></div>
      `,
      req,
    }))
    return
  }

  try {
    const client = await appClient(req)
    const tokenUrl = new URL('/api/app-auth/token', MEMWAL_API_URL)
    const auth = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl(req),
        state,
      }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload.error || `token exchange failed (${response.status})`)
    }

    writeHtml(res, 200, page({
      title: 'Walrus Memory connected',
      eyebrow: 'Connected',
      result: payload,
      body: `
        <h1>Walrus Memory connected</h1>
        <p class="copy">The browser only received a short-lived code. This backend exchanged it for account and delegate reference data.</p>
        <div class="actions"><a class="button secondary" href="/">Run again</a></div>
      `,
      req,
    }))
  } catch (err) {
    writeHtml(res, 502, page({
      title: 'Walrus Memory token exchange failed',
      eyebrow: 'Exchange failed',
      body: `
        <h1 class="error">Token exchange failed</h1>
        <p class="copy">${htmlEscape(err instanceof Error ? err.message : String(err))}</p>
        <div class="actions"><a class="button secondary" href="/">Back</a></div>
      `,
      req,
    }))
  }
}

function handleError(req, res, url) {
  writeHtml(res, 200, page({
    title: 'Walrus Memory connect cancelled',
    eyebrow: 'Walrus Memory returned an error',
    result: Object.fromEntries(url.searchParams.entries()),
    body: `
      <h1 class="error">Connect was not completed</h1>
      <p class="copy">Walrus Memory redirected to this safe fallback route with an error and the original state.</p>
      <div class="actions"><a class="button secondary" href="/">Back</a></div>
    `,
    req,
  }))
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', requestOrigin(req))
  if (req.method === 'GET' && url.pathname === '/') return home(req, res)
  if (req.method === 'GET' && url.pathname === '/connect/memwal') return void startConnect(req, res)
  if (req.method === 'GET' && url.pathname === '/api/memwal/callback') return void handleCallback(req, res, url)
  if (req.method === 'GET' && url.pathname === '/memwal/error') return handleError(req, res, url)

  writeHtml(res, 404, page({
    title: 'Not found',
    eyebrow: '404',
    body: `
      <h1 class="error">Not found</h1>
      <p class="copy">This demo route does not exist.</p>
      <div class="actions"><a class="button secondary" href="/">Back</a></div>
    `,
    req,
  }))
})

server.listen(PORT, () => {
  console.log(`Walrus Memory app-auth demo running at http://localhost:${PORT}`)
})
