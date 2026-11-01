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

/** From [{ pid, ppid, comm }], the app's own top processes: not bwrap (Flatpak's
 *  sandbox wrapper), with a parent that is bwrap or outside the app. */
function pickMains(procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  return procs.filter((p) => {
    if (p.comm === 'bwrap') return false
    const parent = byPid.get(p.ppid)
    return !parent || parent.comm === 'bwrap'
  })
}

function procInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // "pid (comm) state ppid ..." - comm may contain spaces, so split at the last ')'
    const close = stat.lastIndexOf(')')
    return { pid: Number(pid), comm: stat.slice(stat.indexOf('(') + 1, close), ppid: Number(stat.slice(close + 2).split(' ')[1]) }
  } catch {
    return null
  }
}

/** PIDs of the app's main process(es), for asking it to quit (SIGTERM). */
function flatpakMainPids(appId) {
  return pickMains(flatpakPids(appId).map(procInfo).filter(Boolean)).map((p) => p.pid)
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
  pickMains,
  flatpakMainPids,
  override,
  setOverride,
  clearOverrides,
  rememberControllerApp,
  knownControllerApp,
  appUsesController,
  isBrowser,
  flatpakPids,
  KNOWN_CONTROLLER_APPS,
}
