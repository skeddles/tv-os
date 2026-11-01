// System (OS image) updates for the Settings screen, through rpm-ostree.
//
// Bazzite also updates itself once a day (uupd.timer); that shows up here as
// "busy" with no percentage, because only the program that started an update
// sees its progress. Updates started here report progress from rpm-ostree's
// output: "ostree chunk layers needed: 21 (912.2 MB)" and one
// "[n/21] Fetching ostree chunk … (12.7 MB)...done" line per chunk.
const { spawn, execFile } = require('node:child_process')

const UNITS = { kB: 1 / 1000, KB: 1 / 1000, MB: 1, GB: 1000 }

function mb(num, unit) {
  return Number(num) * (UNITS[unit] || 0)
}

/** Feed one line of `rpm-ostree upgrade` output into a progress record { totalMB, doneMB, staging }. */
function parseLine(line, p) {
  const need = line.match(/layers needed: \d+ \(([\d.]+) (kB|KB|MB|GB)\)/)
  if (need) p.totalMB += mb(need[1], need[2])
  const got = line.match(/Fetching (?:ostree chunk|layer) \S+ \(([\d.]+) (kB|KB|MB|GB)\)\.\.\.done/)
  if (got) p.doneMB += mb(got[1], got[2])
  if (/Staging deployment/.test(line)) p.staging = true
  return p
}

function percentOf(p) {
  if (p.staging) return 100
  if (!p.totalMB) return null
  return Math.min(99, Math.floor((p.doneMB / p.totalMB) * 100))
}

/** Read `rpm-ostree status --json` into { busy, staged } (staged: when the staged image was built). */
function summarizeStatus(json) {
  const d = JSON.parse(json)
  const staged = (d.deployments || []).find((x) => x.staged)
  return {
    busy: Boolean(d.transaction),
    staged: staged ? { timestamp: staged.timestamp || null } : null,
  }
}

function runStatus() {
  return new Promise((resolve) => {
    execFile('rpm-ostree', ['status', '--json'], { timeout: 30_000, maxBuffer: 8 << 20 }, (err, stdout) => {
      try {
        resolve(err ? null : summarizeStatus(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

class OsUpdate {
  constructor(onChange, log) {
    this.onChange = onChange
    this.log = log
    this.state = { phase: 'unknown', percent: null, doneMB: 0, totalMB: 0, message: null }
    this.child = null
    this.pollTimer = null
    this.lastSent = 0
  }

  set(patch, force = true) {
    this.state = { ...this.state, ...patch }
    const now = Date.now()
    if (force || now - this.lastSent > 1000) {
      this.lastSent = now
      this.onChange(this.state)
    }
  }

  /** Look at what rpm-ostree is doing now (cheap; used when Settings opens). */
  async refresh() {
    if (this.child) return this.state
    const s = await runStatus()
    if (!s) return this.state
    if (s.busy) {
      this.set({ phase: 'busy', percent: null, message: 'Updating in the background' })
      this.poll()
    } else if (s.staged) {
      this.set({ phase: 'ready', percent: 100, message: null })
    } else if (this.state.phase === 'busy' || this.state.phase === 'ready') {
      this.set({ phase: 'unknown', percent: null, message: null })
    }
    return this.state
  }

  /** While another program is updating, look again every few seconds. */
  poll() {
    if (this.pollTimer) return
    this.pollTimer = setInterval(async () => {
      const s = await runStatus()
      if (s && !s.busy) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
        this.refresh()
      }
    }, 5000)
  }

  check() {
    if (this.child || this.state.phase === 'busy') return this.state
    this.set({ phase: 'checking', percent: null, message: null })
    const c = spawn('rpm-ostree', ['upgrade', '--check', '--unchanged-exit-77'], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = c
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (out += d))
    c.on('error', (e) => (out += e.message))
    c.on('close', (code) => {
      this.child = null
      if (code === 77) this.set({ phase: 'up-to-date', message: null })
      else if (code === 0) {
        const p = { totalMB: 0, doneMB: 0 }
        out.split(/[\r\n]+/).forEach((l) => parseLine(l, p))
        this.set({ phase: 'available', totalMB: p.totalMB, message: null })
      } else this.fail(out, 'check')
    })
    return this.state
  }

  download() {
    if (this.child || this.state.phase === 'busy') return this.state
    const p = { totalMB: 0, doneMB: 0, staging: false }
    this.set({ phase: 'downloading', percent: null, doneMB: 0, totalMB: 0, message: null })
    this.log('OS update: downloading')
    const c = spawn('rpm-ostree', ['upgrade', '--unchanged-exit-77'], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = c
    let tail = ''
    let partial = ''
    const feed = (d) => {
      const text = partial + d
      const lines = text.split(/[\r\n]/)
      partial = lines.pop()
      for (const l of lines) {
        parseLine(l, p)
        if (l.trim()) tail = l.trim()
      }
      this.set({ percent: percentOf(p), doneMB: p.doneMB, totalMB: p.totalMB, message: p.staging ? 'Installing' : null }, false)
    }
    c.stdout.on('data', feed)
    c.stderr.on('data', feed)
    c.on('error', (e) => (tail = e.message))
    c.on('close', (code) => {
      this.child = null
      this.log(`OS update: finished (${code})`)
      if (code === 77) this.set({ phase: 'up-to-date', percent: null, message: null })
      else if (code === 0) {
        this.set({ phase: 'ready', percent: 100, message: null })
        this.refresh()
      } else this.fail(tail, 'download')
    })
    return this.state
  }

  fail(output, what) {
    const last = String(output).trim().split('\n').pop() || 'unknown error'
    this.log(`OS update ${what} failed: ${last}`)
    const message = /busy|transaction/i.test(last)
      ? 'Another update is running; try again in a while'
      : /auth|polkit|not authorized/i.test(last)
        ? 'Not allowed to update from here'
        : `Couldn't ${what === 'check' ? 'check for updates' : 'download the update'}`
    this.set({ phase: 'error', percent: null, message })
  }
}

module.exports = { OsUpdate, parseLine, percentOf, summarizeStatus }
