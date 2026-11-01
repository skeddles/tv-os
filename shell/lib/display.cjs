// Screen mode and app size, through Cage's output-management support (wlr-randr).
//
// Over this PC's HDMI port the TV reports 1360x768 as its preferred mode, so Cage
// starts there. We switch to 1920x1080 and apply a scale so apps (Firefox, Plex…)
// are readable from the couch. The launcher cancels the scale out with its zoom
// factor, so it keeps its 1920x1080 design.
const fs = require('node:fs')
const path = require('node:path')
const { paths, run } = require('./system.cjs')

const PREFS = path.join(paths.data, 'display.json')
const SCALES = [1, 1.25, 1.5, 1.75, 2]
const DEFAULT_SCALE = 1.5

function loadScale() {
  try {
    const s = Number(JSON.parse(fs.readFileSync(PREFS, 'utf8')).scale)
    if (SCALES.includes(s)) return s
  } catch {
    /* default */
  }
  return DEFAULT_SCALE
}

function saveScale(scale) {
  fs.mkdirSync(path.dirname(PREFS), { recursive: true })
  fs.writeFileSync(PREFS, JSON.stringify({ scale }))
}

/** Parse `wlr-randr` text output: [{ name, enabled, modes: [{ w, h, hz, text, current }] }] */
function parseOutputs(text) {
  const outputs = []
  let cur = null
  let inModes = false
  for (const line of text.split('\n')) {
    const head = line.match(/^(\S+)\s+"/)
    if (head) {
      cur = { name: head[1], enabled: false, modes: [] }
      outputs.push(cur)
      inModes = false
      continue
    }
    if (!cur) continue
    if (/^\s+Enabled:\s+yes/.test(line)) cur.enabled = true
    if (/^\s+Modes:/.test(line)) {
      inModes = true
      continue
    }
    const m = line.match(/^\s+(\d+)x(\d+) px, ([\d.]+) Hz(.*)$/)
    if (inModes && m) {
      cur.modes.push({ w: +m[1], h: +m[2], hz: +m[3], text: `${m[1]}x${m[2]}@${m[3]}Hz`, current: /current/.test(m[4]) })
    } else if (inModes && /^\s{2}\S/.test(line)) {
      inModes = false
    }
  }
  return outputs
}

function pickMode(modes) {
  const full = modes.filter((m) => m.w === 1920 && m.h === 1080).sort((a, b) => Math.abs(a.hz - 60) - Math.abs(b.hz - 60))
  return full[0] || null
}

/** Apply 1080p (if the TV offers it) and the given scale. Returns what was applied. */
async function apply(scale, log) {
  const r = await run('wlr-randr', [], { timeout: 10_000 })
  if (!r.ok) {
    log(`wlr-randr unavailable: ${r.stderr.trim() || r.stdout.trim()}`)
    return null
  }
  const out = parseOutputs(r.stdout).find((o) => o.enabled)
  if (!out) return null
  const mode = pickMode(out.modes)
  const args = ['--output', out.name, '--scale', String(scale)]
  if (mode && !mode.current) args.push('--mode', mode.text)
  const res = await run('wlr-randr', args, { timeout: 15_000 })
  log(`display ${out.name}: ${mode ? mode.text : 'mode unchanged'} at scale ${scale}${res.ok ? '' : ` FAILED: ${res.stderr.trim()}`}`)
  return res.ok ? { output: out.name, mode: mode && mode.text, scale } : null
}

module.exports = { SCALES, DEFAULT_SCALE, loadScale, saveScale, apply, parseOutputs, pickMode }
