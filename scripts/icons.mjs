// Renders the app icons in public/ from favicon.svg with Playwright's Chromium: 192 and 512 px as drawn, a full-bleed
// 180 px one for iOS (which rounds the corners itself), and a 512 px maskable one with the mark inside the safe zone.
//
//   node scripts/icons.mjs
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const mark = fs.readFileSync('public/favicon.svg', 'utf8')
const square = mark.replace(' rx="8"', '')
const maskable = square.replace(/(<rect width="32" height="32"[^>]*\/>)(.*)<\/svg>/,
  '$1<g transform="translate(16 16) scale(0.8) translate(-16 -16)">$2</g></svg>')
const icons = [
  ['icon-192.png', mark, 192],
  ['icon-512.png', mark, 512],
  ['apple-touch-icon.png', square, 180],
  ['icon-maskable-512.png', maskable, 512],
]

const chrome = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage()
for (const [name, svg, size] of icons) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`)
  await page.screenshot({ path: `public/${name}`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}
await browser.close()
