// Plex: "Continue watching" and "Recently added" rows on Home, and starting an
// item in the Plex HTPC app on this PC.
//
// Uses the sign-in the Plex HTPC app already has (its plex.ini), so there is
// nothing to set up. The token never leaves the shell: the launcher gets titles
// and tvapp://plex-image/ URLs, and images are fetched here.
//
// Starting an item uses Plex's remote control ("Plex Companion"): a play queue
// on the server, then playMedia sent through the server to the HTPC player
// (tested Nov 2026: Plex HTPC 1.70 resumed an episode this way).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const INI = path.join(os.homedir(), '.var/app/tv.plex.PlexHTPC/data/plex/plex.ini')
const CLIENT_ID = 'tvlauncher-shell'
const RESOURCES_TTL = 10 * 60 * 1000

/** PlexAuthToken and ClientID from the [web] section of Plex HTPC's plex.ini. */
function parseIni(text) {
  const out = {}
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const sec = line.match(/^\s*\[(.+)\]\s*$/)
    if (sec) {
      section = sec[1]
      continue
    }
    const kv = line.match(/^([^=]+)=(.*)$/)
    if (section === 'web' && kv) out[kv[1].trim()] = kv[2].trim().replace(/^"(.*)"$/, '$1')
  }
  return { token: out.PlexAuthToken || '', playerId: out.ClientID || '' }
}

/** A Plex metadata item -> what a launcher tile needs. */
function toItem(m) {
  const episode = m.type === 'episode'
  const art = episode ? m.thumb || m.grandparentArt || m.art : m.art || m.thumb
  return {
    ratingKey: String(m.ratingKey),
    type: m.type,
    title: episode ? m.grandparentTitle || m.title : m.title,
    subtitle: episode
      ? `S${m.parentIndex ?? '?'}E${m.index ?? '?'} · ${m.title}`
      : m.year
        ? String(m.year)
        : '',
    image: art ? `tvapp://plex-image/?path=${encodeURIComponent(art)}` : null,
    progress: m.viewOffset && m.duration ? Math.min(100, Math.round((m.viewOffset / m.duration) * 100)) : null,
  }
}

class Plex {
  /** fetchFn: Electron's net.fetch */
  constructor(fetchFn, log) {
    this.fetch = fetchFn
    this.log = log
    this.res = null
    this.resAt = 0
  }

  creds() {
    try {
      const c = parseIni(fs.readFileSync(INI, 'utf8'))
      return c.token ? c : null
    } catch {
      return null
    }
  }

  headers(token, extra = {}) {
    return {
      'X-Plex-Token': token,
      'X-Plex-Client-Identifier': CLIENT_ID,
      'X-Plex-Product': 'TV launcher',
      'X-Plex-Device-Name': os.hostname(),
      Accept: 'application/json',
      ...extra,
    }
  }

  async json(url, token, init = {}) {
    const res = await this.fetch(url, {
      ...init,
      headers: this.headers(token, init.headers),
      signal: AbortSignal.timeout(init.timeout || 15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    return text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : {}
  }

  /** The server (and how to reach it) and this PC's player id, from plex.tv. */
  async resources() {
    if (this.res && Date.now() - this.resAt < RESOURCES_TTL) return this.res
    const c = this.creds()
    if (!c) return null
    const list = await this.json('https://plex.tv/api/v2/resources?includeHttps=1', c.token)
    const servers = list.filter((d) => String(d.provides).includes('server') && d.accessToken)
    const server = servers.find((d) => d.owned && d.presence) || servers.find((d) => d.presence) || servers[0]
    if (!server) return null
    const conns = server.connections || []
    const conn = conns.find((x) => x.local && !x.relay) || conns.find((x) => !x.relay) || conns[0]
    if (!conn) return null
    this.res = { uri: conn.uri, token: server.accessToken, machineId: server.clientIdentifier, playerId: c.playerId }
    this.resAt = Date.now()
    return this.res
  }

  /** { continueWatching, recentlyAdded } or null when Plex isn't signed in / reachable. */
  async home() {
    let r
    try {
      r = await this.resources()
    } catch (e) {
      this.log(`plex: ${e.message}`)
      return null
    }
    if (!r) return null
    const list = async (p) => {
      try {
        const d = await this.json(r.uri + p, r.token)
        return ((d.MediaContainer && d.MediaContainer.Metadata) || []).map(toItem)
      } catch (e) {
        this.log(`plex ${p}: ${e.message}`)
        this.res = null // maybe the address changed; look it up again next time
        return []
      }
    }
    const [continueWatching, recentlyAdded] = await Promise.all([
      list('/library/onDeck'),
      list('/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=20'),
    ])
    return { continueWatching, recentlyAdded }
  }

  /** An image from the server (path from an item), resized for a tile. */
  async image(p) {
    const r = await this.resources()
    if (!r || !/^\/library\//.test(p)) return new Response('not found', { status: 404 })
    const q = new URLSearchParams({ width: '640', height: '360', minSize: '1', upscale: '1', url: p })
    return this.fetch(`${r.uri}/photo/:/transcode?${q}`, { headers: this.headers(r.token, { Accept: 'image/*' }) })
  }

  /** Start ratingKey on this PC's Plex HTPC (which must be running and signed in). */
  async play(ratingKey) {
    const r = await this.resources()
    if (!r) throw new Error('Plex is not signed in')
    if (!/^\d+$/.test(String(ratingKey))) throw new Error('bad item')
    const key = `/library/metadata/${ratingKey}`
    const meta = await this.json(r.uri + key, r.token)
    const m = (meta.MediaContainer && meta.MediaContainer.Metadata && meta.MediaContainer.Metadata[0]) || {}
    const pq = await this.json(
      `${r.uri}/playQueues?${new URLSearchParams({
        type: 'video',
        uri: `server://${r.machineId}/com.plexapp.plugins.library${key}`,
        continuous: '1',
        own: '1',
      })}`,
      r.token,
      { method: 'POST' },
    )
    const queueId = pq.MediaContainer && pq.MediaContainer.playQueueID
    if (!queueId) throw new Error('no play queue')
    const u = new URL(r.uri)
    const params = new URLSearchParams({
      key,
      offset: String(m.viewOffset || 0),
      machineIdentifier: r.machineId,
      address: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      protocol: u.protocol.replace(':', ''),
      token: r.token,
      containerKey: `/playQueues/${queueId}?window=100&own=1`,
      commandID: String(Date.now() % 100000),
      type: 'video',
    })
    await this.json(`${r.uri}/player/playback/playMedia?${params}`, r.token, {
      headers: { 'X-Plex-Target-Client-Identifier': r.playerId },
      timeout: 10000,
    })
  }
}

module.exports = { Plex, parseIni, toItem }
