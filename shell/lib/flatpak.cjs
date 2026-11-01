// Installed Flatpak apps, their icons, install and uninstall.
const fs = require('node:fs')
const path = require('node:path')
const { HOME, run, runStreaming } = require('./system.cjs')

const ICON_ROOTS = [
  '/var/lib/flatpak/exports/share/icons/hicolor',
  path.join(HOME, '.local/share/flatpak/exports/share/icons/hicolor'),
]
const ICON_SIZES = ['256x256', '128x128', '512x512', '96x96', '64x64', 'scalable']

async function listFlatpaks() {
  const r = await run('flatpak', ['list', '--app', '--columns=application,name'])
  if (!r.ok) return []
  const seen = new Map()
  for (const line of r.stdout.split('\n')) {
    const [appId, name] = line.split('\t')
    if (!appId || seen.has(appId)) continue
    seen.set(appId, { appId, name: name || appId, icon: `tvapp://icon/${appId}` })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function findIcon(appId) {
  if (!/^[\w.-]+$/.test(appId)) return null
  for (const root of ICON_ROOTS) {
    for (const size of ICON_SIZES) {
      for (const ext of ['png', 'svg']) {
        const p = path.join(root, size, 'apps', `${appId}.${ext}`)
        if (fs.existsSync(p)) return p
      }
    }
  }
  return null
}

const VALID_ID = /^[A-Za-z][\w-]*(\.[\w-]+)+$/

/**
 * Install from Flathub. Tries a system-wide install first (Bazzite's default),
 * then a per-user install if the system one isn't allowed.
 */
async function install(appId, onProgress) {
  if (!VALID_ID.test(appId)) return { ok: false, error: 'invalid app id' }
  const progress = (chunk) => {
    const matches = [...chunk.matchAll(/(\d{1,3})%/g)]
    if (matches.length) onProgress(Math.min(100, Number(matches[matches.length - 1][1])))
  }
  let r = await runStreaming('flatpak', ['install', '--system', '--noninteractive', '-y', 'flathub', appId], progress)
  if (r.code === 0) return { ok: true }
  await run('flatpak', ['remote-add', '--user', '--if-not-exists', 'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo'])
  r = await runStreaming('flatpak', ['install', '--user', '--noninteractive', '-y', 'flathub', appId], progress)
  if (r.code === 0) return { ok: true }
  const lastLine = r.output.trim().split('\n').pop() || 'unknown error'
  return { ok: false, error: lastLine.slice(0, 200) }
}

async function uninstall(appId) {
  if (!VALID_ID.test(appId)) return { ok: false, error: 'invalid app id' }
  const r = await run('flatpak', ['uninstall', '--noninteractive', '-y', appId], { timeout: 300_000 })
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim().split('\n').pop() }
}

module.exports = { listFlatpaks, findIcon, install, uninstall, VALID_ID }
