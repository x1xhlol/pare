// Runs one ffmpeg.wasm command in Chrome on the served input and saves the output for research/score.py.
//   node run.mjs st|mt -c:v libx264 -preset faster -crf 19 -c:a copy
import { chromium } from 'playwright-core'
import fs from 'node:fs'
const [mt, ...args] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` })
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('pageerror', e.message))
await page.goto('http://localhost:4180/')
await page.waitForFunction(() => window.ready)
const r = await page.evaluate(([mt, args]) => window.run(mt === 'mt', args), [mt, args])
const data = await page.evaluate(async () => {
  const buf = new Uint8Array(await (await fetch(window.lastUrl)).arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
})
const out = `/tmp/bench/ffw-${mt}-${args.join('_').replace(/[^\w.-]/g, '')}.mp4`
fs.writeFileSync(out, Buffer.from(data, 'base64'))
console.log(JSON.stringify({ mt, args, ...r, output: out }))
await browser.close()
