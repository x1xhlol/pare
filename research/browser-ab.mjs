// A/B: encode the same file on two deployments; report wall time, size and the app's own quality readout.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
const [url, file, tag] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(url)
await page.setInputFiles('input[type=file]', file)
await page.waitForSelector('.settings')
const t0 = Date.now()
await page.click('button[type=submit]')
await page.waitForSelector('.result', { timeout: 900000 })
const seconds = (Date.now() - t0) / 1000
await page.waitForFunction(() => !document.querySelector('.result-quality .pending'), null, { timeout: 300000 })
const sizes = await page.textContent('.result-sizes')
const quality = await page.textContent('.result-quality')
const b64 = await page.evaluate(async () => {
  const buf = new Uint8Array(await (await fetch(document.querySelector('.result-actions a').href)).arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
})
fs.writeFileSync(`/tmp/pare/ab-${tag}.mp4`, Buffer.from(b64, 'base64'))
console.log(JSON.stringify({ tag, seconds, sizes, quality }))
await browser.close()
