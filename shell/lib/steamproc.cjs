// Finding Steam games and the Steam client among running processes.
//
// Steam starts every game with SteamAppId=<id> (and SteamGameId) in its
// environment, including Proton/Wine processes, so a game counts as running
// while any of this user's processes carries that variable. The Steam client
// itself is matched by its executable name.
const fs = require('node:fs')

const uid = process.getuid()

function ownPids() {
  const out = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (fs.statSync(`/proc/${name}`).uid === uid) out.push(Number(name))
    } catch {
      /* exited */
    }
  }
  return out
}

function readEnv(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'latin1')
  } catch {
    return ''
  }
}

function comm(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return ''
  }
}

// Steam's own helper processes, which can inherit the variable without being the game.
const CLIENT = /^(steam|steamwebhelper|steam-runtime-l|srt-logger|steam\.sh|pressure-vessel)/

/** True when env (NUL-separated) says the process belongs to Steam game appId. */
function envMatches(env, appId) {
  const want = `SteamAppId=${appId}`
  return env.split('\0').some((kv) => kv === want)
}

/** PIDs of the running Steam game appId (empty when it isn't running). */
function gamePids(appId) {
  const id = String(appId)
  if (!/^\d+$/.test(id) || id === '0') return []
  return ownPids().filter((pid) => pid !== process.pid && !CLIENT.test(comm(pid)) && envMatches(readEnv(pid), id))
}

/** True while the Steam client is running. */
function clientRunning() {
  return ownPids().some((pid) => comm(pid) === 'steam')
}

/** Ask the game to quit, then force it after `graceMs`. */
function quitGame(appId, graceMs = 5000) {
  const signal = (sig) => {
    for (const pid of gamePids(appId)) {
      try {
        process.kill(pid, sig)
      } catch {
        /* already gone */
      }
    }
  }
  signal('SIGTERM')
  setTimeout(() => signal('SIGKILL'), graceMs).unref()
}

module.exports = { gamePids, clientRunning, quitGame, envMatches }
