// Trims a video in Pare and saves the copy, for research/trimcheck.py:
//   URL=http://localhost:4173 FROM=2.37 TO=6.5 [PRESET='Exact copy'] [ENGINE=fast] [FIT=1] [BROWSER=webkit|firefox] \
//     node research/trim.mjs source.mp4 out.mp4
import { chromium, firefox, webkit } from 'playwright-core'
import fs from 'node:fs'

const [file, saved] = process.argv.slice(2)
const url = process.env.URL ?? 'http://localhost:4173'
const browser = process.env.BROWSER === 'webkit'
  ? await webkit.launch()
  : process.env.BROWSER === 'firefox'
    ? await firefox.launch()
    : await chromium.launch({ executablePath: process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const log = []
page.on('console', (m) => m.text().startsWith('[pare]') && log.push(m.text().slice(7)))
page.on('pageerror', (e) => log.push(`page error: ${e.message}`))
await page.goto(url)
await page.setInputFiles('input[type=file]', file)
await page.waitForSelector('.settings', { timeout: 60000 })
if (process.env.PRESET) await page.getByRole('radio', { name: process.env.PRESET, exact: true }).check()
if (process.env.FIT) {
  await page.getByRole('radio', { name: 'Fit under', exact: true }).check()
  await page.fill('.fit-field input', process.env.FIT)
}
if (process.env.ENGINE === 'fast') {
  if (!(await page.$('.more[open]'))) await page.click('.more summary')
  await page.getByRole('radio', { name: 'Fast', exact: true }).check()
}
if (process.env.FROM || process.env.TO) {
  await page.getByRole('radio', { name: 'Part of it', exact: true }).check()
  const [from, to] = await page.$$('.trim-field input')
  if (process.env.FROM) await from.fill(process.env.FROM)
  if (process.env.TO) await to.fill(process.env.TO)
  await to.press('Enter')
}
const state = await page.evaluate(() => ({
  fields: [...document.querySelectorAll('.trim-field input')].map((i) => i.value),
  hint: [...document.querySelectorAll('fieldset')].find((f) => f.querySelector('legend')?.textContent === 'Length')
    ?.querySelector('.choice-hint')?.textContent,
  problem: document.querySelector('#trim-problem')?.textContent,
}))
await page.waitForFunction(() => /Estimated size about/.test(document.querySelector('.estimate .sr-only')?.textContent ?? ''),
  null, { timeout: 600000 })
const estimate = (await page.textContent('.estimate-value')).trim()
const detail = (await page.textContent('.estimate-detail')).trim()
const clicked = Date.now()
await page.click('button[type=submit]')
await page.waitForSelector('.result, p.error[role=alert]', { timeout: 1800000 })
const failed = await page.$('p.error[role=alert]')
if (failed) {
  console.log(JSON.stringify({ failed: (await failed.textContent()).trim(), state, log }))
  process.exit(1)
}
const seconds = (Date.now() - clicked) / 1000
await page.waitForFunction(() => !document.querySelector('.result-quality .pending'), null, { timeout: 600000 })
const result = await page.evaluate(() => ({
  kicker: document.querySelector('.result-kicker')?.textContent,
  sizes: document.querySelector('.result-sizes')?.textContent,
  quality: document.querySelector('.result-quality')?.textContent,
  notes: [...document.querySelectorAll('.result .note, .result .error')].map((n) => n.textContent),
  name: document.querySelector('.result-actions a')?.getAttribute('download'),
}))
const data = await page.evaluate(async () => {
  const buf = new Uint8Array(await (await fetch(document.querySelector('.result-actions a').href)).arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
})
fs.writeFileSync(saved, Buffer.from(data, 'base64'))
console.log(JSON.stringify({ state, estimate, detail, seconds, result, bytes: fs.statSync(saved).size, log: log.slice(-4) }))
await browser.close()
