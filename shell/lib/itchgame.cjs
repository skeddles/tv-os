// Starting a game installed by the itch app straight away, without the itch
// app's window (which needs a click on your profile, then Launch).
//
// The game still runs inside the itch app's Flatpak, the same way the itch app
// runs it: a Linux game as is, a Windows game through the Wine that the itch
// Flatpak is built on (`flatpak run --command=wine io.itch.itch game.exe`; the
// Flatpak sets WINEPREFIX itself). Games are in the itch app's own folder:
//   ~/.var/app/io.itch.itch/config/itch/apps/<folder>/
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ITCH_APP = 'io.itch.itch'
const APPS_DIR = path.join(os.homedir(), '.var/app/io.itch.itch/config/itch/apps')
const FOLDER = /^[\w][\w.\- ]*$/

// Files next to a game that aren't the game
const HELPER = /(crashhandler|crashpad|unins\d*|uninstall|setup|install|vc_?redist|dxsetup|directx|dotnet|redist|launcher_helper|notification_helper)/i

function magic(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const b = Buffer.alloc(4)
    fs.readSync(fd, b, 0, 4, 0)
    fs.closeSync(fd)
    if (b[0] === 0x7f && b.toString('latin1', 1, 4) === 'ELF') return 'linux'
    if (b.toString('latin1', 0, 2) === 'MZ') return 'windows'
  } catch {
    /* unreadable */
  }
  return null
}

/** Executables in a game folder (top level and one folder down), with their kind and size. */
function executables(dir) {
  const out = []
  const scan = (d, depth) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (depth < 1) scan(p, depth + 1)
        continue
      }
      if (!e.isFile() || HELPER.test(e.name)) continue
      // Linux games: no extension, .x86_64 / .x86 / .bin; Windows games: .exe
      const ext = path.extname(e.name).toLowerCase()
      if (!['', '.x86_64', '.x86', '.bin', '.exe', '.appimage'].includes(ext)) continue
      const kind = magic(p)
      if (!kind || (kind === 'windows' && ext !== '.exe')) continue
      let size = 0
      try {
        size = fs.statSync(p).size
      } catch {
        continue
      }
      out.push({ path: p, kind, size, depth })
    }
  }
  scan(dir, 0)
  return out
}

/** What to run for an installed itch game: a Linux build first, else Windows (Wine). */
function findTarget(folder, appsDir = APPS_DIR) {
  if (!FOLDER.test(folder) || folder.includes('..')) throw new Error('bad game folder')
  const dir = path.join(appsDir, folder)
  if (!fs.existsSync(dir)) throw new Error('game not installed')
  const all = executables(dir)
  for (const kind of ['linux', 'windows']) {
    const list = all.filter((x) => x.kind === kind)
    if (!list.length) continue
    // Top level first, then the biggest (the game, not a small tool next to it)
    list.sort((a, b) => a.depth - b.depth || b.size - a.size)
    return { kind, path: list[0].path, dir: path.dirname(list[0].path) }
  }
  throw new Error('no game program found (open it in the itch app)')
}

/** The `flatpak` arguments that start it inside the itch app's Flatpak. */
function flatpakArgs(target) {
  const common = ['run', `--cwd=${target.dir}`, '--env=ITCHIO_APP=1']
  if (target.kind === 'windows') return [...common, '--command=wine', ITCH_APP, target.path]
  return [...common, `--command=${target.path}`, ITCH_APP]
}

module.exports = { ITCH_APP, APPS_DIR, findTarget, flatpakArgs, executables }
