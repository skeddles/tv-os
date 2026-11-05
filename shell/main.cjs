// TV launcher shell (Layer 3 in the plan).
//
// One full-screen window showing the launcher UI from the Vite dev server at
// http://localhost:5173 (falls back to the last working build if it's down).
// Web apps open as extra layers in the same window; native apps (Plex, Chrome,
// Steam games) are started as separate programs that Cage shows full screen.
//
// /usr/bin/tvlauncher-shell restarts this process if it exits, so "Restart
// launcher" is just app.exit().
//
// Controller outside the launcher (lib/input.cjs + input/tvlauncher-input.py):
//   Xbox button: home. Shortcuts anywhere are View + a button: View + D-pad
//   up/down = volume, View + X = mouse mode on/off for the app in front,
//   View + Y = the launcher's keyboard, typed into the app in front.
//   Mouse mode turns on by itself for apps that don't read the controller
//   (lib/appsupport.cjs). Clicking a text field in another app opens the
//   launcher's keyboard (via the accessibility bus) and the text is typed into the app.

const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { paths, run, readText, exists } = require('./lib/system.cjs')
const steam = require('./lib/steam.cjs')
const flatpak = require('./lib/flatpak.cjs')
const store = require('./lib/store.cjs')
const { InputHelper } = require('./lib/input.cjs')
const support = require('./lib/appsupport.cjs')
const steamproc = require('./lib/steamproc.cjs')
const steamui = require('./lib/steamui.cjs')
const { OsUpdate } = require('./lib/osupdate.cjs')
const pointerPrefs = require('./lib/pointerprefs.cjs')
const { Plex } = require('./lib/plex.cjs')
const itchGame = require('./lib/itchgame.cjs')
const display = require('./lib/display.cjs')
const { startControlServer } = require('./lib/control.cjs')

const DEV_URL = process.env.TVLAUNCHER_DEV_URL || 'http://localhost:5173/'
const FALLBACK_URL = 'tvapp://ui/index.html'
const MAX_WEB_LAYERS = 3

function log(msg) {
  console.log(`[shell] ${msg}`)
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'tvapp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/** @type {BrowserWindow | null} */
let win = null
let uiSource = 'fallback-build'
let fallbackTimer = null

/** Web app layers, most recently used last. */
const layers = [] // { origin, view }
let visibleLayer = null

/** The native app currently in front, if we can close it. */
let native = null // { child, label, appId }
// The Steam game (or Big Picture, appId null) last opened from the launcher.
let steamApp = null // { appId, label, started, seen, bigPicture }
// System image updates (Settings > System update); events go to the launcher.
const osUpdate = new OsUpdate((state) => send({ type: 'os-update', state }), (m) => log(m))

/**
 * What's in front: { kind: 'launcher' } | { kind: 'web', key, label }
 * | { kind: 'native', key, label, appId, usesController, readingController?, manual? } | { kind: 'steam', key, label }
 */
let front = { kind: 'launcher' }
let typing = null // { front, webLayer } while the keyboard is up for another app
let mouseOn = false
let scale = display.loadScale() // the App size setting
// What the screen is set to now: `scale`, or 1 while a game runs that would
// otherwise only see part of the screen (see gameScreen below).
let appliedScale = null
let pointer = pointerPrefs.load()
process.env.XCURSOR_SIZE = String(pointer.size) // apps started from here inherit it
const input = new InputHelper(log)
const a11y = new InputHelper(log, 'tvlauncher-a11y.py')
let lastClick = 0 // when A was last pressed in mouse mode
const CLICK_TO_FOCUS_MS = 1500

function send(event) {
  if (win && !win.isDestroyed()) win.webContents.send('tv:event', event)
}

// ---------- serving the fallback UI, icons and Steam artwork ----------

function fallbackDir() {
  for (const d of [paths.uiLastGood, paths.uiBaked]) if (exists(path.join(d, 'index.html'))) return d
  return null
}

function serveFile(file) {
  if (!file) return new Response('not found', { status: 404 })
  return net.fetch(pathToFileURL(file).toString())
}

const plex = new Plex((u, init) => net.fetch(u, init), (m) => log(m))
const PLEX_APP = 'tv.plex.PlexHTPC'

/** Start a Plex item in Plex HTPC: open the app if needed (and wait until it has
 *  connected to the server), then send it the item. */
async function playOnPlex(ratingKey, label) {
  const running = support.flatpakPids(PLEX_APP).length > 0
  if (!running) {
    spawnApp('flatpak', ['run', PLEX_APP], 'Plex', PLEX_APP)
  } else {
    // Already open behind the launcher: track it and step aside so it shows.
    if (!native || native.appId !== PLEX_APP) {
      native = { child: null, label: 'Plex', appId: PLEX_APP, started: Date.now(), seen: true, starterExited: true }
    }
    setFront({ kind: 'native', key: `flatpak:${PLEX_APP}`, label: 'Plex', appId: PLEX_APP, usesController: support.knownControllerApp(PLEX_APP) })
  }
  // A freshly started Plex needs a few seconds before it takes commands.
  const until = Date.now() + (running ? 8000 : 45000)
  let lastError = null
  while (Date.now() < until) {
    try {
      await plex.play(ratingKey)
      log(`plex: playing ${label}`)
      if (running && win && !win.isDestroyed()) win.hide()
      return
    } catch (e) {
      lastError = e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  log(`plex: couldn't start ${label}: ${lastError && lastError.message}`)
  send({ type: 'notice', message: `Couldn't start ${label} in Plex` })
  if (running && win && !win.isDestroyed()) win.hide() // show Plex anyway
}

function registerProtocol() {
  protocol.handle('tvapp', (req) => {
    const url = new URL(req.url)
    const rest = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (url.host === 'ui') {
      const dir = fallbackDir()
      if (!dir) return new Response('no fallback build', { status: 404 })
      const file = path.resolve(dir, rest || 'index.html')
      if (!file.startsWith(dir + path.sep)) return new Response('forbidden', { status: 403 })
      return serveFile(exists(file) ? file : null)
    }
    if (url.host === 'icon') return serveFile(flatpak.findIcon(rest))
    if (url.host === 'plex-image') return plex.image(url.searchParams.get('path') || '').catch(() => new Response('', { status: 502 }))
    if (url.host === 'steam' && /^\d+$/.test(rest)) {
      const root = steam.steamRoot()
      return serveFile(root ? steam.findArtwork(root, rest) : null)
    }
    return new Response('not found', { status: 404 })
  })
}

// ---------- loading the UI ----------

async function devServerUp() {
  try {
    const res = await net.fetch(DEV_URL, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function loadUi() {
  if (!win) return
  clearInterval(fallbackTimer)
  if (await devServerUp()) {
    uiSource = 'dev-server'
    await win.loadURL(DEV_URL).catch(() => loadFallback())
    return
  }
  await loadFallback()
}

async function loadFallback() {
  if (!win) return
  uiSource = 'fallback-build'
  await win.loadURL(FALLBACK_URL).catch((e) => console.error('[shell] fallback failed', e))
  // Switch to the live UI as soon as the dev server answers.
  clearInterval(fallbackTimer)
  fallbackTimer = setInterval(async () => {
    if (await devServerUp()) loadUi()
  }, 5000)
}

async function waitForDevServer(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await devServerUp()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    frame: false,
    backgroundColor: '#111316',
    // Shown immediately: on Wayland (Cage) a hidden window never paints, so
    // 'ready-to-show' never fires. The dark background avoids a white flash.
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  win.webContents.on('did-finish-load', () => {
    log(`loaded ${win.webContents.getURL()} (${uiSource})`)
    applyZoom()
  })
  win.on('focus', () => {
    launcherFocused = true
    refocusTried = false
  })
  win.on('blur', () => {
    launcherFocused = false
  })
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') log(`page error: ${e.message}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && url.startsWith(DEV_URL)) {
      log(`dev server failed to load: ${desc}`)
      loadFallback()
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`renderer gone: ${details.reason}; reloading`)
    setTimeout(loadUi, 1000)
  })
  // Links that try to open new windows open as a web layer instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) openWeb(url)
    return { action: 'deny' }
  })
  win.on('resize', () => {
    if (visibleLayer) visibleLayer.view.setBounds(fullBounds())
  })
}

// ---------- web app layers ----------

function fullBounds() {
  const [width, height] = win.getContentSize()
  return { x: 0, y: 0, width, height }
}

function openWeb(url, userAgent, label) {
  const origin = new URL(url).origin
  let layer = layers.find((l) => l.origin === origin)
  if (layer) {
    layers.splice(layers.indexOf(layer), 1)
  } else {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'webview-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        partition: 'persist:webapps',
      },
    })
    view.setBackgroundColor('#000000')
    if (userAgent) view.webContents.setUserAgent(userAgent)
    view.webContents.setWindowOpenHandler(({ url: u }) => {
      view.webContents.loadURL(u)
      return { action: 'deny' }
    })
    view.webContents.loadURL(url)
    layer = { origin, view, label: label || new URL(url).hostname }
  }
  layers.push(layer)
  // Keep the last few alive like tabs; close the oldest.
  while (layers.length > MAX_WEB_LAYERS) {
    const old = layers.shift()
    if (old === visibleLayer) visibleLayer = null
    win.contentView.removeChildView(old.view)
    old.view.webContents.close()
  }
  if (visibleLayer && visibleLayer !== layer) win.contentView.removeChildView(visibleLayer.view)
  layer.view.setBounds(fullBounds())
  win.contentView.addChildView(layer.view)
  layer.view.webContents.focus()
  visibleLayer = layer
  setFront({ kind: 'web', key: `web:${origin}`, label: layer.label })
}

function hideWeb() {
  if (!visibleLayer) return false
  win.contentView.removeChildView(visibleLayer.view)
  visibleLayer = null
  win.webContents.focus()
  send({ type: 'web-closed' })
  setFront({ kind: 'launcher' })
  return true
}

// ---------- native apps ----------

/** opts.key / opts.usesController: for a game run inside another app's Flatpak
 *  (itch games), so it gets its own mouse mode setting. */
function spawnApp(cmd, args, label, appId, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  const app = { child, label, appId, started: Date.now(), seen: false, starterExited: false }
  native = app
  setFront({
    kind: 'native',
    key: opts.key || `flatpak:${appId}`,
    label,
    appId,
    usesController: opts.usesController ?? support.knownControllerApp(appId),
  })
  if (!opts.key) checkAppStream(appId)
  child.on('error', (e) => send({ type: 'notice', message: `Couldn't open ${label}: ${e.message}` }))
  // `flatpak run` can exit while the app keeps running (seen with Firefox), so
  // the app counts as running while its own processes exist (watchApps below).
  child.on('exit', () => {
    app.starterExited = true
  })
}

function appClosed(app) {
  if (native !== app) return
  native = null
  if (typing) endTyping(null)
  setFront({ kind: 'launcher' })
  showLauncher()
  send({ type: 'app-exited', label: app.label })
  log(`${app.label} closed`)
}

setInterval(() => {
  watchSteam()
  const app = native
  if (!app || !app.appId) return
  const running = support.flatpakPids(app.appId).length > 0
  if (running) {
    app.seen = true
  } else if (app.seen) {
    appClosed(app)
  } else if (app.starterExited && Date.now() - app.started > 20_000) {
    log(`${app.label} never started`)
    appClosed(app)
  }
}, 1500)

// ---------- Steam ----------
//
// Steam runs all the time, quietly in the background, so downloads finish
// (it only downloads while it runs). Games start with Big Picture open, where
// Steam's prompts before a game (launch options, "playing on another
// computer"...) work with the controller; see lib/steamui.cjs.

function steamSpawn(args) {
  spawn('steam', args, { detached: true, stdio: 'ignore' }).unref()
}

const STEAM_BACKGROUND_DELAY_MS = 30_000 // after the launcher is up
let steamWasRunning = false
function keepSteamRunning() {
  const running = steamproc.clientRunning()
  if (!running) {
    log(steamWasRunning ? 'Steam stopped; starting it again in the background' : 'starting Steam in the background (for downloads)')
    steamSpawn(['-silent'])
  }
  steamWasRunning = true
}
setTimeout(() => {
  keepSteamRunning()
  setInterval(keepSteamRunning, 60_000)
}, STEAM_BACKGROUND_DELAY_MS)
// Steam's desktop window is never wanted on the TV (it shows when Big Picture
// closes, and sometimes on its own): keep it hidden.
setInterval(() => {
  steamui.hideDesktopWindow()
  checkLauncherFocus()
}, 3000)

// The launcher ignores the controller while another window has the focus (the
// launcher page pauses itself on blur). When a window the launcher didn't open
// goes away (Big Picture opened by Steam itself, a dialog), Cage doesn't give
// the focus back, and the launcher stayed deaf until the Xbox button (seen on
// the TV, Nov 2026). So: launcher in front, unfocused, and nothing else
// showing -> take the focus back (once per time it loses it).
let launcherFocused = true
let refocusTried = false
function checkLauncherFocus() {
  if (!win || win.isDestroyed() || launcherFocused || refocusTried) return
  if (front.kind !== 'launcher' || typing || steamApp) return
  if (steamui.otherWindowShowing()) return
  refocusTried = true
  log('launcher lost the focus with nothing in front of it; taking it back')
  raiseLauncher()
  send({ type: 'home' }) // the page: the controller is for the launcher again
}

function startSteam(appId, label) {
  steamApp = { appId, label, started: Date.now(), seen: false, bigPicture: false }
  native = null
  setFront({ kind: 'steam', key: `steam:${appId || 'bigpicture'}`, label, appId })
  return steamApp
}

/** Open Big Picture (if it isn't) and start the game from there. */
async function startSteamGame(appId, s) {
  if (!steamui.bigPictureOpen()) {
    steamSpawn(['steam://open/bigpicture'])
    s.bigPicture = true
    const until = Date.now() + 60_000 // a cold start of Steam takes a while
    while (!steamui.bigPictureOpen() && Date.now() < until) await new Promise((r) => setTimeout(r, 500))
    await new Promise((r) => setTimeout(r, 1500)) // let it finish loading
  }
  if (steamApp !== s) return // gave up meanwhile
  steamSpawn([`steam://rungameid/${appId}`])
}

function closeBigPicture() {
  if (steamui.bigPictureOpen()) steamSpawn(['steam://close/bigpicture'])
  // Closing it shows Steam's desktop window; hide that straight away (the 3 s
  // check would catch it too).
  for (const ms of [1500, 3000]) setTimeout(() => steamui.hideDesktopWindow(), ms)
}

function steamRunning(s) {
  return s.appId ? steamproc.gamePids(s.appId).length > 0 : steamui.bigPictureOpen()
}

function watchSteam() {
  const s = steamApp
  if (!s) return
  if (steamRunning(s)) {
    s.seen = true
    return
  }
  // The first start of a Proton game can take a couple of minutes (prefix setup).
  if (!s.seen && Date.now() - s.started < 180_000) return
  // Steam is asking something before the game starts (in Big Picture): wait.
  if (s.appId && !s.seen && steamui.bigPictureOpen()) return
  steamApp = null
  updateGameScreen()
  log(`${s.label} ${s.seen ? 'closed' : 'never started'}`)
  if (s.appId && s.bigPicture) closeBigPicture()
  send({ type: 'steam-closed', label: s.label })
  if (front.kind === 'steam') {
    if (typing) endTyping(null)
    setFront({ kind: 'launcher' })
    raiseLauncher()
    send({ type: 'app-exited', label: s.label })
  }
}

/** Xbox button while Steam is in front. Steam also reacts to that button (it
 *  opens its own menu), so raise the launcher again once Steam has had its turn. */
function homeFromSteam() {
  const s = steamApp
  setFront({ kind: 'launcher' })
  raiseLauncher()
  for (const ms of [1200, 2500]) {
    setTimeout(() => {
      if (front.kind === 'launcher' && !typing) raiseLauncher()
    }, ms)
  }
  if (s) send({ type: 'app-running', label: s.label, quitLabel: s.appId ? 'Quit game' : 'Close Big Picture' })
}

/** Back to the Steam game (or Big Picture) left running behind the launcher. */
function resumeSteam() {
  const s = steamApp
  // (A game Steam is still asking about counts: its prompt is in Big Picture.)
  if (!s || !(steamRunning(s) || (s.appId && steamui.bigPictureOpen()))) {
    steamApp = null
    updateGameScreen()
    return false
  }
  setFront({ kind: 'steam', key: `steam:${s.appId || 'bigpicture'}`, label: s.label, appId: s.appId })
  // Cage shows the most recent window that's left, which is Steam's.
  if (win && !win.isDestroyed()) win.hide()
  log(`back to ${s.label}`)
  return true
}

function quitSteam() {
  const s = steamApp
  if (!s) return false
  // The game, if it's running (watchSteam then closes Big Picture); otherwise
  // Big Picture (Steam itself keeps running in the background).
  if (s.appId && steamproc.gamePids(s.appId).length) steamproc.quitGame(s.appId)
  else {
    closeBigPicture()
    if (s.appId) s.seen = true // nothing to wait for any more
  }
  log(`quitting ${s.label}`)
  return true
}

/** Ask a Flatpak app to quit like closing its window would (SIGTERM to its main
 *  process), so it can save: Chrome writes sign-in cookies on the way out, and
 *  `flatpak kill` (SIGKILL) lost a Netflix sign-in. Force it after 5 s. */
function closeApp(appId) {
  const main = support.flatpakMainPid(appId)
  if (main) {
    try {
      process.kill(main, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  log(`closing ${appId} (${main ? `asked pid ${main} to quit` : 'no main process found'})`)
  const started = Date.now()
  const t = setInterval(() => {
    if (support.flatpakPids(appId).length === 0) return clearInterval(t)
    if (Date.now() - started > 5000 || !main) {
      clearInterval(t)
      log(`${appId} didn't quit in time; stopping it`)
      run('flatpak', ['kill', appId])
    }
  }, 250)
}

/** Xbox button / "home": leave the keyboard, hide a web layer, or close the native app in front. */
function goHome() {
  if (typing) {
    endTyping(null)
    return
  }
  if (hideWeb()) return
  if (front.kind === 'steam') {
    homeFromSteam()
    return
  }
  if (native && native.appId) {
    closeApp(native.appId)
    return
  }
  // The launcher is in front: tell it (it closes one of your own apps if open).
  send({ type: 'home' })
  showLauncher()
}

/** Bring the launcher window in front of other apps. In Cage the most recently
 *  mapped window is shown, so re-map it (hide + show). */
async function raiseLauncher() {
  if (!win || win.isDestroyed()) return
  win.hide()
  // Give Cage a moment to see the window go away; an instant hide+show is
  // coalesced and the window stays behind the app (seen on the TV).
  await new Promise((r) => setTimeout(r, 250))
  win.show()
  win.setFullScreen(true)
  win.focus()
  win.webContents.focus()
  log('launcher raised over the app')
}

function showLauncher() {
  if (!win || win.isDestroyed()) return
  if (!win.isVisible()) {
    win.show()
    win.setFullScreen(true)
  }
  win.focus()
  win.webContents.focus()
}

// ---------- mouse mode ----------

function setFront(f) {
  front = f
  updateMouse()
  updateGameScreen()
}

/** Games through Steam (Proton) and itch games run under Xwayland, which at the
 *  App size scale (200%) offers them only 960x540: Sonic Generations' settings
 *  then didn't match ("does not match your current hardware") and games render
 *  at half resolution. So the screen goes to scale 1 while one is open (or left
 *  running behind the launcher), and back to the App size after. The launcher
 *  cancels the scale with its zoom, so it looks the same either way. */
function gameScreen() {
  return Boolean(steamApp) || front.kind === 'steam' || String(front.key || '').startsWith('itch-game:')
}

function updateGameScreen() {
  const want = gameScreen() ? 1 : scale
  if (want === appliedScale) return
  applyDisplay(want).catch((e) => log(`display: ${e.message}`))
}

function wantMouse() {
  if (typing || front.kind === 'launcher') return false
  if (support.neverMouse(front.key)) return false
  // View + X while a game is reading the controller: for this time only
  if (front.manual !== undefined) return front.manual
  // Something in the app is reading the controller right now (a game, including
  // one started from inside another app such as itch): no mouse mode, whatever
  // was chosen for the app before. Mouse mode turns X into Space and A into a
  // click, and a game reading the controller would get both (seen with a Godot
  // game launched through itch: X also pressed Space, 100 of 104 presses).
  if (front.readingController) return false
  const choice = support.override(front.key)
  if (choice !== undefined) return choice
  if (front.kind === 'steam') return false // Steam Input handles games
  if (front.kind === 'web') return true
  if (front.kind === 'native') return !front.usesController
  return false
}

function updateMouse() {
  const on = wantMouse()
  if (on === mouseOn) return
  mouseOn = on
  input.send({ cmd: 'mouse', on })
  log(`mouse mode ${on ? 'on' : 'off'}${front.label ? ` for ${front.label}` : ''}`)
  send({ type: 'mouse-mode', on, label: front.label || null })
}

/** View + X: flip mouse mode for the app in front and remember it. */
function toggleMouse() {
  if (front.kind === 'launcher' || typing) return
  if (support.neverMouse(front.key)) return // controller-only app (games): no mouse mode
  const on = !wantMouse()
  if (front.readingController) {
    // A game is running: don't let this choice follow the app (itch) into the next game
    front.manual = on
    log(`${front.label}: mouse mode ${on ? 'on' : 'off'} (your choice, this time only: a game is reading the controller)`)
  } else {
    support.setOverride(front.key, on)
    log(`${front.label}: mouse mode ${on ? 'on' : 'off'} (your choice, remembered)`)
  }
  updateMouse()
}

async function checkAppStream(appId) {
  try {
    const [details] = await store.detailsMany([appId])
    if (details && details.gamepad && front.kind === 'native' && front.appId === appId && !front.usesController) {
      log(`${appId}: Flathub listing says it supports a gamepad`)
      front.usesController = true
      updateMouse()
    }
  } catch {
    /* offline: rely on watching the app */
  }
}

// Watch the app in front: while something in it has the controller open (the
// app itself, or a game it started), mouse mode stays off; when that stops (the
// game closed, back in itch's store) the app's usual setting applies again.
setInterval(() => {
  if (front.kind !== 'native' || !front.appId) return
  const reading = support.appUsesController(front.appId)
  if (reading === Boolean(front.readingController)) return
  front.readingController = reading
  if (!reading) front.manual = undefined
  log(`${front.label}: ${reading ? 'reading the controller itself; no mouse mode' : 'no longer reading the controller'}`)
  if (reading && !front.usesController) {
    front.usesController = true
    support.rememberControllerApp(front.appId)
  }
  updateMouse()
}, 1000)

// ---------- typing into other apps ----------

/** A text field got focus in the app in front. Open the keyboard if you just clicked it. */
function onTextFocus(info) {
  if (!mouseOn || typing || front.kind === 'launcher') return
  if (Date.now() - lastClick > CLICK_TO_FOCUS_MS) return // focused by the app itself, not by you
  log(`text field clicked in ${front.label} (${info.role || 'field'}); opening the keyboard`)
  startTyping(Boolean(info.password))
}

function startTyping(password = false) {
  if (typing || front.kind === 'launcher') return
  typing = { front, webLayer: null }
  if (front.kind === 'web' && visibleLayer) {
    typing.webLayer = visibleLayer
    win.contentView.removeChildView(visibleLayer.view)
    win.webContents.focus()
  } else {
    raiseLauncher()
  }
  updateMouse()
  send({ type: 'keyboard-request', label: front.label || 'this app', password })
}

/** Finish typing: put the app back in front and type the text into it (null = cancel). */
function endTyping(text, enter = false) {
  if (!typing) return
  const t = typing
  typing = null
  if (t.webLayer) {
    win.contentView.addChildView(t.webLayer.view)
    t.webLayer.view.webContents.focus()
    if (text) t.webLayer.view.webContents.insertText(text)
    if (enter) {
      t.webLayer.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      t.webLayer.view.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      t.webLayer.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    }
  } else if (native) {
    win.hide() // Cage shows the app again
    if (text || enter) setTimeout(() => input.send({ cmd: 'type', text: text || '', enter }), 400)
  } else {
    showLauncher()
  }
  updateMouse()
  send({ type: 'keyboard-closed' })
}

// ---------- volume ----------

async function getVolume() {
  const r = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'])
  const m = r.stdout.match(/Volume:\s*([\d.]+)(.*MUTED)?/)
  return m ? { volume: Math.round(Number(m[1]) * 100), muted: Boolean(m[2]) } : { volume: null, muted: false }
}

async function changeVolume(step) {
  // 5% steps, capped at 100% (over HDMI that's full level; the TV remote does the rest)
  await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', '0'])
  await run('wpctl', ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', `5%${step > 0 ? '+' : '-'}`])
  const v = await getVolume()
  send({ type: 'volume', ...v })
  return v
}

// ---------- Claude connector pairing ----------

const CONNECTOR = '/usr/libexec/tv-connector/tv-connector.py'
const PAIRING_CODE = /\b([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\b/

/** Make a new one-time pairing code for connecting Claude (Settings > Connect Claude).
 *  Someone at the TV can already do anything on it, so showing a code here gives
 *  nothing away; a code still works only once, within 7 days. */
async function newPairingCode() {
  let url = null
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/tv-connector/config.json'), 'utf8'))
    if (typeof cfg.public_url === 'string') url = `${cfg.public_url}/mcp`
  } catch {
    throw new Error('The Claude connector is not set up on this PC yet')
  }
  const r = await run('python3', [CONNECTOR, 'new-code'], { timeout: 30_000 })
  const m = r.stdout.match(PAIRING_CODE)
  if (!r.ok || !m) {
    log(`new pairing code failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`)
    throw new Error("Couldn't make a pairing code")
  }
  log('new Claude pairing code shown on screen')
  return { code: m[1], url }
}

// ---------- remote control (Claude, via the connector) ----------

/** Run a __tvRemote call in the launcher page (lib/remote.ts in the UI). */
async function ui(call) {
  if (!win || win.isDestroyed()) return null
  return win.webContents.executeJavaScript(`window.__tvRemote ? window.__tvRemote.${call} : null`, true)
}

const APP_KEYS = { up: 'up', down: 'down', left: 'left', right: 'right', select: 'enter', back: 'esc', x: 'space' }

async function handleControl(req) {
  const cmd = req && req.cmd
  const frontInfo = () => ({
    kind: front.kind,
    label: front.label || null,
    appId: front.appId || null,
    mouseMode: mouseOn,
    typing: Boolean(typing),
    steamInBackground: steamApp && front.kind !== 'steam' ? steamApp.label : null,
  })
  switch (cmd) {
    case 'status':
      return {
        ok: true,
        front: frontInfo(),
        launcherShowing: front.kind === 'launcher' || Boolean(typing),
        display: { scale },
        volume: await getVolume(),
        osUpdate: await osUpdate.refresh(),
        launcher: await ui('state()'),
      }
    case 'press': {
      const button = String(req.button || '')
      const times = Math.max(1, Math.min(Number(req.times) || 1, 20))
      if (button === 'home') {
        goHome()
        return { ok: true, front: frontInfo() }
      }
      if (front.kind === 'launcher' || typing) {
        const done = await ui(`press(${JSON.stringify(button)}, ${times})`)
        if (!done) return { ok: false, error: `unknown button ${button}` }
        return { ok: true, launcher: await ui('state()') }
      }
      const key = APP_KEYS[button]
      if (!key) return { ok: false, error: `${button} isn't available while ${front.label} is in front` }
      if (front.kind === 'web' && visibleLayer) {
        const code = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Return', esc: 'Escape', space: 'Space' }[key]
        for (let i = 0; i < times; i++) {
          visibleLayer.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: code })
          visibleLayer.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: code })
        }
      } else {
        for (let i = 0; i < times; i++) input.send({ cmd: 'key', key })
      }
      return { ok: true, front: frontInfo() }
    }
    case 'open': {
      if (front.kind !== 'launcher' && !typing) goHome()
      const r = await ui(`open(${JSON.stringify(String(req.name || ''))})`)
      return r || { ok: false, error: 'launcher not ready' }
    }
    case 'close':
      if (front.kind === 'steam') {
        quitSteam()
        homeFromSteam()
        return { ok: true, note: `quitting ${steamApp ? steamApp.label : 'Steam'}` }
      }
      if (front.kind === 'launcher') return { ok: true, note: 'nothing open; the launcher is in front' }
      goHome()
      return { ok: true }
    case 'type': {
      const text = String(req.text || '').slice(0, 5000)
      const enter = Boolean(req.enter)
      if (typing) endTyping(text, enter)
      else if (front.kind === 'web' && visibleLayer) {
        visibleLayer.view.webContents.insertText(text)
        if (enter) {
          visibleLayer.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          visibleLayer.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
        }
      } else if (front.kind === 'native') input.send({ cmd: 'type', text, enter })
      else return { ok: false, error: 'no app is waiting for text (the launcher is in front)' }
      return { ok: true }
    }
    case 'mouse': {
      if (front.kind === 'launcher') return { ok: false, error: 'mouse mode is only for apps' }
      if (support.neverMouse(front.key) && req.on) return { ok: false, error: `${front.label} is played with the controller; mouse mode stays off` }
      support.setOverride(front.key, Boolean(req.on))
      updateMouse()
      return { ok: true, front: frontInfo() }
    }
    default:
      return { ok: false, error: `unknown command ${cmd}` }
  }
}

// ---------- display ----------

function applyZoom() {
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(1 / (appliedScale || scale))
}

async function applyDisplay(want = gameScreen() ? 1 : scale) {
  appliedScale = want
  const r = await display.apply(want, log)
  applyZoom()
  return r
}

const isHttps = (u) => {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}

async function launch(target, label) {
  if (!target || typeof target !== 'object') throw new Error('bad target')
  switch (target.kind) {
    case 'web':
      if (!isHttps(target.url)) throw new Error('web apps must use https')
      openWeb(target.url, target.userAgent, label)
      return
    case 'chrome':
      if (!isHttps(target.url)) throw new Error('Chrome apps must use https')
      spawnApp(
        'flatpak',
        [
          'run',
          'com.google.Chrome',
          '--kiosk',
          '--start-fullscreen',
          '--no-first-run',
          '--ozone-platform-hint=auto',
          // Arrow keys move a highlight between links and buttons (the D-pad, via mouse mode)
          '--enable-spatial-navigation',
          target.url,
        ],
        label,
        'com.google.Chrome',
      )
      return
    case 'flatpak':
      if (!flatpak.VALID_ID.test(target.appId)) throw new Error('bad app id')
      spawnApp('flatpak', ['run', target.appId, ...(Array.isArray(target.args) ? target.args.map(String) : [])], label, target.appId)
      return
    case 'itch-game': {
      // A game installed by the itch app, started without the itch app's window
      const t = itchGame.findTarget(String(target.folder || ''))
      log(`${label}: starting ${t.kind === 'windows' ? 'with Wine ' : ''}${t.path}`)
      spawnApp('flatpak', itchGame.flatpakArgs(t), label, itchGame.ITCH_APP, {
        key: `itch-game:${target.folder}`,
        usesController: true, // a game: no mouse mode unless you turn it on (View + X)
      })
      return
    }
    case 'steam':
      if (!/^\d+$/.test(String(target.appId))) throw new Error('bad Steam id')
      // Handed to the Steam client through Big Picture; the game is tracked by its
      // processes (watchSteam).
      startSteamGame(String(target.appId), startSteam(String(target.appId), label)).catch((e) =>
        log(`${label}: ${e.message}`),
      )
      return
    case 'plex':
      if (!/^\d+$/.test(String(target.ratingKey))) throw new Error('bad Plex item')
      playOnPlex(String(target.ratingKey), label) // carries on in the background
      return
    case 'steam-bigpicture':
      steamSpawn(['steam://open/bigpicture'])
      startSteam(null, label)
      return
    default:
      throw new Error(`unknown launch kind ${target.kind}`)
  }
}

// ---------- IPC ----------

function fromLauncher(event) {
  return win && event.sender === win.webContents
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromLauncher(event)) throw new Error('not allowed')
    return fn(...args)
  })
}

function registerIpc() {
  handle('tv:listFlatpaks', () => flatpak.listFlatpaks())
  handle('tv:listSteamGames', () => steam.listSteamGames())
  handle('tv:launch', (target, label) => launch(target, String(label || 'app')))
  handle('tv:storeSearch', async (query) => {
    const [apps, installed] = await Promise.all([store.search(String(query).slice(0, 100)), flatpak.listFlatpaks()])
    const ids = new Set(installed.map((f) => f.appId))
    return apps.map((a) => ({ ...a, installed: ids.has(a.appId) }))
  })
  handle('tv:storeDetails', async (appIds) => {
    const list = (Array.isArray(appIds) ? appIds : []).filter((id) => flatpak.VALID_ID.test(id)).slice(0, 50)
    const [apps, installed] = await Promise.all([store.detailsMany(list), flatpak.listFlatpaks()])
    const ids = new Set(installed.map((f) => f.appId))
    return apps.map((a) => ({ ...a, installed: ids.has(a.appId) }))
  })
  handle('tv:storeInstall', (appId) =>
    flatpak.install(String(appId), (percent) => send({ type: 'install-progress', appId, percent })),
  )
  handle('tv:storeUninstall', (appId) => flatpak.uninstall(String(appId)))
  handle('tv:systemInfo', async () => {
    const commit = await run('git', ['-C', paths.uiRepo, 'log', '-1', '--format=%h · %cr'])
    return {
      shellVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      hostname: os.hostname(),
      uiCommit: commit.ok ? commit.stdout.trim() : 'not downloaded yet',
      uiSource,
      imageVersion: readText(paths.imageVersion, 'unknown'),
    }
  })
  handle('tv:power', async (action) => {
    if (action === 'reboot') await run('systemctl', ['reboot'])
    else if (action === 'poweroff') await run('systemctl', ['poweroff'])
    else if (action === 'restart-shell') app.exit(0)
    else if (action === 'reload-ui') await loadUi()
  })
  handle('tv:typeText', (text, enter) => endTyping(String(text || '').slice(0, 5000), Boolean(enter)))
  handle('tv:cancelTyping', () => endTyping(null))
  handle('tv:getDisplay', () => ({ scale, scales: display.SCALES }))
  handle('tv:setDisplay', async (opts) => {
    const s = Number(opts && opts.scale)
    if (!display.SCALES.includes(s)) throw new Error('bad scale')
    scale = s
    display.saveScale(s)
    await applyDisplay()
    return { scale }
  })
  handle('tv:resetInputPrefs', () => support.clearOverrides())
  handle('tv:getPointer', () => ({ ...pointer, speeds: pointerPrefs.SPEEDS, sizes: pointerPrefs.SIZES }))
  handle('tv:setPointer', (patch) => {
    pointer = pointerPrefs.save(patch)
    process.env.XCURSOR_SIZE = String(pointer.size)
    input.send({ cmd: 'speed', factor: pointer.speed })
    return { ...pointer, speeds: pointerPrefs.SPEEDS, sizes: pointerPrefs.SIZES }
  })
  handle('tv:resumeApp', () => resumeSteam())
  handle('tv:osUpdateStatus', () => osUpdate.refresh())
  handle('tv:plexHome', () => plex.home())
  handle('tv:plexGet', (p) => plex.get(String(p)))
  handle('tv:newPairingCode', () => newPairingCode())
  handle('tv:osUpdateCheck', () => osUpdate.check())
  handle('tv:osUpdateDownload', () => osUpdate.download())
  handle('tv:quitApp', () => quitSteam())
  handle('tv:getVolume', () => getVolume())
  handle('tv:changeVolume', (step) => changeVolume(Number(step) > 0 ? 1 : -1))
  // From web layers (webview-preload.cjs): a text field got focus.
  ipcMain.on('tv:text-focus', (event, info) => {
    if (visibleLayer && event.sender === visibleLayer.view.webContents) onTextFocus(info || {})
  })
}

// ---------- start ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    log(`starting ${app.getVersion()} (Electron ${process.versions.electron}, ${process.env.XDG_SESSION_TYPE || '?'} session)`)
    fs.mkdirSync(paths.data, { recursive: true })
    registerProtocol()
    registerIpc()
    // Start the controller helper before the window: its first act is a Shift
    // tap from a live virtual keyboard (wake_keyboard). If the previous shell's
    // keyboard device vanished (crash, kill), Cage otherwise gives the new window
    // keyboard modifiers without a keymap and Electron crashes (xkb_state_update_mask).
    input.on('controller', (m) => log(`controller ${m.connected ? `connected: ${m.name}` : 'disconnected'}`))
    // Every (re)start of the helper gets the saved pointer speed.
    input.on('ready', () => input.send({ cmd: 'speed', factor: pointer.speed }))
    input.start()
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000)
      input.once('ready', () => {
        clearTimeout(t)
        setTimeout(resolve, 200) // let Cage pass the keymap on
      })
    })
    createWindow()
    // On boot the dev server may still be starting; give it a moment, then
    // show the backup copy and switch over when it's ready.
    applyDisplay()
    input.on('home', () => goHome())
    input.on('toggle-mouse', () => toggleMouse())
    input.on('keyboard', () => startTyping())
    input.on('volume', (m) => changeVolume(m.step))
    input.on('click', () => {
      lastClick = Date.now()
    })
    a11y.on('text-focus', (m) => {
      if (front.kind === 'native') onTextFocus(m)
    })
    a11y.start()
    startControlServer(handleControl, log)
    if (await waitForDevServer(8000)) await loadUi()
    else await loadFallback()
  })
  app.on('window-all-closed', () => app.quit())
}
