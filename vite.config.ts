import react from '@vitejs/plugin-react'
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
  plugins: [react(), preloadFonts(), noRevalidation()],
  worker: { format: 'es' },
  server: { headers: isolation },
  preview: { headers: isolation },
})
