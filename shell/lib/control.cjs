// Local control socket for the TV connector (Claude's remote tools).
//
// A Unix socket in $XDG_RUNTIME_DIR/tvlauncher/ (a folder only the owner can
// open), one JSON request per line, one JSON reply per line. Nothing on the
// network can reach it; the connector runs as the same user and relays.
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

function socketPath() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`
  return path.join(runtime, 'tvlauncher', 'control.sock')
}

/** handler: async (request) => reply object */
function startControlServer(handler, log) {
  const file = socketPath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(file), 0o700)
  try {
    fs.unlinkSync(file)
  } catch {
    /* not there */
  }
  const server = net.createServer((conn) => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.setTimeout(30_000, () => conn.destroy())
    conn.on('data', async (chunk) => {
      buf += chunk
      if (buf.length > 1_000_000) return conn.destroy()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let reply
        try {
          reply = await handler(JSON.parse(line))
        } catch (e) {
          reply = { ok: false, error: String(e && e.message ? e.message : e) }
        }
        conn.write(JSON.stringify(reply) + '\n')
      }
    })
    conn.on('error', () => {})
  })
  server.on('error', (e) => log(`control socket error: ${e.message}`))
  server.listen(file, () => {
    fs.chmodSync(file, 0o600)
    log(`control socket ready at ${file}`)
  })
  return server
}

module.exports = { startControlServer, socketPath }
