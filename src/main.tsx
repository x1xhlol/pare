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
