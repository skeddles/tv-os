// Steam's own windows (Steam runs under Xwayland): is Big Picture open, and
// hiding Steam's desktop window.
//
// Why: Steam asks things before some games start (which launch option, "you're
// playing on another computer", ...). In Steam's desktop window those prompts
// need a mouse, and while one waits unanswered Steam ignores every later
// request to start that game. In Big Picture they work with the controller. So
// games are started with Big Picture open (tested on the TV, Nov 2026: the
// launch options of Sonic Generations, and Steam's "logged in on another
// computer" prompt, both showed in Big Picture).
//
// Closing Big Picture (steam://close/bigpicture) leaves Steam's desktop window
// showing. Closing that window breaks reopening Big Picture until Steam
// restarts (tested), so it is unmapped (hidden) instead; Big Picture then
// opens again normally.
const { execFileSync } = require('node:child_process')

const BIG_PICTURE = '"Steam Big Picture Mode"'
const DESKTOP = /^\s*(0x[0-9a-f]+) "Steam": \("steamwebhelper" "steam"\)/gim

function env() {
  return { ...process.env, DISPLAY: process.env.DISPLAY || ':0' }
}

function tree() {
  try {
    return execFileSync('xwininfo', ['-root', '-tree'], { env: env(), encoding: 'utf8', timeout: 3000 })
  } catch {
    return ''
  }
}

/** True while Steam's Big Picture window exists. */
function bigPictureOpen(text = tree()) {
  return text.includes(BIG_PICTURE)
}

/** Window ids of Steam's desktop (library/store) window. */
function desktopWindows(text = tree()) {
  return [...text.matchAll(DESKTOP)].map((m) => m[1])
}

/** Hide Steam's desktop window (Steam keeps running and downloading). */
function hideDesktopWindow() {
  for (const id of desktopWindows()) {
    try {
      const info = execFileSync('xwininfo', ['-id', id], { env: env(), encoding: 'utf8', timeout: 3000 })
      if (!/Map State:\s+IsViewable/.test(info)) continue
      execFileSync('xdotool', ['windowunmap', id], { env: env(), timeout: 3000 })
    } catch {
      /* gone already */
    }
  }
}

/** True when any X window big enough to be an app is showing (Steam, a game,
 *  a dialog). Tiny helper windows Steam and others keep around don't count.
 *  (xwininfo, not `xdotool search`: that missed Big Picture's window on the TV.) */
function otherWindowShowing(text = tree()) {
  for (const m of text.matchAll(/^\s*(0x[0-9a-f]+) .*?\)\s+(\d+)x(\d+)[+-]/gim)) {
    if (Number(m[2]) < 300 || Number(m[3]) < 200) continue
    try {
      const info = execFileSync('xwininfo', ['-id', m[1]], { env: env(), encoding: 'utf8', timeout: 3000 })
      if (/Map State:\s+IsViewable/.test(info)) return true
    } catch {
      /* gone */
    }
  }
  return false
}

module.exports = { bigPictureOpen, desktopWindows, hideDesktopWindow, otherWindowShowing }
