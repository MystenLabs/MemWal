import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const PRELOAD_RELOAD_KEY = 'memwal:preload-error-reloaded-at'

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()

  const now = Date.now()
  const lastReloadAt = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) || 0)

  if (now - lastReloadAt > 10_000) {
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now))
    window.location.reload()
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
