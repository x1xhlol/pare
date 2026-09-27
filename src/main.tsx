import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const root = document.getElementById('root')!
const app = (
  <StrictMode>
    <App />
  </StrictMode>
)
// Production builds ship the landing page as HTML (scripts/prerender.mjs); the dev server doesn't.
if (root.hasChildNodes()) hydrateRoot(root, app)
else createRoot(root).render(app)

// Offline use, installing, and videos shared to Pare (sw/sw.js). Not in development, where files change under it.
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}))
