// Serves index.html, the ffmpeg.wasm packages and INPUT (as /input.mp4) with the headers the multithreaded core needs.
//   bun install && INPUT=clip.mp4 bun serve.ts
const input = process.env.INPUT!
Bun.serve({
  port: 4180,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const file = path === '/input.mp4' ? Bun.file(input) : Bun.file(import.meta.dir + (path === '/' ? '/index.html' : path))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.wasm') ? 'application/wasm'
      : path.endsWith('.html') || path === '/' ? 'text/html' : 'application/octet-stream'
    return new Response(file, { headers: { 'Content-Type': type, 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' } })
  },
})
