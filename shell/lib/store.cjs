// Flathub catalog: search and app details, with gamepad support from AppStream
// (`supports: [{type: 'control', value: 'gamepad'}]`). Few apps fill this in,
// so the UI also keeps its own allowlist of controller-friendly apps.

const API = 'https://flathub.org/api/v2'
const cache = new Map() // appId -> StoreApp (without `installed`)

function supportsGamepad(appstream) {
  const s = appstream && appstream.supports
  return Array.isArray(s) && s.some((x) => x && x.type === 'control' && x.value === 'gamepad')
}

async function details(appId) {
  if (cache.has(appId)) return cache.get(appId)
  const res = await fetch(`${API}/appstream/${encodeURIComponent(appId)}`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return null
  const a = await res.json()
  const app = {
    appId,
    name: a.name || appId,
    summary: a.summary || '',
    icon: a.icon || undefined,
    gamepad: supportsGamepad(a),
  }
  cache.set(appId, app)
  return app
}

async function search(query, limit = 24) {
  const res = await fetch(`${API}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Flathub search failed (${res.status})`)
  const data = await res.json()
  const hits = (data.hits || []).filter((h) => h.type === 'desktop-application' || h.type === 'console-application' || !h.type)
  const apps = hits.slice(0, limit).map((h) => ({
    appId: h.app_id,
    name: h.name,
    summary: h.summary || '',
    icon: h.icon || undefined,
    gamepad: false,
  }))
  // Search results don't include device support; look it up for these.
  await Promise.all(
    apps.map(async (app) => {
      try {
        const d = await details(app.appId)
        if (d) app.gamepad = d.gamepad
      } catch {
        /* keep gamepad: false */
      }
    }),
  )
  return apps
}

async function detailsMany(appIds) {
  const results = await Promise.all(appIds.map((id) => details(id).catch(() => null)))
  return results.filter(Boolean)
}

module.exports = { search, detailsMany, supportsGamepad }
