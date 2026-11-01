// Small helpers: running commands, paths, config.
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOME = os.homedir()
const DATA = path.join(HOME, '.local/share/tvlauncher')

const paths = {
  data: DATA,
  uiRepo: path.join(DATA, 'ui'),
  uiLastGood: path.join(DATA, 'ui-last-good'),
  uiBaked: '/usr/share/tvlauncher/ui-fallback',
  imageVersion: '/usr/share/tvlauncher/image-version',
}

/** Run a command, resolve with stdout. Never throws: resolves { ok, stdout, stderr, code }. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? err.code : 0 })
    })
  })
}

/** Start a long-running process; streams output to onData; resolves with exit code. */
function runStreaming(cmd, args, onData) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const take = (chunk) => {
      const s = String(chunk)
      out += s
      if (onData) onData(s)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (e) => resolve({ code: -1, output: String(e) }))
    child.on('close', (code) => resolve({ code, output: out }))
  })
}

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return fallback
  }
}

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

module.exports = { HOME, paths, run, runStreaming, readText, exists }
