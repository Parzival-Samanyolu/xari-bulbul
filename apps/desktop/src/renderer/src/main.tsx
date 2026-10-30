import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { api } from './lib/api'
import './styles.css'

// Uncaught errors go to main for share info, which scrubs them and sends nothing while it's off.
const report = (kind: 'error' | 'rejection' | 'crash', e: unknown) => {
  const err = e instanceof Error ? e : null
  void api.app.reportError({ kind, message: err ? err.message : String(e), stack: err?.stack }).catch(() => {})
}
window.addEventListener('error', (e) => report('error', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => report('rejection', e.reason))

// Main passes the window's theme in the URL, so the loading screen paints in it before settings arrive.
const theme = new URLSearchParams(location.search).get('theme')
document.documentElement.dataset.theme = theme && /^(dark|light|oled|sepia|contrast)$/.test(theme) ? theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) => {
    console.error(error, info.componentStack)
    report('crash', error)
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
