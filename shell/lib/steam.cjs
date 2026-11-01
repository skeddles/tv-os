// Lists installed Steam games by reading Steam's own library files.
const fs = require('node:fs')
const path = require('node:path')
const { HOME } = require('./system.cjs')

const STEAM_ROOTS = [
  path.join(HOME, '.local/share/Steam'),
  path.join(HOME, '.steam/steam'),
  path.join(HOME, '.var/app/com.valvesoftware.Steam/.local/share/Steam'),
]

// Tools Steam installs that aren't games.
const NOT_GAMES = /^(Proton|Steam Linux Runtime|Steamworks Common Redistributables|SteamVR)/i

/** Minimal parser for Valve's KeyValues text format (.vdf / .acf). */
function parseVdf(text) {
  const tokens = []
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g
  let m
  while ((m = re.exec(text))) tokens.push(m[2] ?? m[1].replace(/\\(.)/g, '$1'))
  let i = 0
  function obj() {
    const out = {}
    while (i < tokens.length) {
      const key = tokens[i++]
      if (key === '}') return out
      const next = tokens[i++]
      out[key] = next === '{' ? obj() : next
    }
    return out
  }
  return obj()
}

function steamRoot() {
  for (const r of STEAM_ROOTS) {
    if (fs.existsSync(path.join(r, 'steamapps'))) return fs.realpathSync(r)
  }
  return null
}

function libraryDirs(root) {
  const dirs = new Set([path.join(root, 'steamapps')])
  try {
    const vdf = parseVdf(fs.readFileSync(path.join(root, 'steamapps/libraryfolders.vdf'), 'utf8'))
    const folders = vdf.libraryfolders || vdf.LibraryFolders || {}
    for (const v of Object.values(folders)) {
      const p = typeof v === 'string' ? v : v && v.path
      if (p) dirs.add(path.join(p, 'steamapps'))
    }
  } catch {
    /* no extra libraries */
  }
  return [...dirs]
}

/** Local artwork if Steam has cached it; the UI falls back to a solid tile. */
function findArtwork(root, appId) {
  const cache = path.join(root, 'appcache/librarycache')
  const flat = path.join(cache, `${appId}_header.jpg`)
  if (fs.existsSync(flat)) return flat
  // Newer Steam clients keep one folder per game, sometimes with hashed subfolders.
  const dir = path.join(cache, appId)
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(d, e.name))
      else if (e.name === 'header.jpg') return path.join(d, e.name)
    }
  }
  return null
}

function listSteamGames() {
  const root = steamRoot()
  if (!root) return []
  const games = new Map()
  for (const dir of libraryDirs(root)) {
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => /^appmanifest_\d+\.acf$/.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const acf = parseVdf(fs.readFileSync(path.join(dir, f), 'utf8'))
        const st = acf.AppState || acf.appstate
        if (!st || !st.appid || !st.name || NOT_GAMES.test(st.name)) continue
        games.set(st.appid, {
          appId: st.appid,
          name: st.name,
          // Served by the shell's tvapp:// protocol; 404 if not cached.
          image: `tvapp://steam/${st.appid}`,
        })
      } catch {
        /* skip unreadable manifest */
      }
    }
  }
  return [...games.values()].sort((a, b) => a.name.localeCompare(b.name))
}

module.exports = { listSteamGames, parseVdf, findArtwork, steamRoot }
