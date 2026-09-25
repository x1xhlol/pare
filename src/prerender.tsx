// Server entry for scripts/prerender.mjs: the landing page as HTML, so it's readable before any JavaScript runs.
import { renderToString } from 'react-dom/server'
import App from './App.tsx'

export function render() {
  return renderToString(<App />)
}
