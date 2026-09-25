// Puts the server-rendered landing page into dist/index.html, then removes the server build.
import fs from 'node:fs'

const { render } = await import('../dist-ssr/prerender.js')
const html = fs.readFileSync('dist/index.html', 'utf8')
const filled = html.replace('<div id="root"></div>', `<div id="root">${render()}</div>`)
if (filled === html) throw new Error('dist/index.html has no empty #root to fill.')
fs.writeFileSync('dist/index.html', filled)
fs.rmSync('dist-ssr', { recursive: true, force: true })
console.log(`prerendered the landing page (${(filled.length / 1024).toFixed(1)} KB of HTML)`)
