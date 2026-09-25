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

export default defineConfig({
  plugins: [react(), preloadFonts()],
  worker: { format: 'es' },
})
