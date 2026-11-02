// Pointer settings (Settings > Pointer speed / Pointer size), kept in pointer.json.
//  speed: how fast the controller's stick moves the pointer in mouse mode
//         (a real mouse's speed is set inside Cage, which has no setting for it)
//  size:  cursor size apps get through XCURSOR_SIZE when they start; the App
//         size setting scales it further. Applies to apps opened afterwards.
const fs = require('node:fs')
const path = require('node:path')
const { paths } = require('./system.cjs')

const FILE = path.join(paths.data, 'pointer.json')
const SPEEDS = [0.5, 0.75, 1, 1.5, 2]
const SIZES = [24, 32, 48, 64]
const DEFAULTS = { speed: 1, size: 32 }

function load() {
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return {
      speed: SPEEDS.includes(p.speed) ? p.speed : DEFAULTS.speed,
      size: SIZES.includes(p.size) ? p.size : DEFAULTS.size,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Merge a validated patch into the saved settings; returns the new settings. */
function save(patch) {
  const next = { ...load() }
  if (patch && patch.speed !== undefined) {
    if (!SPEEDS.includes(Number(patch.speed))) throw new Error('bad pointer speed')
    next.speed = Number(patch.speed)
  }
  if (patch && patch.size !== undefined) {
    if (!SIZES.includes(Number(patch.size))) throw new Error('bad pointer size')
    next.size = Number(patch.size)
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(next))
  return next
}

module.exports = { load, save, SPEEDS, SIZES }
