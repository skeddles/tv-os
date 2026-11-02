// Decides whether the app in front handles the controller itself, so mouse mode
// can turn on only where it's needed.
//
// In order:
//   1. Your choice for that app (hold the Xbox button to toggle; remembered).
//   2. Apps known to work with a controller (same list the App Store uses).
//   3. The app's Flathub listing says it supports a gamepad.
//   4. Watching the app: if any of its processes opens the controller's device
//      file, it reads the controller itself.
// Otherwise the app gets mouse mode.
const fs = require('node:fs')
const path = require('node:path')
const { paths } = require('./system.cjs')

const PREFS = path.join(paths.data, 'input-prefs.json')

// Keep in step with controllerFriendly in tv-launcher-ui/src/data/catalog.ts.
const KNOWN_CONTROLLER_APPS = new Set([
  'tv.plex.PlexHTPC',
  'rocks.shy.VacuumTube',
  'tv.kodi.Kodi',
  'org.jellyfin.JellyfinDesktop',
  'com.moonlight_stream.Moonlight',
  'org.libretro.RetroArch',
  'org.ppsspp.PPSSPP',
  'net.pcsx2.PCSX2',
  'org.DolphinEmu.dolphin-emu',
  'net.kuribo64.melonDS',
])

// Apps that never need mouse mode: games are played with the controller and
// there's nothing to point at. Holding the Xbox button acts like a press there, and
// an old remembered choice is ignored.
const NEVER_MOUSE_APPS = new Set(['org.libretro.RetroArch'])

/** True when mouse mode must stay off for this app (front key like 'flatpak:<id>'). */
function neverMouse(key) {
  return typeof key === 'string' && NEVER_MOUSE_APPS.has(key.replace(/^flatpak:/, ''))
}

function loadPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(PREFS, 'utf8'))
    return { overrides: p.overrides || {}, detected: p.detected || {} }
  } catch {
    return { overrides: {}, detected: {} }
  }
}

let prefs = loadPrefs()

function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(PREFS), { recursive: true })
    fs.writeFileSync(PREFS + '.tmp', JSON.stringify(prefs, null, 1))
    fs.renameSync(PREFS + '.tmp', PREFS)
  } catch {
    /* not fatal */
  }
}

function override(key) {
  return Object.prototype.hasOwnProperty.call(prefs.overrides, key) ? prefs.overrides[key] : undefined
}

function setOverride(key, mouseOn) {
  prefs.overrides[key] = mouseOn
  savePrefs()
}

function clearOverrides() {
  prefs.overrides = {}
  savePrefs()
}

/** Remember that an app was seen reading the controller, so next launch starts right. */
function rememberControllerApp(appId) {
  if (!prefs.detected[appId]) {
    prefs.detected[appId] = true
    savePrefs()
  }
}

// Browsers open the controller for web pages (the Gamepad API) whether or not
// the page you're on uses it, so for them "opened the controller" means nothing.
const BROWSER = /(firefox|chrom|brave|vivaldi|opera|librewolf|waterfox|floorp|zen|mullvad|torbrowser|epiphany|falkon|edge|qutebrowser)/i

function isBrowser(appId) {
  return BROWSER.test(appId)
}

function knownControllerApp(appId) {
  return KNOWN_CONTROLLER_APPS.has(appId) || (!isBrowser(appId) && Boolean(prefs.detected[appId]))
}

/** Device nodes of connected controllers: /dev/input/eventN marked as joysticks, plus /dev/input/jsN. */
function controllerNodes() {
  const nodes = new Set()
  let names = []
  try {
    names = fs.readdirSync('/sys/class/input')
  } catch {
    return nodes
  }
  for (const n of names) {
    if (/^js\d+$/.test(n)) {
      nodes.add(`/dev/input/${n}`)
      continue
    }
    if (!/^event\d+$/.test(n)) continue
    try {
      const dev = fs.readFileSync(`/sys/class/input/${n}/dev`, 'utf8').trim()
      if (/^E:ID_INPUT_JOYSTICK=1$/m.test(fs.readFileSync(`/run/udev/data/c${dev}`, 'utf8'))) nodes.add(`/dev/input/${n}`)
    } catch {
      /* gone */
    }
  }
  return nodes
}

/** PIDs of a running Flatpak app (systemd puts each in an app-flatpak-<id>-<n>.scope). */
function flatpakPids(appId) {
  const pids = []
  let entries = []
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return pids
  }
  const marker = `app-flatpak-${appId}-`
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue
    try {
      if (fs.readFileSync(`/proc/${e}/cgroup`, 'utf8').includes(marker)) pids.push(e)
    } catch {
      /* exited */
    }
  }
  return pids
}

// Flatpak's own processes inside an app's group.
const FLATPAK_HELPERS = new Set(['bwrap', 'xdg-dbus-proxy', 'flatpak-spawn'])
// Helper processes of browsers and Electron apps; the main process has none of these.
const HELPER_ARG = /(^|\s)(--type=|-contentproc\b)|zypak-helper/

/** From [{ pid, comm, cmdline, start }], the app's main process: not Flatpak's
 *  bwrap wrapper, not a browser helper process, and the oldest of the rest.
 *  (Chrome's helpers live in a second Flatpak sandbox, so "child of bwrap"
 *  isn't enough: that picked the network process too, which saves cookies.) */
function pickMain(procs) {
  const candidates = procs.filter((p) => !FLATPAK_HELPERS.has(p.comm) && !HELPER_ARG.test(p.cmdline))
  candidates.sort((x, y) => x.start - y.start || x.pid - y.pid)
  return candidates[0] || null
}

function procInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // "pid (comm) state ppid ..." - comm may contain spaces, so split at the last ')'
    const close = stat.lastIndexOf(')')
    const fields = stat.slice(close + 2).split(' ')
    return {
      pid: Number(pid),
      comm: stat.slice(stat.indexOf('(') + 1, close),
      cmdline: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '),
      start: Number(fields[19]), // starttime, field 22 of /proc/pid/stat
    }
  } catch {
    return null
  }
}

/** PID of the app's main process (to ask it to quit with SIGTERM), or null. */
function flatpakMainPid(appId) {
  const main = pickMain(flatpakPids(appId).map(procInfo).filter(Boolean))
  return main ? main.pid : null
}

/** True if any process of the app has a controller device open. */
function appUsesController(appId) {
  if (isBrowser(appId)) return false
  const nodes = controllerNodes()
  if (nodes.size === 0) return false
  for (const pid of flatpakPids(appId)) {
    let fds = []
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        if (nodes.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))) return true
      } catch {
        /* closed meanwhile */
      }
    }
  }
  return false
}

module.exports = {
  pickMain,
  flatpakMainPid,
  override,
  setOverride,
  clearOverrides,
  rememberControllerApp,
  knownControllerApp,
  appUsesController,
  isBrowser,
  flatpakPids,
  KNOWN_CONTROLLER_APPS,
  NEVER_MOUSE_APPS,
  neverMouse,
}
