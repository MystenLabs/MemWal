import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const PRELOAD_RELOAD_KEY = 'memwal:preload-error-reloaded-at'

const shouldUseLocalhost = import.meta.env.DEV && window.location.hostname === '127.0.0.1'

if (shouldUseLocalhost) {
  const port = window.location.port ? `:${window.location.port}` : ''
  window.location.replace(
    `${window.location.protocol}//localhost${port}${window.location.pathname}${window.location.search}${window.location.hash}`,
  )
}

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()

  const now = Date.now()
  const lastReloadAt = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) || 0)

  if (now - lastReloadAt > 10_000) {
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now))
    window.location.reload()
  }
})

if (!shouldUseLocalhost) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
