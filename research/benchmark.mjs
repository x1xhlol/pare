// End-to-end benchmark in a real browser: open each video in Pare, click Compress a second after it loads (or once
// the plan is done with WAIT=1), and time the click to the finished file. Outputs are saved for research/score.py.
//
//   URL=http://localhost:4173 OUT=/tmp/bench TAG=now node research/benchmark.mjs clip.mp4 ...
//   CODEC=auto|avc|av1 (the Format setting; default Auto), ENGINE=fast (the browser's encoder), NOLIMIT=1 (no size
//   target), CORES=n (pretend core count)
//
// Prints one JSON line per video: seconds, sizes, the app's quality line, and the encoder log.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const url = process.env.URL ?? 'http://localhost:4173'
const out = process.env.OUT ?? '/tmp/bench'
const tag = process.env.TAG ?? 'run'
const codec = process.env.CODEC ?? 'auto'
const chrome = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`
fs.mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ executablePath: chrome, headless: true })
for (const file of process.argv.slice(2)) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  if (process.env.CORES)
    await page.addInitScript((n) => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }), +process.env.CORES)
  const log = []
  page.on('console', (m) => m.text().startsWith('[pare]') && log.push(m.text().slice(7)))
  page.on('pageerror', (e) => log.push(`page error: ${e.message}`))
  await page.goto(url)
  const loaded = Date.now()
  await page.setInputFiles('input[type=file]', file)
  await page.waitForSelector('.settings', { timeout: 60000 })
  if (process.env.NOLIMIT) await page.getByRole('radio', { name: 'No limit', exact: true }).check()
  if (process.env.ENGINE === 'fast') {
    if (!(await page.$('.more[open]'))) await page.click('.more summary')
    await page.getByRole('radio', { name: 'Fast', exact: true }).check()
  }
  if (codec !== 'auto' && process.env.ENGINE !== 'fast') {
    if (!(await page.$('.more[open]'))) await page.click('.more summary')
    await page.getByRole('radio', { name: codec === 'av1' ? 'AV1' : 'H.264', exact: true }).check()
  }
  if (process.env.WAIT === '1')
    await page.waitForFunction(() => !document.querySelector('.estimate-value.pending') &&
      !/testing AV1/.test(document.querySelector('.estimate-detail')?.textContent ?? ''), null, { timeout: 600000 })
  else await page.waitForTimeout(Math.max(0, 1000 - (Date.now() - loaded)))
  const estimate = (await page.textContent('.estimate-value')).trim()
  const clicked = Date.now()
  await page.click('button[type=submit]')
  await page.waitForSelector('.result', { timeout: 1800000 })
  const seconds = (Date.now() - clicked) / 1000
  const kicker = (await page.textContent('.result-kicker')).replace(/\s+/g, ' ').trim()
  await page.waitForFunction(() => !document.querySelector('.result-quality .pending'), null, { timeout: 600000 })
  const quality = (await page.textContent('.result-quality')).replace(/\s+/g, ' ').trim()
  const data = await page.evaluate(async () => {
    const buf = new Uint8Array(await (await fetch(document.querySelector('.result-actions a').href)).arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(s)
  })
  const saved = path.join(out, `${tag}-${path.basename(file)}.mp4`)
  fs.writeFileSync(saved, Buffer.from(data, 'base64'))
  console.log(JSON.stringify({
    tag, source: file, output: saved, seconds, estimate, kicker, quality,
    bytes: fs.statSync(saved).size, original: fs.statSync(file).size, log,
  }))
  await page.close()
}
await browser.close()
