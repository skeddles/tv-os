// Tile icons for web services (Netflix, Disney+, ...): the site's own app icon,
// the one a phone uses for a home-screen shortcut (apple-touch-icon or the web
// app manifest), fetched from the site the first time and kept for 30 days in
// ~/.local/share/tvlauncher/site-icons/. Nothing is bundled with the launcher.
const fs = require('node:fs')
const path = require('node:path')

const MAX_AGE_MS = 30 * 24 * 3600 * 1000
const MAX_BYTES = 2 * 1024 * 1024
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36'
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null
}

function sizeOf(sizes, fallback) {
  if (!sizes) return fallback
  if (/any/i.test(sizes)) return 512
  return Math.max(...sizes.split(/\s+/).map((s) => Number(s.toLowerCase().split('x')[0]) || 0))
}

/** Icon candidates [{ url, size }] and the manifest URL from a page's HTML. */
function parseIcons(html, pageUrl) {
  const icons = []
  let manifest = null
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase()
    const href = attr(tag, 'href')
    if (!href) continue
    let url
    try {
      url = new URL(href.replace(/&amp;/g, '&'), pageUrl).toString()
    } catch {
      continue
    }
    if (rel.split(/\s+/).includes('manifest')) manifest = url
    else if (rel.includes('apple-touch-icon')) icons.push({ url, size: sizeOf(attr(tag, 'sizes'), 180) })
    else if (rel.split(/\s+/).includes('icon')) icons.push({ url, size: sizeOf(attr(tag, 'sizes'), /\.ico(\?|$)/i.test(url) ? 16 : 32) })
  }
  return { icons, manifest }
}

/** Icon candidates from a web app manifest (JSON text). Skips maskable-only icons. */
function parseManifest(json, manifestUrl) {
  const out = []
  let data
  try {
    data = JSON.parse(json)
  } catch {
    return out
  }
  for (const icon of Array.isArray(data.icons) ? data.icons : []) {
    if (!icon || typeof icon.src !== 'string') continue
    if (icon.purpose && !/\bany\b/.test(icon.purpose)) continue
    try {
      out.push({ url: new URL(icon.src, manifestUrl).toString(), size: sizeOf(icon.sizes, 48) })
    } catch {
      /* bad src */
    }
  }
  return out
}

function hostKey(pageUrl) {
  return new URL(pageUrl).hostname.replace(/[^a-z0-9.-]/gi, '_')
}

class SiteIcons {
  /** fetchFn: (url, init) => Response (Electron's net.fetch) */
  constructor(dir, fetchFn, log) {
    this.dir = dir
    this.fetch = fetchFn
    this.log = log
    this.pending = new Map()
  }

  cached(pageUrl) {
    const base = path.join(this.dir, hostKey(pageUrl))
    for (const ext of Object.values(IMAGE_TYPES)) {
      try {
        const st = fs.statSync(base + ext)
        return { file: base + ext, fresh: Date.now() - st.mtimeMs < MAX_AGE_MS }
      } catch {
        /* not this one */
      }
    }
    return null
  }

  /** Path of the cached icon for pageUrl, fetching it first if needed; null if none. */
  async get(pageUrl) {
    if (!/^https:\/\//.test(pageUrl)) return null
    const have = this.cached(pageUrl)
    if (have && have.fresh) return have.file
    const key = hostKey(pageUrl)
    if (!this.pending.has(key)) {
      this.pending.set(
        key,
        this.download(pageUrl)
          .catch((e) => {
            this.log(`site icon for ${key}: ${e.message}`)
            return null
          })
          .finally(() => this.pending.delete(key)),
      )
    }
    const got = await this.pending.get(key)
    return got || (have ? have.file : null) // a stale copy beats none
  }

  async text(url) {
    const res = await this.fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    return res.text()
  }

  async download(pageUrl) {
    const html = await this.text(pageUrl)
    const { icons, manifest } = parseIcons(html, pageUrl)
    if (manifest) {
      try {
        icons.push(...parseManifest(await this.text(manifest), manifest))
      } catch {
        /* the page's own icons will do */
      }
    }
    icons.sort((a, b) => b.size - a.size)
    for (const icon of icons) {
      try {
        const res = await this.fetch(icon.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) })
        const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        if (!res.ok || !IMAGE_TYPES[type]) continue
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length === 0 || buf.length > MAX_BYTES) continue
        fs.mkdirSync(this.dir, { recursive: true })
        const base = path.join(this.dir, hostKey(pageUrl))
        for (const ext of Object.values(IMAGE_TYPES)) fs.rmSync(base + ext, { force: true })
        fs.writeFileSync(base + IMAGE_TYPES[type], buf)
        this.log(`site icon for ${hostKey(pageUrl)}: ${icon.url} (${icon.size}px)`)
        return base + IMAGE_TYPES[type]
      } catch {
        /* try the next one */
      }
    }
    throw new Error('no usable icon found')
  }
}

module.exports = { SiteIcons, parseIcons, parseManifest }
