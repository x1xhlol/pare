import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

// Preloads the Latin subsets of the two fonts above the fold, so text doesn't reflow when they arrive.
function preloadFonts(): Plugin {
  const wanted = [/^geist-latin-wght-normal/, /^geist-mono-latin-wght-normal/]
  return {
    name: 'preload-fonts',
    apply: 'build',
    transformIndexHtml(_, ctx) {
      const files = Object.keys(ctx.bundle ?? {}).filter((f) => f.endsWith('.woff2'))
      return wanted
        .map((re) => files.find((f) => re.test(f.split('/').pop()!)))
        .filter((f): f is string => !!f)
        .map((f) => ({
          tag: 'link',
          attrs: { rel: 'preload', href: `/${f}`, as: 'font', type: 'font/woff2', crossorigin: '' },
          injectTo: 'head' as const,
        }))
    },
  }
}

/** Files in public/ the page itself uses: the service worker caches them with the page. */
const PUBLIC_SHELL = ['/favicon.svg', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']

/**
 * Writes sw.js from sw/sw.js with this build's files: the page's own scripts, styles and Latin fonts to cache when it
 * installs, and every other asset (the encoders, workers and WebAssembly) to cache once a video is opened.
 */
function serviceWorker(): Plugin {
  let ssr = false
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved: (config) => void (ssr = !!config.build.ssr),
    generateBundle(_, bundle) {
      if (ssr) return
      const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry)
      if (!entry || entry.type !== 'chunk') throw new Error('No entry chunk to cache.')
      const fonts = Object.keys(bundle).filter((f) => /geist(-mono)?-latin-wght-normal/.test(f))
      const shell = [entry.fileName, ...(entry.viteMetadata?.importedCss ?? []), ...fonts].map((f) => `/${f}`)
      const assets = Object.keys(bundle).map((f) => `/${f}`).filter((f) => f.startsWith('/assets/') && !shell.includes(f))
      const template = fs.readFileSync('sw/sw.js', 'utf8')
      // The public files keep their names across versions, so their contents go into the version.
      const hash = createHash('sha256').update(template + shell.join() + assets.join())
      for (const file of PUBLIC_SHELL) hash.update(fs.readFileSync(`public${file}`))
      const version = hash.digest('hex').slice(0, 12)
      const source = template
        .replace('__VERSION__', JSON.stringify(version))
        .replace('__SHELL__', JSON.stringify([...shell, ...PUBLIC_SHELL]))
        .replace('__ASSETS__', JSON.stringify(assets))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

// Cross-origin isolation lets the encoder use SharedArrayBuffer, and with it x264's own threads.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

/**
 * The preview server answers revalidations with a bare 304, without the isolation headers, and Safari (WebKit) then
 * refuses the worker script it asked about. Vercel serves assets as immutable, so browsers there don't ask again.
 */
function noRevalidation(): Plugin {
  const strip = (req: { headers: Record<string, unknown> }) => {
    delete req.headers['if-none-match']
    delete req.headers['if-modified-since']
  }
  return {
    name: 'no-revalidation',
    configurePreviewServer: (server) => void server.middlewares.use((req, _res, next) => (strip(req), next())),
  }
}

export default defineConfig({
  plugins: [react(), preloadFonts(), noRevalidation(), serviceWorker()],
  worker: { format: 'es' },
  server: { headers: isolation },
  preview: { headers: isolation },
})
