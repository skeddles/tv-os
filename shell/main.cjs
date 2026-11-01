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
//   Xbox button: home. Hold it ~0.7 s: toggle mouse mode for the app in front.
//   Mouse mode turns on by itself for apps that don't read the controller
//   (lib/appsupport.cjs). In mouse mode, Y opens the launcher's keyboard and the
//   text is typed into the app.

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
const { OsUpdate } = require('./lib/osupdate.cjs')
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
let steamApp = null // { appId, label, started, seen }
// System image updates (Settings > System update); events go to the launcher.
const osUpdate = new OsUpdate((state) => send({ type: 'os-update', state }), (m) => log(m))

/**
 * What's in front: { kind: 'launcher' } | { kind: 'web', key, label }
 * | { kind: 'native', key, label, appId, usesController } | { kind: 'steam', key, label }
 */
let front = { kind: 'launcher' }
let typing = null // { front, webLayer } while the keyboard is up for another app
let mouseOn = false
let scale = display.loadScale()
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

function spawnApp(cmd, args, label, appId) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  const app = { child, label, appId, started: Date.now(), seen: false, starterExited: false }
  native = app
  setFront({
    kind: 'native',
    key: `flatpak:${appId}`,
    label,
    appId,
    usesController: support.knownControllerApp(appId),
  })
  checkAppStream(appId)
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

function startSteam(appId, label) {
  steamApp = { appId, label, started: Date.now(), seen: false }
  native = null
  setFront({ kind: 'steam', key: `steam:${appId || 'bigpicture'}`, label, appId })
}

function steamRunning(s) {
  return s.appId ? steamproc.gamePids(s.appId).length > 0 : steamproc.clientRunning()
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
  steamApp = null
  log(`${s.label} ${s.seen ? 'closed' : 'never started'}`)
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
  if (s) send({ type: 'app-running', label: s.label, quitLabel: s.appId ? 'Quit game' : 'Close Steam' })
}

/** Back to the Steam game (or Big Picture) left running behind the launcher. */
function resumeSteam() {
  const s = steamApp
  if (!s || !steamRunning(s)) {
    steamApp = null
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
  if (s.appId) steamproc.quitGame(s.appId)
  else spawn('steam', ['-shutdown'], { detached: true, stdio: 'ignore' }).unref()
  log(`quitting ${s.label}`)
  return true
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
    run('flatpak', ['kill', native.appId])
    return
  }
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
}

function wantMouse() {
  if (typing || front.kind === 'launcher') return false
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

/** Hold the Xbox button: flip mouse mode for the app in front and remember it. */
function toggleMouse() {
  if (front.kind === 'launcher' || typing) return
  support.setOverride(front.key, !wantMouse())
  log(`${front.label}: mouse mode ${support.override(front.key) ? 'on' : 'off'} (your choice, remembered)`)
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

// Watch the app in front: once it opens the controller itself, mouse mode goes off.
setInterval(() => {
  if (front.kind !== 'native' || front.usesController) return
  if (support.appUsesController(front.appId)) {
    log(`${front.appId} opened the controller itself; no mouse mode needed`)
    front.usesController = true
    support.rememberControllerApp(front.appId)
    updateMouse()
  }
}, 2000)

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
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(1 / scale)
}

async function applyDisplay() {
  const r = await display.apply(scale, log)
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
        ['run', 'com.google.Chrome', '--kiosk', '--start-fullscreen', '--no-first-run', '--ozone-platform-hint=auto', target.url],
        label,
        'com.google.Chrome',
      )
      return
    case 'flatpak':
      if (!flatpak.VALID_ID.test(target.appId)) throw new Error('bad app id')
      spawnApp('flatpak', ['run', target.appId, ...(Array.isArray(target.args) ? target.args.map(String) : [])], label, target.appId)
      return
    case 'steam':
      if (!/^\d+$/.test(String(target.appId))) throw new Error('bad Steam id')
      // Handed to the Steam client; the game is tracked by its processes (watchSteam).
      // -silent keeps Steam's own window hidden if this call has to start Steam.
      spawn('steam', ['-silent', `steam://rungameid/${target.appId}`], { detached: true, stdio: 'ignore' }).unref()
      startSteam(String(target.appId), label)
      return
    case 'steam-bigpicture':
      spawn('steam', ['steam://open/bigpicture'], { detached: true, stdio: 'ignore' }).unref()
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
  handle('tv:resumeApp', () => resumeSteam())
  handle('tv:osUpdateStatus', () => osUpdate.refresh())
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
    input.on('controller', (m) => log(`controller ${m.connected ? `connected: ${m.name}` : 'disconnected'}`))
    input.start()
    startControlServer(handleControl, log)
    if (await waitForDevServer(8000)) await loadUi()
    else await loadFallback()
  })
  app.on('window-all-closed', () => app.quit())
}
