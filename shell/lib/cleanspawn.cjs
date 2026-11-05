// Starting apps without handing them the launcher's open files.
//
// The launcher's Electron process has the controller device open (Chromium's
// Gamepad support), without close-on-exec, and child_process.spawn passes such
// files on. So every app started from the launcher held the controller open
// too: found Nov 2026 (fd 135 = /dev/input/event6 in the itch app, its butler
// and Plex), which made the "does this app read the controller?" check think
// every app did, turning mouse mode off in the itch app.
//
// So apps start through a tiny step that closes every file but stdin, stdout
// and stderr, then runs the app.
const { spawn } = require('node:child_process')

const CLOSE_AND_EXEC = 'import os,sys\nos.closerange(3, 65536)\nos.execvp(sys.argv[1], sys.argv[1:])'

/** Like child_process.spawn(cmd, args, opts), with no inherited files beyond 0-2. */
function spawnClean(cmd, args = [], opts = {}) {
  return spawn('python3', ['-c', CLOSE_AND_EXEC, cmd, ...args], opts)
}

module.exports = { spawnClean, CLOSE_AND_EXEC }
