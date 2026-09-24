// Serves the single-threaded ffmpeg core from our own origin so it loads without cross-origin isolation.
import { cpSync, mkdirSync } from 'node:fs'

const from = new URL('../node_modules/@ffmpeg/core/dist/esm/', import.meta.url)
const to = new URL('../public/ffmpeg/', import.meta.url)
mkdirSync(to, { recursive: true })
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) cpSync(new URL(name, from), new URL(name, to))
